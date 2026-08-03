use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env, fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::UNIX_EPOCH,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{ChildStdin, Command},
    sync::{oneshot, Mutex},
};

// Private persistence, policy, catalog, and transport-neutral event helpers for a future opt-in
// remote bridge. This module starts no listener; its local catalog-sync command cannot enable it.
#[allow(dead_code)]
mod remote;

use remote::{
    events::{EventHub, EventKind},
    projects::{KnownProjectInput, ProjectCatalog, RemoteProjectSummary, SessionSyncInput},
};

const MAX_RPC_RECORD_BYTES: usize = 8 * 1024 * 1024;
const MAX_SESSION_FILES: usize = 250;
const STDERR_CHUNK_BYTES: usize = 8 * 1024;
const SUBAGENT_TRANSCRIPT_TAIL_BYTES: u64 = 384 * 1024;
const SUBAGENT_TODO_TAIL_BYTES: u64 = 4 * 1024 * 1024;
const SUBAGENT_STATUS_EVENT_TAIL_BYTES: u64 = 2 * 1024 * 1024;
const SUBAGENT_PROMPT_SCAN_BYTES: u64 = 4 * 1024 * 1024;
const SUBAGENT_PROMPT_MAX_CHARS: usize = 256 * 1024;
const SUBAGENT_ACTIVITY_EVENTS: usize = 12;
const MAX_SETTINGS_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_AGENT_FILE_BYTES: u64 = 256 * 1024;

#[derive(Default)]
struct PiManager {
    registry: Mutex<PiRegistry>,
    events: EventHub,
}

#[derive(Default)]
struct PiRegistry {
    active_project: Option<PathBuf>,
    active_trusted: Option<bool>,
    processes: HashMap<PathBuf, ManagedPi>,
}

struct ManagedPi {
    stdin: Arc<Mutex<ChildStdin>>,
    stop: oneshot::Sender<()>,
    pid: u32,
    info: PiProcessInfo,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PiProcessInfo {
    executable: String,
    version: String,
    pid: Option<u32>,
    cwd: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PiProcessEvent {
    state: &'static str,
    pid: Option<u32>,
    code: Option<i32>,
    message: Option<String>,
    project: Option<String>,
}

struct RequiredPiPackage {
    source: &'static str,
    npm_name: &'static str,
    display_name: &'static str,
}

const REQUIRED_PI_PACKAGES: &[RequiredPiPackage] = &[
    RequiredPiPackage {
        source: "npm:pi-subagents",
        npm_name: "pi-subagents",
        display_name: "pi-subagents",
    },
    RequiredPiPackage {
        source: "npm:pi-web-access",
        npm_name: "pi-web-access",
        display_name: "pi-web-access",
    },
    RequiredPiPackage {
        source: "npm:@juicesharp/rpiv-ask-user-question",
        npm_name: "@juicesharp/rpiv-ask-user-question",
        display_name: "@juicesharp/rpiv-ask-user-question",
    },
    RequiredPiPackage {
        source: "npm:@juicesharp/rpiv-todo",
        npm_name: "@juicesharp/rpiv-todo",
        display_name: "@juicesharp/rpiv-todo",
    },
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PiSettingsSnapshot {
    scope: String,
    path: String,
    settings: Value,
    effective_settings: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PiPackageInfo {
    source: String,
    scope: String,
    location: Option<String>,
    installed: bool,
    required: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PiPackagesSnapshot {
    packages: Vec<PiPackageInfo>,
    core_ready: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PiSessionFinalReply {
    marker: String,
    timestamp: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PiSessionSummary {
    path: String,
    id: String,
    name: Option<String>,
    parent_session_path: Option<String>,
    #[serde(skip_serializing)]
    anonymous_subagent_bootstrap: bool,
    modified: u64,
    message_count: usize,
    first_message: String,
    last_final_reply: Option<PiSessionFinalReply>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubagentActivityTarget {
    key: String,
    run_id: String,
    agent: String,
    index: usize,
    transcript_path: Option<String>,
    session_file: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SubagentActivityEvent {
    kind: &'static str,
    text: String,
    at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SubagentTodoTask {
    id: u64,
    subject: String,
    description: Option<String>,
    active_form: Option<String>,
    status: String,
    blocked_by: Vec<u64>,
    owner: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SubagentLiveActivity {
    key: String,
    headline: Option<String>,
    headline_kind: Option<&'static str>,
    last_activity_at: Option<u64>,
    events: Vec<SubagentActivityEvent>,
    todos: Option<Vec<SubagentTodoTask>>,
    todos_updated_at: Option<u64>,
}

struct SubagentTodoSnapshot {
    tasks: Vec<SubagentTodoTask>,
    updated_at: Option<u64>,
}

fn pi_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(path) = env::var_os("LEMONPI_PI_PATH") {
        candidates.push(PathBuf::from(path));
    }

    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/pi"));
        candidates.push(PathBuf::from("/usr/local/bin/pi"));
    }

    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        candidates.push(home.join(".local/bin/pi"));
        candidates.push(home.join(".npm-global/bin/pi"));
    }

    #[cfg(windows)]
    if let Some(app_data) = env::var_os("APPDATA").map(PathBuf::from) {
        candidates.push(app_data.join("npm/pi.cmd"));
        candidates.push(app_data.join("npm/pi.exe"));
    }

    candidates
}

fn find_pi() -> Result<PathBuf, String> {
    if let Ok(path) = which::which("pi") {
        return Ok(path);
    }

    pi_candidates()
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "Pi was not found. Install @earendil-works/pi-coding-agent or set LEMONPI_PI_PATH to the Pi executable.".to_string()
        })
}

fn augmented_path(executable: &std::path::Path) -> Result<std::ffi::OsString, String> {
    let mut paths = Vec::new();
    if let Some(parent) = executable.parent() {
        paths.push(parent.to_path_buf());
    }

    #[cfg(target_os = "macos")]
    {
        paths.push(PathBuf::from("/opt/homebrew/bin"));
        paths.push(PathBuf::from("/usr/local/bin"));
    }

    #[cfg(windows)]
    {
        paths.push(PathBuf::from(r"C:\Program Files\nodejs"));
        if let Some(app_data) = env::var_os("APPDATA").map(PathBuf::from) {
            paths.push(app_data.join("npm"));
        }
    }

    if let Some(existing) = env::var_os("PATH") {
        paths.extend(env::split_paths(&existing));
    }
    paths.dedup();
    env::join_paths(paths)
        .map_err(|error| format!("Could not construct the Pi process PATH: {error}"))
}

fn pi_command(executable: &PathBuf) -> Result<Command, String> {
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let mut command = if executable
            .extension()
            .is_some_and(|extension| extension == "cmd")
        {
            let mut command = Command::new("cmd.exe");
            command.args(["/D", "/C"]).arg(executable);
            command
        } else {
            Command::new(executable)
        };
        command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
        command
    };

    #[cfg(not(windows))]
    let mut command = Command::new(executable);

    command.env("PATH", augmented_path(executable)?);
    Ok(command)
}

async fn run_pi_cli(executable: &PathBuf, cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = pi_command(executable)?
        .args(args)
        .current_dir(cwd)
        .env("PI_SKIP_VERSION_CHECK", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| format!("Could not run Pi: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

fn package_source(entry: &Value) -> Option<&str> {
    entry
        .as_str()
        .or_else(|| entry.as_object()?.get("source")?.as_str())
}

fn npm_package_name(source: &str) -> Option<&str> {
    let spec = source.strip_prefix("npm:")?;
    if spec.starts_with('@') {
        let slash = spec.find('/')?;
        let version = spec[slash + 1..].find('@').map(|index| slash + 1 + index);
        Some(version.map_or(spec, |index| &spec[..index]))
    } else {
        Some(spec.split('@').next().unwrap_or(spec))
    }
}

fn required_pi_package(source: &str) -> Option<&'static RequiredPiPackage> {
    let name = npm_package_name(source)?;
    REQUIRED_PI_PACKAGES
        .iter()
        .find(|package| package.npm_name == name)
}

fn required_pi_package_installed(agent_dir: &Path, package: &RequiredPiPackage) -> bool {
    agent_dir
        .join("npm/node_modules")
        .join(package.npm_name)
        .join("package.json")
        .is_file()
}

async fn ensure_required_pi_packages(executable: &PathBuf) -> Result<(), String> {
    let agent_dir = pi_agent_dir()?;
    let settings = read_settings_object(&agent_dir.join("settings.json"))?;
    let cwd = home_dir()?;
    let configured_sources = configured_package_sources(&settings);
    for package in REQUIRED_PI_PACKAGES {
        let configured = configured_sources.iter().any(|source| {
            required_pi_package(source)
                .is_some_and(|candidate| candidate.npm_name == package.npm_name)
        });
        if configured && required_pi_package_installed(&agent_dir, package) {
            continue;
        }

        run_pi_cli(
            executable,
            &cwd,
            &["install", package.source, "--no-approve"],
        )
        .await
        .map_err(|error| {
            format!(
                "LemonPi requires {} and could not install it automatically: {error}",
                package.display_name
            )
        })?;
        if !required_pi_package_installed(&agent_dir, package) {
            return Err(format!(
                "Pi reported a successful {} install, but the package is unavailable.",
                package.display_name
            ));
        }
    }
    Ok(())
}

async fn pi_version(executable: &PathBuf) -> Result<String, String> {
    let output = pi_command(executable)?
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| format!("Could not run {}: {error}", executable.display()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!(
                "{} --version exited with {}",
                executable.display(),
                output.status
            )
        } else {
            stderr
        });
    }

    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(version.strip_prefix('v').unwrap_or(&version).to_string())
}

#[tauri::command]
async fn detect_pi() -> Result<PiProcessInfo, String> {
    let executable = find_pi()?;
    let version = pi_version(&executable).await?;
    Ok(PiProcessInfo {
        executable: executable.to_string_lossy().into_owned(),
        version,
        pid: None,
        cwd: None,
    })
}

fn emit_protocol_error(app: &AppHandle, message: impl Into<String>) {
    let event = json!({
        "type": "lemonpi_protocol_error",
        "error": message.into(),
    });
    let _ = app.emit("pi-event", event);
}

fn parse_rpc_record(record: &[u8]) -> Result<Option<Value>, String> {
    let record = record.strip_suffix(b"\n").unwrap_or(record);
    let record = record.strip_suffix(b"\r").unwrap_or(record);

    if record.is_empty() {
        return Ok(None);
    }
    if record.len() > MAX_RPC_RECORD_BYTES {
        return Err(format!(
            "Pi emitted an RPC record larger than {} MiB",
            MAX_RPC_RECORD_BYTES / 1024 / 1024
        ));
    }

    let text = std::str::from_utf8(record)
        .map_err(|error| format!("Pi emitted invalid UTF-8: {error}"))?;
    let value = serde_json::from_str(text)
        .map_err(|error| format!("Pi emitted malformed JSON: {error}"))?;
    Ok(Some(value))
}

struct JsonlFramer {
    record: Vec<u8>,
    discarding_oversized: bool,
    max_bytes: usize,
}

impl JsonlFramer {
    fn new(max_bytes: usize) -> Self {
        Self {
            record: Vec::new(),
            discarding_oversized: false,
            max_bytes,
        }
    }

    fn push(&mut self, chunk: &[u8]) -> Vec<Result<Option<Value>, String>> {
        let mut output = Vec::new();
        for &byte in chunk {
            if self.discarding_oversized {
                if byte == b'\n' {
                    self.discarding_oversized = false;
                }
                continue;
            }

            if byte == b'\n' {
                output.push(parse_rpc_record(&self.record));
                self.record.clear();
                continue;
            }

            if self.record.len() == self.max_bytes {
                self.record.clear();
                self.discarding_oversized = true;
                output.push(Err(format!(
                    "Pi emitted an RPC record larger than {} MiB",
                    self.max_bytes / 1024 / 1024
                )));
                continue;
            }

            self.record.push(byte);
        }
        output
    }

    fn finish(&mut self) -> Option<Result<Option<Value>, String>> {
        if self.discarding_oversized || self.record.is_empty() {
            self.record.clear();
            return None;
        }
        let result = parse_rpc_record(&self.record);
        self.record.clear();
        Some(result)
    }
}

fn expand_home(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if text == "~" {
        return env::var_os("HOME")
            .or_else(|| env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or(path);
    }
    if let Some(rest) = text.strip_prefix("~/").or_else(|| text.strip_prefix("~\\")) {
        if let Some(home) = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")) {
            return PathBuf::from(home).join(rest);
        }
    }
    path
}

fn path_for_frontend(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!("\\\\{rest}");
    }
    if let Some(rest) = text.strip_prefix("//?/UNC/") {
        return format!("//{rest}");
    }
    text.strip_prefix(r"\\?\")
        .or_else(|| text.strip_prefix("//?/"))
        .unwrap_or(text.as_ref())
        .to_string()
}

fn session_directory(cwd: &Path) -> Result<PathBuf, String> {
    if let Some(directory) = env::var_os("PI_CODING_AGENT_SESSION_DIR") {
        return Ok(expand_home(PathBuf::from(directory)));
    }

    let agent_dir = if let Some(directory) = env::var_os("PI_CODING_AGENT_DIR") {
        expand_home(PathBuf::from(directory))
    } else {
        let home = env::var_os("HOME")
            .or_else(|| env::var_os("USERPROFILE"))
            .ok_or_else(|| "Could not locate Pi's session directory.".to_string())?;
        PathBuf::from(home).join(".pi/agent")
    };

    // Windows canonicalization adds a `\\?\` verbatim prefix. Node's
    // path.resolve(), which Pi uses to name its session directory, does not.
    // Keeping the prefix here also introduces an illegal `?` filename.
    let cwd_text = path_for_frontend(cwd);
    let path_text = cwd_text
        .strip_prefix('/')
        .or_else(|| cwd_text.strip_prefix('\\'))
        .unwrap_or(&cwd_text);
    let encoded: String = path_text
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' => '-',
            other => other,
        })
        .collect();
    Ok(agent_dir.join("sessions").join(format!("--{encoded}--")))
}

fn session_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

fn session_scalar_marker(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn final_reply_metadata(value: &Value, message_number: usize) -> PiSessionFinalReply {
    let message = value.get("message");
    // Pi currently writes an outer ISO timestamp and an inner numeric message
    // timestamp. Retain either representation verbatim so the receipt stays
    // stable even if Pi changes which representation it emits.
    let timestamp = session_scalar_marker(value.get("timestamp"))
        .or_else(|| session_scalar_marker(message.and_then(|message| message.get("timestamp"))));
    let id = session_scalar_marker(value.get("id"))
        .or_else(|| session_scalar_marker(message.and_then(|message| message.get("id"))));
    let marker = match (&timestamp, &id) {
        (Some(timestamp), Some(id)) => format!("timestamp:{timestamp}|id:{id}"),
        (Some(timestamp), None) => format!("timestamp:{timestamp}|message:{message_number}"),
        (None, Some(id)) => format!("id:{id}"),
        (None, None) => format!("message:{message_number}"),
    };
    PiSessionFinalReply { marker, timestamp }
}

fn compact_session_label(value: &str) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut characters = compact.chars();
    let shortened: String = characters.by_ref().take(160).collect();
    if characters.next().is_some() {
        format!("{shortened}…")
    } else {
        shortened
    }
}

fn session_cwd_matches(value: &str, expected: &Path) -> bool {
    PathBuf::from(value)
        .canonicalize()
        .map(|path| path == expected)
        .unwrap_or_else(|_| Path::new(value) == expected)
}

fn is_subagent_delegation_message(value: &Value) -> bool {
    if value.get("type").and_then(Value::as_str) != Some("message") {
        return false;
    }
    let Some(message) = value.get("message") else {
        return false;
    };
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return false;
    }
    message
        .get("content")
        .and_then(Value::as_array)
        .is_some_and(|parts| {
            parts.iter().any(|part| {
                if part.get("type").and_then(Value::as_str) != Some("toolCall")
                    || part.get("name").and_then(Value::as_str) != Some("subagent")
                {
                    return false;
                }
                let Some(arguments) = part.get("arguments").and_then(Value::as_object) else {
                    return false;
                };
                !arguments.contains_key("action")
                    && (arguments.get("agent").and_then(Value::as_str).is_some()
                        || arguments.get("tasks").and_then(Value::as_array).is_some()
                        || arguments.get("chain").and_then(Value::as_array).is_some()
                        || arguments.contains_key("parallel"))
            })
        })
}

fn read_session_summary(path: &Path, expected_cwd: &Path) -> Option<PiSessionSummary> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    let mut file = fs::File::open(path).ok()?;
    let mut chunk = vec![0; 64 * 1024];
    let mut framer = JsonlFramer::new(MAX_RPC_RECORD_BYTES);
    let mut header_seen = false;
    let mut valid = true;
    let mut id = None;
    let mut name = None;
    let mut parent_session_path = None;
    let mut message_count = 0usize;
    let mut first_message = String::new();
    let mut last_final_reply = None;
    let mut last_message_is_subagent_delegation = false;

    {
        let mut consume = |value: Value| {
            if !header_seen {
                header_seen = true;
                if value.get("type").and_then(Value::as_str) != Some("session") {
                    valid = false;
                    return;
                }
                id = value.get("id").and_then(Value::as_str).map(str::to_string);
                parent_session_path = value
                    .get("parentSession")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let matches = value
                    .get("cwd")
                    .and_then(Value::as_str)
                    .is_some_and(|cwd| session_cwd_matches(cwd, expected_cwd));
                if !matches {
                    valid = false;
                }
                return;
            }

            if !valid {
                return;
            }
            if value.get("type").and_then(Value::as_str) == Some("message") {
                last_message_is_subagent_delegation = is_subagent_delegation_message(&value);
            }
            match value.get("type").and_then(Value::as_str) {
                Some("session_info") => {
                    name = value
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(compact_session_label);
                }
                Some("message") => {
                    message_count += 1;
                    let message = value.get("message");
                    let role = message
                        .and_then(|message| message.get("role"))
                        .and_then(Value::as_str);
                    if role == Some("user") {
                        // A newer user turn supersedes an older final reply.
                        last_final_reply = None;
                        if first_message.is_empty() {
                            first_message = compact_session_label(&session_text(
                                message.and_then(|message| message.get("content")),
                            ));
                        }
                    } else if role == Some("assistant")
                        && message
                            .and_then(|message| message.get("stopReason"))
                            .and_then(Value::as_str)
                            == Some("stop")
                    {
                        // Tool-use and intermediate assistant records are not replies
                        // that can make a conversation unread.
                        last_final_reply = Some(final_reply_metadata(&value, message_count));
                    }
                }
                _ => {}
            }
        };

        loop {
            let count = file.read(&mut chunk).ok()?;
            if count == 0 {
                if let Some(Ok(Some(value))) = framer.finish() {
                    consume(value);
                }
                break;
            }
            for result in framer.push(&chunk[..count]) {
                if let Ok(Some(value)) = result {
                    consume(value);
                }
            }
        }
    }
    if !valid {
        return None;
    }
    let anonymous_subagent_bootstrap =
        parent_session_path.is_some() && name.is_none() && last_message_is_subagent_delegation;
    Some(PiSessionSummary {
        path: path.to_string_lossy().into_owned(),
        id: id?,
        name,
        parent_session_path,
        anonymous_subagent_bootstrap,
        modified,
        message_count,
        first_message: if first_message.is_empty() {
            "New session".to_string()
        } else {
            first_message
        },
        last_final_reply,
    })
}

fn list_pi_sessions_sync(cwd: &Path) -> Result<Vec<PiSessionSummary>, String> {
    let directory = session_directory(cwd)?;
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Could not read Pi sessions: {error}")),
    };
    let mut files = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "jsonl")
        })
        .filter_map(|path| {
            let modified = fs::metadata(&path).ok()?.modified().ok()?;
            Some((path, modified))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    files.truncate(MAX_SESSION_FILES);

    let mut sessions = files
        .into_iter()
        .filter_map(|(path, _)| read_session_summary(&path, cwd))
        .filter(|session| {
            !session.anonymous_subagent_bootstrap
                && !session
                    .name
                    .as_deref()
                    .is_some_and(|name| name.starts_with("subagent-"))
        })
        .collect::<Vec<_>>();
    sessions.sort_by_key(|session| std::cmp::Reverse(session.modified));
    Ok(sessions)
}

#[tauri::command]
async fn list_pi_sessions(cwd: String) -> Result<Vec<PiSessionSummary>, String> {
    let cwd = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|error| format!("Could not inspect project sessions: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || list_pi_sessions_sync(&cwd))
        .await
        .map_err(|error| format!("Could not inspect project sessions: {error}"))?
}

fn remote_storage_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("remote"))
        .map_err(|error| format!("Could not locate LemonPi's remote storage: {error}"))
}

/// Synchronizes the desktop UI's own recently known project records into the private remote
/// catalog. This command neither enables remote access nor starts a Pi process.
#[tauri::command]
async fn sync_known_projects(
    app: AppHandle,
    manager: State<'_, Arc<PiManager>>,
    projects: Vec<KnownProjectInput>,
) -> Result<Vec<RemoteProjectSummary>, String> {
    let active_project = {
        let registry = manager.registry.lock().await;
        registry.active_project.clone()
    };
    let storage = remote_storage_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut catalog =
            ProjectCatalog::load_or_create(storage).map_err(|error| error.to_string())?;
        let summaries = catalog
            .sync_projects(&projects, active_project.as_deref())
            .map_err(|error| error.to_string())?;
        for binding in catalog.project_bindings() {
            if !binding.trusted {
                catalog
                    .clear_sessions(&binding.id)
                    .map_err(|error| error.to_string())?;
                continue;
            }
            let Ok(session_directory) = session_directory(&binding.path) else {
                continue;
            };
            let Ok(sessions) = list_pi_sessions_sync(&binding.path) else {
                continue;
            };
            let inputs = sessions
                .into_iter()
                .map(|session| SessionSyncInput {
                    path: PathBuf::from(session.path),
                })
                .collect::<Vec<_>>();
            catalog
                .sync_sessions(&binding.id, &session_directory, &inputs)
                .map_err(|error| error.to_string())?;
        }
        Ok(summaries)
    })
    .await
    .map_err(|error| format!("Could not synchronize known projects: {error}"))?
}

fn forward_framed_result(
    result: Result<Option<Value>, String>,
    app: &AppHandle,
    pid: u32,
    project: &Path,
    events: &EventHub,
) {
    match result {
        Ok(Some(mut event)) => {
            if let Value::Object(fields) = &mut event {
                fields.insert("__piPid".to_string(), Value::from(pid));
            }
            events.publish(
                Some(project.to_path_buf()),
                EventKind::PiEvent,
                event.clone(),
            );
            let _ = app.emit("pi-event", event);
        }
        Ok(None) => {}
        Err(error) => emit_protocol_error(app, error),
    }
}

fn emit_process_event(app: &AppHandle, events: &EventHub, project: &Path, event: PiProcessEvent) {
    events.publish(
        Some(project.to_path_buf()),
        EventKind::ProcessEvent,
        json!({
            "state": event.state,
            "pid": event.pid,
            "code": event.code,
            "message": event.message.clone(),
        }),
    );
    let _ = app.emit("pi-process-event", event);
}

async fn forward_stdout<R>(
    mut reader: R,
    app: AppHandle,
    pid: u32,
    project: PathBuf,
    events: EventHub,
) where
    R: AsyncRead + Unpin,
{
    let mut chunk = vec![0; 16 * 1024];
    let mut framer = JsonlFramer::new(MAX_RPC_RECORD_BYTES);

    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => {
                if let Some(result) = framer.finish() {
                    forward_framed_result(result, &app, pid, &project, &events);
                }
                break;
            }
            Ok(count) => {
                for result in framer.push(&chunk[..count]) {
                    forward_framed_result(result, &app, pid, &project, &events);
                }
            }
            Err(error) => {
                emit_protocol_error(&app, format!("Failed to read Pi stdout: {error}"));
                break;
            }
        }
    }
}

async fn forward_stderr<R>(mut reader: R, app: AppHandle)
where
    R: AsyncRead + Unpin,
{
    let mut chunk = vec![0; STDERR_CHUNK_BYTES];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => break,
            Ok(count) => {
                let text = String::from_utf8_lossy(&chunk[..count]).into_owned();
                let _ = app.emit("pi-stderr", text);
            }
            Err(error) => {
                let _ = app.emit("pi-stderr", format!("Failed to read Pi stderr: {error}"));
                break;
            }
        }
    }
}

async fn stop_active(manager: &Arc<PiManager>) {
    let process = {
        let mut registry = manager.registry.lock().await;
        let active_project = registry.active_project.take();
        registry.active_trusted = None;
        active_project.and_then(|project| registry.processes.remove(&project))
    };
    if let Some(process) = process {
        let _ = process.stop.send(());
    }
}

fn project_trust_arg(trusted: bool) -> &'static str {
    if trusted {
        "--approve"
    } else {
        "--no-approve"
    }
}

fn narration_extension_path(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/lemonpi-narration/extensions/narration.ts");
        if source.is_file() {
            return Ok(source);
        }
    }

    let bundled = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Could not locate LemonPi resources: {error}"))?
        .join("lemonpi-narration/extensions/narration.ts");
    if bundled.is_file() {
        Ok(bundled)
    } else {
        Err("LemonPi's narration package is missing from the application resources.".to_string())
    }
}

#[tauri::command]
async fn start_pi(
    app: AppHandle,
    manager: State<'_, Arc<PiManager>>,
    cwd: String,
    trusted: bool,
) -> Result<PiProcessInfo, String> {
    let cwd_path = PathBuf::from(&cwd)
        .canonicalize()
        .map_err(|error| format!("Could not open project folder: {error}"))?;
    if !cwd_path.is_dir() {
        return Err("The selected project path is not a directory.".to_string());
    }

    {
        let mut registry = manager.registry.lock().await;
        if let Some(info) = registry
            .processes
            .get(&cwd_path)
            .map(|process| process.info.clone())
        {
            registry.active_project = Some(cwd_path.clone());
            return Ok(info);
        }
    }

    let executable = find_pi()?;
    let version = pi_version(&executable).await?;
    let narration_extension = narration_extension_path(&app)?;
    let child_todo_bridge = narration_extension.with_file_name("child-todo-bridge.ts");
    ensure_required_pi_packages(&executable).await?;
    let agent_dir = pi_agent_dir()?;
    ensure_auto_compaction_default(&agent_dir)?;
    ensure_subagent_todo_access(&agent_dir, &cwd_path, trusted, &child_todo_bridge)?;
    let mut command = pi_command(&executable)?;
    command
        .args(["--mode", "rpc", project_trust_arg(trusted)])
        .arg("--extension")
        .arg(narration_extension)
        .current_dir(&cwd_path)
        .env("PI_SKIP_VERSION_CHECK", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start Pi: {error}"))?;
    let pid = child
        .id()
        .ok_or_else(|| "Pi started without a process id.".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Pi stdin was unavailable.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Pi stdout was unavailable.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Pi stderr was unavailable.".to_string())?;
    let (stop_tx, stop_rx) = oneshot::channel();
    let stdin = Arc::new(Mutex::new(stdin));
    let info = PiProcessInfo {
        executable: executable.to_string_lossy().into_owned(),
        version,
        pid: Some(pid),
        cwd: Some(path_for_frontend(&cwd_path)),
    };

    {
        let mut registry = manager.registry.lock().await;
        registry.active_project = Some(cwd_path.clone());
        registry.active_trusted = Some(trusted);
        registry.processes.insert(
            cwd_path.clone(),
            ManagedPi {
                stdin: Arc::clone(&stdin),
                stop: stop_tx,
                pid,
                info: info.clone(),
            },
        );
    }

    emit_process_event(
        &app,
        &manager.events,
        &cwd_path,
        PiProcessEvent {
            state: "started",
            pid: Some(pid),
            code: None,
            message: None,
            project: Some(path_for_frontend(&cwd_path)),
        },
    );

    let events_for_stdout = manager.events.clone();
    let project_for_stdout = cwd_path.clone();
    tauri::async_runtime::spawn(forward_stdout(
        stdout,
        app.clone(),
        pid,
        project_for_stdout,
        events_for_stdout,
    ));
    tauri::async_runtime::spawn(forward_stderr(stderr, app.clone()));

    let manager_for_wait = Arc::clone(manager.inner());
    let app_for_wait = app.clone();
    let project_for_wait = cwd_path.clone();
    let events_for_wait = manager.events.clone();
    tauri::async_runtime::spawn(async move {
        let (state, status) = tokio::select! {
            status = child.wait() => ("exited", status),
            _ = stop_rx => {
                let _ = child.kill().await;
                ("stopped", child.wait().await)
            }
        };

        let (code, message) = match status {
            Ok(status) => (status.code(), None),
            Err(error) => (None, Some(format!("Failed while waiting for Pi: {error}"))),
        };

        let mut registry = manager_for_wait.registry.lock().await;
        if registry
            .processes
            .get(&project_for_wait)
            .is_some_and(|process| process.pid == pid)
        {
            registry.processes.remove(&project_for_wait);
            if registry.active_project.as_ref() == Some(&project_for_wait) {
                registry.active_project = None;
            }
        }
        drop(registry);

        emit_process_event(
            &app_for_wait,
            &events_for_wait,
            &project_for_wait,
            PiProcessEvent {
                state,
                pid: Some(pid),
                code,
                message,
                project: Some(path_for_frontend(&project_for_wait)),
            },
        );
    });

    Ok(info)
}

fn encode_validated_pi_command(command: &Value) -> Result<Vec<u8>, String> {
    if !command.is_object() || command.get("type").and_then(Value::as_str).is_none() {
        return Err("RPC commands must be JSON objects with a string type.".to_string());
    }

    let mut payload = serde_json::to_vec(command)
        .map_err(|error| format!("Could not encode RPC command: {error}"))?;
    if payload.len() > MAX_RPC_RECORD_BYTES {
        return Err("RPC command is too large.".to_string());
    }
    payload.push(b'\n');
    Ok(payload)
}

/// Sends a validated command to one already-running canonical project. This helper never starts a
/// Pi process or changes its trust state; callers must select a project that `start_pi` has already
/// registered.
async fn send_validated_pi_command_to_project(
    manager: &PiManager,
    project: &Path,
    command: &Value,
) -> Result<(), String> {
    let payload = encode_validated_pi_command(command)?;
    let stdin = {
        let registry = manager.registry.lock().await;
        registry
            .processes
            .get(project)
            .map(|process| Arc::clone(&process.stdin))
            .ok_or_else(|| "Pi is not running.".to_string())?
    };

    let mut stdin = stdin.lock().await;
    stdin
        .write_all(&payload)
        .await
        .map_err(|error| format!("Could not write to Pi: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("Could not flush Pi stdin: {error}"))
}

fn select_pi_command_project(
    requested_project: Option<String>,
    active_project: Option<PathBuf>,
) -> Result<PathBuf, String> {
    match requested_project {
        Some(project) => PathBuf::from(project)
            .canonicalize()
            .map_err(|error| format!("Could not open project folder: {error}")),
        None => active_project.ok_or_else(|| "Pi is not running.".to_string()),
    }
}

#[tauri::command]
async fn send_pi(
    manager: State<'_, Arc<PiManager>>,
    command: Value,
    project: Option<String>,
) -> Result<(), String> {
    let active_project = {
        let registry = manager.registry.lock().await;
        registry.active_project.clone()
    };
    let project = select_pi_command_project(project, active_project)?;

    send_validated_pi_command_to_project(manager.inner(), &project, &command).await
}

fn safe_subagent_name(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '_' | '.' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn is_allowed_subagent_transcript(path: &Path, project: &Path) -> bool {
    if !path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with("_transcript.jsonl"))
    {
        return false;
    }
    let Ok(path) = path.canonicalize() else {
        return false;
    };
    let project_artifacts = project.join(".pi-subagents");
    if project_artifacts
        .canonicalize()
        .is_ok_and(|root| path.starts_with(root))
    {
        return true;
    }
    let temp = env::temp_dir();
    if let Ok(relative) = path.strip_prefix(&temp) {
        if relative
            .components()
            .next()
            .and_then(|component| component.as_os_str().to_str())
            .is_some_and(|name| name.starts_with("pi-subagents-"))
        {
            return true;
        }
    }
    env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".pi/agent"))
        .and_then(|root| root.canonicalize().ok())
        .is_some_and(|root| path.starts_with(root))
}

fn resolve_subagent_transcript(project: &Path, target: &SubagentActivityTarget) -> Option<PathBuf> {
    if let Some(path) = target.transcript_path.as_deref().map(PathBuf::from) {
        let path = if path.is_absolute() {
            path
        } else {
            project.join(path)
        };
        if is_allowed_subagent_transcript(&path, project) {
            return Some(path);
        }
    }
    let filename = format!(
        "{}_{}_{}_transcript.jsonl",
        target.run_id,
        safe_subagent_name(&target.agent),
        target.index,
    );
    let path = project.join(".pi-subagents/artifacts").join(filename);
    is_allowed_subagent_transcript(&path, project).then_some(path)
}

fn resolve_subagent_session(target: &SubagentActivityTarget) -> Option<PathBuf> {
    let path = PathBuf::from(target.session_file.as_deref()?);
    if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
        return None;
    }
    let path = path.canonicalize().ok()?;
    let sessions_root = pi_agent_dir().ok()?.join("sessions").canonicalize().ok()?;
    path.starts_with(sessions_root).then_some(path)
}

fn compact_activity_text(value: &str) -> Option<String> {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        return None;
    }
    let mut characters = compact.chars();
    let shortened = characters.by_ref().take(720).collect::<String>();
    Some(if characters.next().is_some() {
        format!("{shortened}…")
    } else {
        shortened
    })
}

fn push_subagent_activity(
    events: &mut Vec<SubagentActivityEvent>,
    kind: &'static str,
    text: impl AsRef<str>,
    at: u64,
) {
    let Some(text) = compact_activity_text(text.as_ref()) else {
        return;
    };
    if events
        .last()
        .is_some_and(|event| event.kind == kind && event.text == text)
    {
        return;
    }
    events.push(SubagentActivityEvent { kind, text, at });
}

fn subagent_todos_from_record(record: &Value) -> Option<Vec<SubagentTodoTask>> {
    let seeded = record.get("type").and_then(Value::as_str) == Some("custom")
        && record.get("customType").and_then(Value::as_str) == Some("lemonpi-child-todos");
    let message = record.get("message");
    let role = record
        .get("role")
        .and_then(Value::as_str)
        .or_else(|| message?.get("role").and_then(Value::as_str));
    let tool_name = record
        .get("toolName")
        .and_then(Value::as_str)
        .or_else(|| message?.get("toolName").and_then(Value::as_str));
    let details = if seeded {
        record.get("data")
    } else {
        message
            .and_then(|value| value.get("details"))
            .or_else(|| record.get("details"))
            .or_else(|| record.get("result").and_then(|value| value.get("details")))
    };
    if !seeded
        && (!matches!(tool_name, Some("child_todo" | "todo"))
            || (role != Some("toolResult") && details.is_none()))
    {
        return None;
    }
    let tasks = details?.get("tasks")?.as_array()?;
    tasks
        .iter()
        .map(|task| {
            let status = task.get("status")?.as_str()?;
            if !matches!(status, "pending" | "in_progress" | "completed" | "deleted") {
                return None;
            }
            Some(SubagentTodoTask {
                id: task.get("id")?.as_u64()?,
                subject: task.get("subject")?.as_str()?.to_string(),
                description: task
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                active_form: task
                    .get("activeForm")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                status: status.to_string(),
                blocked_by: task
                    .get("blockedBy")
                    .and_then(Value::as_array)
                    .map(|ids| ids.iter().filter_map(Value::as_u64).collect())
                    .unwrap_or_default(),
                owner: task
                    .get("owner")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect()
}

fn subagent_todo_updated_at(record: &Value) -> Option<u64> {
    record
        .get("ts")
        .and_then(Value::as_u64)
        .or_else(|| record.get("timestamp").and_then(Value::as_u64))
        .or_else(|| record.pointer("/message/timestamp").and_then(Value::as_u64))
        .or_else(|| record.pointer("/data/seededAt").and_then(Value::as_u64))
}

fn read_subagent_todos(path: &Path, agent: &str) -> Option<SubagentTodoSnapshot> {
    let mut file = fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let offset = length.saturating_sub(SUBAGENT_TODO_TAIL_BYTES);
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut contents = String::new();
    file.read_to_string(&mut contents).ok()?;
    let contents = if offset > 0 {
        contents
            .split_once('\n')
            .map(|(_, rest)| rest)
            .unwrap_or("")
    } else {
        contents.as_str()
    };
    let mut latest = None;
    for line in contents.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(tasks) = subagent_todos_from_record(&record) {
            latest = Some(SubagentTodoSnapshot {
                tasks: tasks
                    .into_iter()
                    .filter(|task| task.owner.as_deref() == Some(agent))
                    .collect(),
                updated_at: subagent_todo_updated_at(&record),
            });
        }
    }
    latest
}

fn read_subagent_activity(path: &Path, key: String) -> SubagentLiveActivity {
    let mut events = Vec::new();
    let mut todos = None;
    let mut todos_updated_at = None;
    let read_result = (|| -> Result<(), String> {
        let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
        let length = file.metadata().map_err(|error| error.to_string())?.len();
        let offset = length.saturating_sub(SUBAGENT_TRANSCRIPT_TAIL_BYTES);
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| error.to_string())?;
        let mut contents = String::new();
        file.read_to_string(&mut contents)
            .map_err(|error| error.to_string())?;
        let contents = if offset > 0 {
            contents
                .split_once('\n')
                .map(|(_, rest)| rest)
                .unwrap_or("")
        } else {
            contents.as_str()
        };

        for line in contents.lines() {
            let Ok(record) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if let Some(snapshot) = subagent_todos_from_record(&record) {
                todos = Some(snapshot);
                todos_updated_at = subagent_todo_updated_at(&record);
            }
            let at = record.get("ts").and_then(Value::as_u64).unwrap_or_default();
            match record.get("recordType").and_then(Value::as_str) {
                Some("tool_start") => {
                    let tool = record
                        .get("toolName")
                        .and_then(Value::as_str)
                        .unwrap_or("tool");
                    let tool = if tool == "child_todo" { "todo" } else { tool };
                    let args = record
                        .get("argsPreview")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let text = if args.trim().is_empty() {
                        tool.to_string()
                    } else {
                        format!("{tool} · {args}")
                    };
                    push_subagent_activity(&mut events, "tool", text, at);
                }
                Some("tool_end") => {
                    let tool = record
                        .get("toolName")
                        .and_then(Value::as_str)
                        .unwrap_or("tool");
                    let tool = if tool == "child_todo" { "todo" } else { tool };
                    let failed = record.get("isError").and_then(Value::as_bool) == Some(true);
                    push_subagent_activity(
                        &mut events,
                        if failed { "error" } else { "result" },
                        if failed {
                            format!("{tool} failed")
                        } else {
                            format!("Finished {tool}")
                        },
                        at,
                    );
                }
                Some("message") => {
                    let role = record.get("role").and_then(Value::as_str);
                    if role == Some("assistant") {
                        let content = record
                            .get("message")
                            .and_then(|message| message.get("content"))
                            .and_then(Value::as_array);
                        let mut found = false;
                        for part in content.into_iter().flatten() {
                            match part.get("type").and_then(Value::as_str) {
                                Some("thinking") => {
                                    if let Some(thinking) =
                                        part.get("thinking").and_then(Value::as_str)
                                    {
                                        push_subagent_activity(
                                            &mut events,
                                            "reasoning",
                                            thinking,
                                            at,
                                        );
                                        found = true;
                                    }
                                }
                                Some("text") => {
                                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                                        push_subagent_activity(&mut events, "message", text, at);
                                        found = true;
                                    }
                                }
                                _ => {}
                            }
                        }
                        if !found {
                            if let Some(text) = record.get("text").and_then(Value::as_str) {
                                push_subagent_activity(&mut events, "message", text, at);
                            }
                        }
                    } else if role == Some("toolResult")
                        && record.get("isError").and_then(Value::as_bool) == Some(true)
                    {
                        if let Some(text) = record.get("text").and_then(Value::as_str) {
                            push_subagent_activity(&mut events, "error", text, at);
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(())
    })();

    if read_result.is_err() {
        events.clear();
    }
    if events.len() > SUBAGENT_ACTIVITY_EVENTS {
        events.drain(0..events.len() - SUBAGENT_ACTIVITY_EVENTS);
    }
    let headline = events.last().map(|event| event.text.clone());
    let headline_kind = events.last().map(|event| event.kind);
    let last_activity_at = events.last().map(|event| event.at);
    SubagentLiveActivity {
        key,
        headline,
        headline_kind,
        last_activity_at,
        events,
        todos,
        todos_updated_at,
    }
}

#[derive(Clone, Copy, Default)]
struct SubagentAttentionEpisode {
    attention_at: u64,
    recovered_at: Option<u64>,
}

fn subagent_event_step(record: &Value) -> Option<usize> {
    record
        .get("subagentStepIndex")
        .and_then(Value::as_u64)
        .or_else(|| record.pointer("/event/index").and_then(Value::as_u64))
        .map(|index| index as usize)
}

fn subagent_event_at(record: &Value) -> Option<u64> {
    record
        .get("observedAt")
        .and_then(Value::as_u64)
        .or_else(|| record.get("ts").and_then(Value::as_u64))
        .or_else(|| record.pointer("/event/ts").and_then(Value::as_u64))
}

fn is_subagent_recovery_event(record: &Value) -> bool {
    match record.get("type").and_then(Value::as_str) {
        Some("message_end") => {
            record.pointer("/message/role").and_then(Value::as_str) == Some("assistant")
        }
        Some("tool_execution_start") => !matches!(
            record.get("toolName").and_then(Value::as_str),
            Some("contact_supervisor" | "subagent_supervisor" | "intercom")
        ),
        _ => false,
    }
}

fn subagent_attention_episodes(contents: &str) -> HashMap<usize, SubagentAttentionEpisode> {
    let mut episodes = HashMap::new();
    for line in contents.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(index) = subagent_event_step(&record) else {
            continue;
        };
        let Some(at) = subagent_event_at(&record) else {
            continue;
        };
        let needs_attention = record.get("type").and_then(Value::as_str)
            == Some("subagent.control")
            && record.pointer("/event/to").and_then(Value::as_str) == Some("needs_attention");
        if needs_attention {
            episodes.insert(
                index,
                SubagentAttentionEpisode {
                    attention_at: at,
                    recovered_at: None,
                },
            );
        } else if is_subagent_recovery_event(&record) {
            if let Some(episode) = episodes.get_mut(&index) {
                if at > episode.attention_at {
                    episode.recovered_at = Some(at);
                }
            }
        }
    }
    episodes
}

fn read_subagent_attention_episodes(path: &Path) -> HashMap<usize, SubagentAttentionEpisode> {
    let Ok(mut file) = fs::File::open(path) else {
        return HashMap::new();
    };
    let Ok(length) = file.metadata().map(|metadata| metadata.len()) else {
        return HashMap::new();
    };
    let offset = length.saturating_sub(SUBAGENT_STATUS_EVENT_TAIL_BYTES);
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return HashMap::new();
    }
    let mut contents = String::new();
    if file.read_to_string(&mut contents).is_err() {
        return HashMap::new();
    }
    let contents = if offset > 0 {
        contents
            .split_once('\n')
            .map(|(_, rest)| rest)
            .unwrap_or("")
    } else {
        contents.as_str()
    };
    subagent_attention_episodes(contents)
}

fn tool_shows_subagent_recovery(tool: Option<&str>) -> bool {
    tool.is_some_and(|tool| {
        !matches!(
            tool,
            "contact_supervisor" | "subagent_supervisor" | "intercom"
        )
    })
}

fn reconcile_subagent_attention(status: &mut Value, status_path: &Path) {
    if !matches!(
        status.get("state").and_then(Value::as_str),
        Some("running" | "queued")
    ) {
        return;
    }
    let run_flagged =
        status.get("activityState").and_then(Value::as_str) == Some("needs_attention");
    let step_flagged = status
        .get("steps")
        .and_then(Value::as_array)
        .is_some_and(|steps| {
            steps.iter().any(|step| {
                step.get("activityState").and_then(Value::as_str) == Some("needs_attention")
            })
        });
    if !run_flagged && !step_flagged {
        return;
    }

    let episodes = status_path
        .parent()
        .map(|directory| read_subagent_attention_episodes(&directory.join("events.jsonl")))
        .unwrap_or_default();
    let mut any_recovered = false;
    let mut unresolved_step = false;
    if let Some(steps) = status.get_mut("steps").and_then(Value::as_array_mut) {
        for (position, step) in steps.iter_mut().enumerate() {
            if step.get("activityState").and_then(Value::as_str) != Some("needs_attention") {
                continue;
            }
            let index = step
                .get("index")
                .and_then(Value::as_u64)
                .map(|index| index as usize)
                .unwrap_or(position);
            let recovered = episodes
                .get(&index)
                .is_some_and(|episode| episode.recovered_at.is_some())
                || tool_shows_subagent_recovery(step.get("currentTool").and_then(Value::as_str));
            if recovered {
                if let Some(fields) = step.as_object_mut() {
                    fields.remove("activityState");
                }
                any_recovered = true;
            } else {
                unresolved_step = true;
            }
        }
    }

    if run_flagged {
        let run_tool_recovered =
            tool_shows_subagent_recovery(status.get("currentTool").and_then(Value::as_str));
        let episode_recovered = episodes
            .values()
            .any(|episode| episode.recovered_at.is_some());
        if !unresolved_step && (any_recovered || episode_recovered || run_tool_recovered) {
            if let Some(fields) = status.as_object_mut() {
                fields.remove("activityState");
            }
        }
    }
}

#[tauri::command]
async fn get_subagent_activity(
    project: String,
    targets: Vec<SubagentActivityTarget>,
) -> Result<Vec<SubagentLiveActivity>, String> {
    let project = PathBuf::from(project)
        .canonicalize()
        .map_err(|error| format!("Could not inspect subagent transcripts: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        targets
            .into_iter()
            .map(|target| {
                let key = target.key.clone();
                let mut activity = resolve_subagent_transcript(&project, &target)
                    .map(|path| read_subagent_activity(&path, key.clone()))
                    .unwrap_or(SubagentLiveActivity {
                        key,
                        headline: None,
                        headline_kind: None,
                        last_activity_at: None,
                        events: Vec::new(),
                        todos: None,
                        todos_updated_at: None,
                    });
                if let Some(snapshot) = resolve_subagent_session(&target)
                    .and_then(|path| read_subagent_todos(&path, &target.agent))
                {
                    activity.todos = Some(snapshot.tasks);
                    activity.todos_updated_at = snapshot.updated_at;
                }
                activity
            })
            .collect()
    })
    .await
    .map_err(|error| format!("Could not inspect subagent transcripts: {error}"))
}

#[derive(Clone)]
struct DiscoveredAgent {
    name: String,
    description: String,
    source: &'static str,
    definition_path: Option<PathBuf>,
    base_model: Option<String>,
    base_thinking: Option<String>,
    base_tools: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SubagentSettingInfo {
    name: String,
    description: String,
    source: &'static str,
    effective_model: Option<String>,
    effective_thinking: Option<String>,
    model_override: Option<String>,
    thinking_override: Option<String>,
    model_source: String,
    thinking_source: String,
    model_locked: bool,
    thinking_locked: bool,
    shadowed_by_project: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SubagentSettingsSnapshot {
    agents: Vec<SubagentSettingInfo>,
    scope: String,
    user_settings_path: String,
    project_settings_path: Option<String>,
}

fn pi_agent_dir() -> Result<PathBuf, String> {
    if let Some(configured) = env::var_os("PI_CODING_AGENT_DIR") {
        let configured = configured.to_string_lossy();
        if configured == "~" {
            return home_dir();
        }
        if let Some(relative) = configured.strip_prefix("~/") {
            return Ok(home_dir()?.join(relative));
        }
        return Ok(PathBuf::from(configured.as_ref()));
    }
    Ok(home_dir()?.join(".pi/agent"))
}

fn home_dir() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "Could not locate the user home directory.".to_string())
}

fn project_settings_path(project: &Path) -> PathBuf {
    let home = home_dir().ok();
    let mut current = Some(project);
    while let Some(directory) = current {
        if home.as_deref() == Some(directory) {
            break;
        }
        if directory.join(".pi").is_dir() || directory.join(".agents").is_dir() {
            return directory.join(".pi/settings.json");
        }
        current = directory.parent();
    }
    project.join(".pi/settings.json")
}

fn read_settings_object(path: &Path) -> Result<serde_json::Map<String, Value>, String> {
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
    if metadata.len() > MAX_SETTINGS_FILE_BYTES {
        return Err(format!(
            "Settings file {} is larger than 2 MiB.",
            path.display()
        ));
    }
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    match serde_json::from_str::<Value>(&contents)
        .map_err(|error| format!("Could not parse {}: {error}", path.display()))?
    {
        Value::Object(settings) => Ok(settings),
        _ => Err(format!(
            "Settings file {} must contain a JSON object.",
            path.display()
        )),
    }
}

fn ensure_auto_compaction_default(agent_dir: &Path) -> Result<(), String> {
    let settings_path = agent_dir.join("settings.json");
    let mut settings = read_settings_object(&settings_path)?;
    let mut changed = false;

    match settings.get_mut("compaction") {
        Some(Value::Object(compaction)) => {
            if !compaction.contains_key("enabled") {
                compaction.insert("enabled".to_string(), Value::Bool(true));
                changed = true;
            }
        }
        None => {
            settings.insert("compaction".to_string(), json!({ "enabled": true }));
            changed = true;
        }
        Some(_) => {
            // Preserve an explicitly authored value even if a newer Pi version
            // rejects it; LemonPi must not silently rewrite user configuration.
        }
    }

    if changed {
        write_settings_object(&settings_path, &settings)?;
    }
    Ok(())
}

fn subagents_object(
    settings: &serde_json::Map<String, Value>,
) -> Option<&serde_json::Map<String, Value>> {
    settings.get("subagents").and_then(Value::as_object)
}

fn setting_string(settings: &serde_json::Map<String, Value>, field: &str) -> Option<String> {
    subagents_object(settings)
        .and_then(|subagents| subagents.get(field))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn agent_override_string(
    settings: &serde_json::Map<String, Value>,
    agent: &str,
    field: &str,
) -> Option<String> {
    subagents_object(settings)
        .and_then(|subagents| subagents.get("agentOverrides"))
        .and_then(Value::as_object)
        .and_then(|overrides| overrides.get(agent))
        .and_then(Value::as_object)
        .and_then(|entry| entry.get(field))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn clean_frontmatter_value(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        value[1..value.len() - 1].to_string()
    } else {
        value.to_string()
    }
}

fn read_agent_definition(path: &Path, source: &'static str) -> Option<DiscoveredAgent> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > MAX_AGENT_FILE_BYTES {
        return None;
    }
    let contents = fs::read_to_string(path).ok()?;
    let mut lines = contents.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let mut name = None;
    let mut description = None;
    let mut model = None;
    let mut thinking = None;
    let mut tools = None;
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = clean_frontmatter_value(value);
        match key.trim() {
            "name" if !value.is_empty() => name = Some(value),
            "description" if !value.is_empty() => description = Some(value),
            "model" if !value.is_empty() => model = Some(value),
            "thinking" if !value.is_empty() && value != "false" => thinking = Some(value),
            "tools" => {
                let value = value.trim_matches(|character| character == '[' || character == ']');
                tools = Some(
                    value
                        .split(',')
                        .map(clean_frontmatter_value)
                        .filter(|tool| !tool.is_empty())
                        .collect(),
                );
            }
            _ => {}
        }
    }
    let name = name?;
    Some(DiscoveredAgent {
        description: description.unwrap_or_else(|| format!("{name} subagent")),
        name,
        source,
        definition_path: Some(path.to_path_buf()),
        base_model: model,
        base_thinking: thinking,
        base_tools: tools,
    })
}

fn setting_string_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect(),
        Some(Value::String(value)) => value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn ensure_agent_todo_overrides(
    settings_path: &Path,
    agents: &HashMap<String, DiscoveredAgent>,
    todo_extension_path: &str,
    child_todo_bridge_path: &str,
) -> Result<(), String> {
    if agents.is_empty() {
        return Ok(());
    }
    let mut settings = read_settings_object(settings_path)?;
    let subagents = settings
        .entry("subagents".to_string())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "Settings field 'subagents' must be an object.".to_string())?;
    let overrides = subagents
        .entry("agentOverrides".to_string())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| {
            "Settings field 'subagents.agentOverrides' must be an object.".to_string()
        })?;
    let mut changed = false;

    for agent in agents.values() {
        let entry = overrides
            .entry(agent.name.clone())
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| format!("Override for '{}' must be an object.", agent.name))?;

        if entry.contains_key("tools") || agent.base_tools.is_some() {
            let mut tools = if entry.contains_key("tools") {
                setting_string_list(entry.get("tools"))
            } else {
                agent.base_tools.clone().unwrap_or_default()
            };
            // Delegated sessions use the owner-scoped bridge. Leaving the
            // ambient Main Pi tool active would expose a second empty store.
            tools.retain(|tool| tool != "todo");
            if !tools.iter().any(|tool| tool == "child_todo") {
                tools.push("child_todo".to_string());
            }
            let next_tools = Value::Array(tools.into_iter().map(Value::String).collect());
            if entry.get("tools") != Some(&next_tools) {
                entry.insert("tools".to_string(), next_tools);
                changed = true;
            }
        }

        let mut extensions = setting_string_list(entry.get("subagentOnlyExtensions"));
        // Older LemonPi builds loaded rpiv-todo and the bridge as independent
        // extensions. Pi isolates those module graphs, so the bridge could not
        // seed the provider's Map. The bridge now owns provider registration.
        extensions.retain(|extension| extension != todo_extension_path);
        if !extensions
            .iter()
            .any(|extension| extension == child_todo_bridge_path)
        {
            extensions.push(child_todo_bridge_path.to_string());
        }
        let next_extensions = Value::Array(extensions.into_iter().map(Value::String).collect());
        if entry.get("subagentOnlyExtensions") != Some(&next_extensions) {
            entry.insert("subagentOnlyExtensions".to_string(), next_extensions);
            changed = true;
        }
    }

    if changed {
        write_settings_object(settings_path, &settings)?;
    }
    Ok(())
}

fn ensure_subagent_todo_access(
    agent_dir: &Path,
    project: &Path,
    trusted: bool,
    child_todo_bridge: &Path,
) -> Result<(), String> {
    let todo_extension = agent_dir.join("npm/node_modules/@juicesharp/rpiv-todo/index.ts");
    if !todo_extension.is_file() {
        return Err(
            "LemonPi installed rpiv-todo, but its child extension entry point is unavailable."
                .to_string(),
        );
    }
    if !child_todo_bridge.is_file() {
        return Err("LemonPi's child todo bridge is unavailable.".to_string());
    }

    let user_settings_path = agent_dir.join("settings.json");
    let mut user_agents = HashMap::new();
    collect_agent_definitions(
        &agent_dir.join("npm/node_modules/pi-subagents/agents"),
        "builtin",
        &mut user_agents,
    );
    collect_agent_definitions(&agent_dir.join("agents"), "user", &mut user_agents);
    let todo_extension_path = path_for_frontend(&todo_extension);
    let child_todo_bridge_path = path_for_frontend(child_todo_bridge);
    ensure_agent_todo_overrides(
        &user_settings_path,
        &user_agents,
        &todo_extension_path,
        &child_todo_bridge_path,
    )?;

    if trusted {
        let project_settings = project_settings_path(project);
        let mut project_agents = HashMap::new();
        collect_agent_definitions(&project.join(".agents"), "project", &mut project_agents);
        collect_agent_definitions(&project.join(".pi/agents"), "project", &mut project_agents);
        ensure_agent_todo_overrides(
            &project_settings,
            &project_agents,
            &todo_extension_path,
            &child_todo_bridge_path,
        )?;
    }
    Ok(())
}

fn collect_agent_definitions(
    directory: &Path,
    source: &'static str,
    agents: &mut HashMap<String, DiscoveredAgent>,
) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten().take(256) {
        let path = entry.path();
        if path.extension().is_some_and(|extension| extension == "md") {
            if let Some(agent) = read_agent_definition(&path, source) {
                agents.insert(agent.name.clone(), agent);
            }
        }
    }
}

fn discover_settings_agents(
    agent_dir: &Path,
    project: Option<&Path>,
) -> HashMap<String, DiscoveredAgent> {
    let mut agents = HashMap::new();
    collect_agent_definitions(
        &agent_dir.join("npm/node_modules/pi-subagents/agents"),
        "builtin",
        &mut agents,
    );
    collect_agent_definitions(&agent_dir.join("agents"), "user", &mut agents);
    if env::var_os("PI_CODING_AGENT_DIR").is_none() {
        if let Ok(home) = home_dir() {
            collect_agent_definitions(&home.join(".agents"), "user", &mut agents);
        }
    }
    if let Some(project) = project {
        collect_agent_definitions(&project.join(".pi/agents"), "project", &mut agents);
        collect_agent_definitions(&project.join(".agents"), "project", &mut agents);
    }
    agents
}

fn validate_settings_scope(scope: &str, project: Option<&Path>) -> Result<(), String> {
    match scope {
        "user" => Ok(()),
        "project" if project.is_some() => Ok(()),
        "project" => {
            Err("Open a project before editing project-scoped agent settings.".to_string())
        }
        _ => Err("Settings scope must be 'user' or 'project'.".to_string()),
    }
}

fn build_subagent_settings_snapshot(
    project: Option<PathBuf>,
    scope: String,
) -> Result<SubagentSettingsSnapshot, String> {
    validate_settings_scope(&scope, project.as_deref())?;
    let agent_dir = pi_agent_dir()?;
    let user_path = agent_dir.join("settings.json");
    let project_path = project.as_deref().map(project_settings_path);
    let user_settings = read_settings_object(&user_path)?;
    let project_settings = match project_path.as_deref() {
        Some(path) => read_settings_object(path)?,
        None => serde_json::Map::new(),
    };
    let mut discovered = discover_settings_agents(&agent_dir, project.as_deref());

    for settings in [&user_settings, &project_settings] {
        if let Some(overrides) = subagents_object(settings)
            .and_then(|subagents| subagents.get("agentOverrides"))
            .and_then(Value::as_object)
        {
            for name in overrides.keys() {
                discovered
                    .entry(name.clone())
                    .or_insert_with(|| DiscoveredAgent {
                        name: name.clone(),
                        description: "Configured subagent".to_string(),
                        source: "configured",
                        definition_path: None,
                        base_model: None,
                        base_thinking: None,
                        base_tools: None,
                    });
            }
        }
    }

    let user_default_model = setting_string(&user_settings, "defaultModel");
    let project_default_model = setting_string(&project_settings, "defaultModel");
    let user_default_thinking = setting_string(&user_settings, "defaultThinking");
    let project_default_thinking = setting_string(&project_settings, "defaultThinking");
    let mut agents = discovered
        .into_values()
        .map(|agent| {
            let user_model = agent_override_string(&user_settings, &agent.name, "model");
            let project_model = agent_override_string(&project_settings, &agent.name, "model");
            let user_thinking = agent_override_string(&user_settings, &agent.name, "thinking");
            let project_thinking =
                agent_override_string(&project_settings, &agent.name, "thinking");
            let custom_model_locked = agent.source != "builtin" && agent.base_model.is_some();
            let custom_thinking_locked = agent.source != "builtin" && agent.base_thinking.is_some();

            let (effective_model, model_source) = if custom_model_locked {
                (agent.base_model.clone(), "agent-file".to_string())
            } else if let Some(value) = project_model.clone() {
                (Some(value), "project".to_string())
            } else if let Some(value) = user_model.clone() {
                (Some(value), "user".to_string())
            } else if let Some(value) = agent.base_model.clone() {
                (Some(value), "agent-file".to_string())
            } else if let Some(value) = project_default_model.clone() {
                (Some(value), "project-default".to_string())
            } else if let Some(value) = user_default_model.clone() {
                (Some(value), "user-default".to_string())
            } else {
                (None, "session".to_string())
            };

            let (effective_thinking, thinking_source) = if custom_thinking_locked {
                (agent.base_thinking.clone(), "agent-file".to_string())
            } else if let Some(value) = project_thinking.clone() {
                (Some(value), "project".to_string())
            } else if let Some(value) = user_thinking.clone() {
                (Some(value), "user".to_string())
            } else if let Some(value) = agent.base_thinking.clone() {
                (Some(value), "agent-file".to_string())
            } else if let Some(value) = project_default_thinking.clone() {
                (Some(value), "project-default".to_string())
            } else if let Some(value) = user_default_thinking.clone() {
                (Some(value), "user-default".to_string())
            } else {
                (None, "session".to_string())
            };

            let shadowed_by_project =
                scope == "user" && (project_model.is_some() || project_thinking.is_some());
            SubagentSettingInfo {
                name: agent.name,
                description: agent.description,
                source: agent.source,
                effective_model,
                effective_thinking,
                model_override: if custom_model_locked {
                    agent.base_model
                } else if scope == "project" {
                    project_model
                } else {
                    user_model
                },
                thinking_override: if custom_thinking_locked {
                    agent.base_thinking
                } else if scope == "project" {
                    project_thinking
                } else {
                    user_thinking
                },
                model_source,
                thinking_source,
                model_locked: false,
                thinking_locked: false,
                shadowed_by_project,
            }
        })
        .collect::<Vec<_>>();
    agents.sort_by(|left, right| {
        let rank = |source: &str| match source {
            "project" => 0,
            "user" => 1,
            "configured" => 2,
            _ => 3,
        };
        rank(left.source)
            .cmp(&rank(right.source))
            .then_with(|| left.name.cmp(&right.name))
    });

    Ok(SubagentSettingsSnapshot {
        agents,
        scope,
        user_settings_path: user_path.to_string_lossy().into_owned(),
        project_settings_path: project_path.map(|path| path.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
async fn get_subagent_settings(
    scope: String,
    manager: State<'_, Arc<PiManager>>,
) -> Result<SubagentSettingsSnapshot, String> {
    let project = manager.inner().registry.lock().await.active_project.clone();
    tauri::async_runtime::spawn_blocking(move || build_subagent_settings_snapshot(project, scope))
        .await
        .map_err(|error| format!("Could not inspect subagent settings: {error}"))?
}

fn valid_agent_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 160
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

fn validate_override_value(field: &str, value: Option<&str>) -> Result<(), String> {
    let Some(value) = value else {
        return Ok(());
    };
    if value.is_empty() || value.len() > 240 || value.chars().any(char::is_control) {
        return Err(format!("Invalid subagent {field} value."));
    }
    if field == "thinking"
        && !matches!(
            value,
            "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
        )
    {
        return Err("Thinking must be off, minimal, low, medium, high, xhigh, or max.".to_string());
    }
    Ok(())
}

fn write_settings_object(
    path: &Path,
    settings: &serde_json::Map<String, Value>,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Settings path has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let encoded = serde_json::to_vec_pretty(&Value::Object(settings.clone()))
        .map_err(|error| format!("Could not encode settings: {error}"))?;
    if encoded.len() as u64 > MAX_SETTINGS_FILE_BYTES {
        return Err("Updated settings would exceed 2 MiB.".to_string());
    }
    let temporary = path.with_extension("json.lemonpi.tmp");
    let mut contents = encoded;
    contents.push(b'\n');
    fs::write(&temporary, contents)
        .map_err(|error| format!("Could not write {}: {error}", temporary.display()))?;
    if path.exists() {
        #[cfg(windows)]
        fs::remove_file(path)
            .map_err(|error| format!("Could not replace {}: {error}", path.display()))?;
    }
    fs::rename(&temporary, path)
        .map_err(|error| format!("Could not replace {}: {error}", path.display()))
}

fn update_agent_frontmatter(path: &Path, field: &str, value: Option<String>) -> Result<(), String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
    if metadata.len() > MAX_AGENT_FILE_BYTES {
        return Err(format!(
            "Agent file {} is larger than 256 KiB.",
            path.display()
        ));
    }
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let newline = if contents.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut lines = contents.lines().map(str::to_string).collect::<Vec<_>>();
    if lines.first().map(|line| line.trim()) != Some("---") {
        return Err(format!(
            "Agent file {} has no YAML frontmatter.",
            path.display()
        ));
    }
    let closing = lines
        .iter()
        .enumerate()
        .skip(1)
        .find_map(|(index, line)| (line.trim() == "---").then_some(index))
        .ok_or_else(|| {
            format!(
                "Agent file {} has unterminated YAML frontmatter.",
                path.display()
            )
        })?;
    let existing = lines
        .iter()
        .enumerate()
        .take(closing)
        .skip(1)
        .find_map(|(index, line)| {
            line.split_once(':').and_then(|(key, _)| {
                let indented = line.chars().next().is_some_and(char::is_whitespace);
                (key.trim() == field && !indented).then_some(index)
            })
        });
    match (existing, value) {
        (Some(index), Some(value)) => lines[index] = format!("{field}: {value}"),
        (Some(index), None) => {
            lines.remove(index);
        }
        (None, Some(value)) => lines.insert(closing, format!("{field}: {value}")),
        (None, None) => return Ok(()),
    }
    let mut updated = lines.join(newline);
    if contents.ends_with('\n') {
        updated.push_str(newline);
    }
    let temporary = path.with_extension("md.lemonpi.tmp");
    fs::write(&temporary, updated)
        .map_err(|error| format!("Could not write {}: {error}", temporary.display()))?;
    if path.exists() {
        #[cfg(windows)]
        fs::remove_file(path)
            .map_err(|error| format!("Could not replace {}: {error}", path.display()))?;
    }
    fs::rename(&temporary, path)
        .map_err(|error| format!("Could not replace {}: {error}", path.display()))
}

fn update_subagent_override_file(
    path: &Path,
    agent: &str,
    field: &str,
    value: Option<String>,
) -> Result<(), String> {
    let mut settings = read_settings_object(path)?;
    let subagents = settings
        .entry("subagents".to_string())
        .or_insert_with(|| json!({}));
    let subagents = subagents.as_object_mut().ok_or_else(|| {
        format!(
            "Settings field 'subagents' in {} must be an object.",
            path.display()
        )
    })?;
    let overrides = subagents
        .entry("agentOverrides".to_string())
        .or_insert_with(|| json!({}));
    let overrides = overrides.as_object_mut().ok_or_else(|| {
        format!(
            "Settings field 'subagents.agentOverrides' in {} must be an object.",
            path.display()
        )
    })?;
    let entry = overrides
        .entry(agent.to_string())
        .or_insert_with(|| json!({}));
    let entry = entry.as_object_mut().ok_or_else(|| {
        format!(
            "Override for '{agent}' in {} must be an object.",
            path.display()
        )
    })?;

    if let Some(value) = value {
        entry.insert(field.to_string(), Value::String(value));
    } else {
        entry.remove(field);
    }
    if entry.is_empty() {
        overrides.remove(agent);
    }
    if overrides.is_empty() {
        subagents.remove("agentOverrides");
    }
    if subagents.is_empty() {
        settings.remove("subagents");
    }
    write_settings_object(path, &settings)
}

#[tauri::command]
async fn set_subagent_override(
    scope: String,
    agent: String,
    field: String,
    value: Option<String>,
    manager: State<'_, Arc<PiManager>>,
) -> Result<SubagentSettingsSnapshot, String> {
    if !valid_agent_name(&agent) {
        return Err("Invalid subagent name.".to_string());
    }
    if !matches!(field.as_str(), "model" | "thinking") {
        return Err("Only subagent model and thinking settings can be changed.".to_string());
    }
    validate_override_value(&field, value.as_deref())?;
    let project = manager.inner().registry.lock().await.active_project.clone();
    validate_settings_scope(&scope, project.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let agent_dir = pi_agent_dir()?;
        let discovered = discover_settings_agents(&agent_dir, project.as_deref());
        let definition_field_owned = discovered.get(&agent).is_some_and(|definition| {
            definition.source != "builtin"
                && if field == "model" {
                    definition.base_model.is_some()
                } else {
                    definition.base_thinking.is_some()
                }
        });
        if definition_field_owned {
            let definition_path = discovered
                .get(&agent)
                .and_then(|definition| definition.definition_path.as_deref())
                .ok_or_else(|| format!("Could not locate the agent file for '{agent}'."))?;
            update_agent_frontmatter(definition_path, &field, value)?;
        } else {
            let path = if scope == "project" {
                project
                    .as_deref()
                    .map(project_settings_path)
                    .ok_or_else(|| "Open a project before editing project settings.".to_string())?
            } else {
                agent_dir.join("settings.json")
            };
            update_subagent_override_file(&path, &agent, &field, value)?;
        }
        build_subagent_settings_snapshot(project, scope)
    })
    .await
    .map_err(|error| format!("Could not update subagent settings: {error}"))?
}

fn merge_settings(base: &mut Value, overlay: &Value) {
    match (base, overlay) {
        (Value::Object(base), Value::Object(overlay)) => {
            for (key, value) in overlay {
                if let Some(current) = base.get_mut(key) {
                    merge_settings(current, value);
                } else {
                    base.insert(key.clone(), value.clone());
                }
            }
        }
        (base, overlay) => *base = overlay.clone(),
    }
}

fn settings_path_for_scope(scope: &str, project: Option<&Path>) -> Result<PathBuf, String> {
    validate_settings_scope(scope, project)?;
    if scope == "project" {
        Ok(project_settings_path(
            project.expect("validated project scope"),
        ))
    } else {
        Ok(pi_agent_dir()?.join("settings.json"))
    }
}

fn build_pi_settings_snapshot(
    project: Option<PathBuf>,
    scope: String,
) -> Result<PiSettingsSnapshot, String> {
    let path = settings_path_for_scope(&scope, project.as_deref())?;
    let selected = Value::Object(read_settings_object(&path)?);
    let effective_settings = if scope == "project" {
        let mut effective = Value::Object(read_settings_object(
            &pi_agent_dir()?.join("settings.json"),
        )?);
        merge_settings(&mut effective, &selected);
        effective
    } else {
        selected.clone()
    };
    Ok(PiSettingsSnapshot {
        scope,
        path: path.to_string_lossy().into_owned(),
        settings: selected,
        effective_settings,
    })
}

#[tauri::command]
async fn get_pi_settings(
    scope: String,
    manager: State<'_, Arc<PiManager>>,
) -> Result<PiSettingsSnapshot, String> {
    let project = manager.inner().registry.lock().await.active_project.clone();
    tauri::async_runtime::spawn_blocking(move || build_pi_settings_snapshot(project, scope))
        .await
        .map_err(|error| format!("Could not inspect Pi settings: {error}"))?
}

fn valid_setting_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 240
        && path.split('.').all(|segment| {
            !segment.is_empty()
                && segment.len() <= 80
                && segment.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
                })
        })
}

fn set_nested_setting(
    object: &mut serde_json::Map<String, Value>,
    path: &[&str],
    value: Option<Value>,
) -> Result<(), String> {
    let Some((key, rest)) = path.split_first() else {
        return Err("A setting path is required.".to_string());
    };
    if rest.is_empty() {
        if let Some(value) = value {
            object.insert((*key).to_string(), value);
        } else {
            object.remove(*key);
        }
        return Ok(());
    }

    if value.is_none() && !object.contains_key(*key) {
        return Ok(());
    }
    let nested = object
        .entry((*key).to_string())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| format!("Setting '{}' must be an object.", key))?;
    set_nested_setting(nested, rest, value)?;
    if nested.is_empty() {
        object.remove(*key);
    }
    Ok(())
}

#[tauri::command]
async fn set_pi_setting(
    scope: String,
    path: String,
    value: Option<Value>,
    manager: State<'_, Arc<PiManager>>,
) -> Result<PiSettingsSnapshot, String> {
    if !valid_setting_path(&path) {
        return Err("Invalid Pi setting path.".to_string());
    }
    if scope == "project" && matches!(path.as_str(), "defaultProjectTrust" | "httpProxy") {
        return Err(format!("{path} is an all-projects setting."));
    }
    let project = manager.inner().registry.lock().await.active_project.clone();
    validate_settings_scope(&scope, project.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let settings_path = settings_path_for_scope(&scope, project.as_deref())?;
        let mut settings = read_settings_object(&settings_path)?;
        set_nested_setting(&mut settings, &path.split('.').collect::<Vec<_>>(), value)?;
        write_settings_object(&settings_path, &settings)?;
        build_pi_settings_snapshot(project, scope)
    })
    .await
    .map_err(|error| format!("Could not update Pi settings: {error}"))?
}

#[tauri::command]
async fn replace_pi_settings(
    scope: String,
    settings: Value,
    manager: State<'_, Arc<PiManager>>,
) -> Result<PiSettingsSnapshot, String> {
    let settings = settings
        .as_object()
        .cloned()
        .ok_or_else(|| "Pi settings must be a JSON object.".to_string())?;
    let project = manager.inner().registry.lock().await.active_project.clone();
    validate_settings_scope(&scope, project.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = settings_path_for_scope(&scope, project.as_deref())?;
        write_settings_object(&path, &settings)?;
        build_pi_settings_snapshot(project, scope)
    })
    .await
    .map_err(|error| format!("Could not replace Pi settings: {error}"))?
}

fn configured_package_sources(settings: &serde_json::Map<String, Value>) -> Vec<String> {
    settings
        .get("packages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(package_source)
        .map(str::to_string)
        .collect()
}

fn parse_pi_list_locations(output: &str) -> HashMap<(String, String), String> {
    let mut locations = HashMap::new();
    let mut scope = "user";
    let mut source: Option<String> = None;
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed == "User packages:" {
            scope = "user";
            source = None;
        } else if trimmed == "Project packages:" {
            scope = "project";
            source = None;
        } else if line.starts_with("  ") && !line.starts_with("    ") && !trimmed.is_empty() {
            source = Some(trimmed.to_string());
        } else if line.starts_with("    ") {
            if let Some(current) = source.take() {
                locations.insert((scope.to_string(), current), trimmed.to_string());
            }
        }
    }
    locations
}

async fn build_pi_packages_snapshot(
    executable: &PathBuf,
    project: Option<&Path>,
    trusted: bool,
) -> Result<PiPackagesSnapshot, String> {
    let agent_dir = pi_agent_dir()?;
    let user_settings = read_settings_object(&agent_dir.join("settings.json"))?;
    let project_settings = match project {
        Some(project) => read_settings_object(&project_settings_path(project))?,
        None => serde_json::Map::new(),
    };
    let cwd = project.map(Path::to_path_buf).unwrap_or(home_dir()?);
    let trust_arg = project_trust_arg(trusted);
    let list_output = run_pi_cli(executable, &cwd, &["list", trust_arg])
        .await
        .unwrap_or_default();
    let locations = parse_pi_list_locations(&list_output);
    let mut packages = Vec::new();
    for (scope, sources) in [
        ("user", configured_package_sources(&user_settings)),
        ("project", configured_package_sources(&project_settings)),
    ] {
        for source in sources {
            let location = locations.get(&(scope.to_string(), source.clone())).cloned();
            let required_package = required_pi_package(&source);
            let installed = location
                .as_deref()
                .is_some_and(|path| Path::new(path).exists())
                || (scope == "user"
                    && required_package
                        .is_some_and(|package| required_pi_package_installed(&agent_dir, package)));
            packages.push(PiPackageInfo {
                required: required_package.is_some(),
                source,
                scope: scope.to_string(),
                location,
                installed,
            });
        }
    }
    packages.sort_by(|left, right| {
        left.scope
            .cmp(&right.scope)
            .then_with(|| left.source.cmp(&right.source))
    });
    Ok(PiPackagesSnapshot {
        core_ready: REQUIRED_PI_PACKAGES.iter().all(|required| {
            packages.iter().any(|package| {
                package.scope == "user"
                    && package.installed
                    && required_pi_package(&package.source)
                        .is_some_and(|candidate| candidate.npm_name == required.npm_name)
            })
        }),
        packages,
    })
}

#[tauri::command]
async fn get_pi_packages(manager: State<'_, Arc<PiManager>>) -> Result<PiPackagesSnapshot, String> {
    let (project, trusted) = {
        let registry = manager.inner().registry.lock().await;
        (
            registry.active_project.clone(),
            registry.active_trusted.unwrap_or(false),
        )
    };
    let executable = find_pi()?;
    build_pi_packages_snapshot(&executable, project.as_deref(), trusted).await
}

#[tauri::command]
async fn run_pi_package_action(
    action: String,
    source: Option<String>,
    scope: String,
    manager: State<'_, Arc<PiManager>>,
) -> Result<PiPackagesSnapshot, String> {
    if !matches!(action.as_str(), "install" | "remove" | "update") {
        return Err("Unsupported package action.".to_string());
    }
    if let Some(source) = source.as_deref() {
        if source.is_empty() || source.len() > 500 || source.chars().any(char::is_control) {
            return Err("Invalid package source.".to_string());
        }
        if action == "remove" && required_pi_package(source).is_some() {
            return Err(format!(
                "{} is a required LemonPi package and cannot be removed.",
                npm_package_name(source).unwrap_or(source)
            ));
        }
    } else if action != "update" {
        return Err("Choose a package source.".to_string());
    }
    if !matches!(scope.as_str(), "user" | "project") {
        return Err("Package scope must be 'user' or 'project'.".to_string());
    }

    let (project, trusted) = {
        let registry = manager.inner().registry.lock().await;
        (
            registry.active_project.clone(),
            registry.active_trusted.unwrap_or(false),
        )
    };
    if scope == "project" && project.is_none() {
        return Err("Open a project before managing project packages.".to_string());
    }
    if scope == "project" && !trusted {
        return Err(
            "Trust this project before installing or changing project packages.".to_string(),
        );
    }

    let executable = find_pi()?;
    let cwd = project
        .as_deref()
        .map(Path::to_path_buf)
        .unwrap_or(home_dir()?);
    let trust_arg = if scope == "project" {
        "--approve"
    } else {
        "--no-approve"
    };
    if action == "update" && source.is_none() && scope == "project" {
        let project_path = project.as_deref().expect("validated project scope");
        let project_settings = read_settings_object(&project_settings_path(project_path))?;
        for package in configured_package_sources(&project_settings) {
            run_pi_cli(&executable, &cwd, &["update", &package, "--approve"]).await?;
        }
        return build_pi_packages_snapshot(&executable, project.as_deref(), trusted).await;
    }

    let mut args = vec![action.as_str()];
    if action == "update" && source.is_none() {
        args.push("--extensions");
    } else if let Some(source) = source.as_deref() {
        args.push(source);
    }
    if scope == "project" && action != "update" {
        args.push("--local");
    }
    args.push(trust_arg);
    run_pi_cli(&executable, &cwd, &args).await?;
    build_pi_packages_snapshot(&executable, project.as_deref(), trusted).await
}

fn collect_subagent_status_files(directory: &Path, depth: usize, output: &mut Vec<PathBuf>) {
    if depth == 0 || output.len() >= 512 {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_subagent_status_files(&path, depth - 1, output);
        } else if path.file_name().is_some_and(|name| name == "status.json") {
            output.push(path);
            if output.len() >= 512 {
                return;
            }
        }
    }
}

fn message_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    let parts = value.as_array()?;
    let text = parts
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

fn strip_internal_child_prompt_blocks(value: &str) -> String {
    ["lemonpi-child-checklist", "lemonpi-child-todo-seed"]
        .into_iter()
        .fold(value.to_string(), |mut text, tag| {
            let opening = format!("<{tag}>");
            let closing = format!("</{tag}>");
            while let Some(start) = text.find(&opening) {
                let Some(relative_end) = text[start + opening.len()..].find(&closing) else {
                    text.truncate(start);
                    break;
                };
                let end = start + opening.len() + relative_end + closing.len();
                text.replace_range(start..end, "");
            }
            text
        })
        .trim_end()
        .to_string()
}

fn read_subagent_prompts(async_dir: &Path) -> HashMap<usize, String> {
    let Ok(file) = fs::File::open(async_dir.join("events.jsonl")) else {
        return HashMap::new();
    };
    let mut content = String::new();
    if file
        .take(SUBAGENT_PROMPT_SCAN_BYTES)
        .read_to_string(&mut content)
        .is_err()
    {
        return HashMap::new();
    }

    let mut prompts = HashMap::new();
    for line in content.lines() {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if event.get("type").and_then(Value::as_str) != Some("message_start")
            || event.pointer("/message/role").and_then(Value::as_str) != Some("user")
        {
            continue;
        }
        let index = event
            .get("subagentStepIndex")
            .and_then(Value::as_u64)
            .unwrap_or_default() as usize;
        if prompts.contains_key(&index) {
            continue;
        }
        let Some(prompt) = event.pointer("/message/content").and_then(message_text) else {
            continue;
        };
        let prompt = strip_internal_child_prompt_blocks(&prompt);
        let prompt = prompt.chars().take(SUBAGENT_PROMPT_MAX_CHARS).collect();
        prompts.insert(index, prompt);
    }
    prompts
}

#[tauri::command]
async fn get_subagent_runs(session_file: String) -> Result<Vec<Value>, String> {
    let temp = env::temp_dir();
    let entries = fs::read_dir(&temp)
        .map_err(|error| format!("Could not inspect the temporary directory: {error}"))?;
    let mut status_files = Vec::new();

    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("pi-subagents-") {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_subagent_status_files(&path, 5, &mut status_files);
        }
    }

    let mut runs = Vec::new();
    for path in status_files {
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if metadata.len() > 2 * 1024 * 1024 {
            continue;
        }
        let Ok(contents) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(mut status) = serde_json::from_str::<Value>(&contents) else {
            continue;
        };
        if status.get("sessionId").and_then(Value::as_str) != Some(session_file.as_str()) {
            continue;
        }
        // pi-subagents 0.40 can leave activityState latched at
        // `needs_attention` after the child has resumed. Reconcile the public
        // status with its append-only lifecycle stream so Command Center shows
        // an incident only until that same child produces new work.
        reconcile_subagent_attention(&mut status, &path);
        let prompts = path.parent().map(read_subagent_prompts).unwrap_or_default();
        if let Some(steps) = status.get_mut("steps").and_then(Value::as_array_mut) {
            for (index, step) in steps.iter_mut().enumerate() {
                if let (Some(prompt), Some(fields)) = (prompts.get(&index), step.as_object_mut()) {
                    fields.insert("prompt".to_string(), Value::from(prompt.clone()));
                }
            }
        }
        if let Value::Object(fields) = &mut status {
            fields.insert(
                "statusPath".to_string(),
                Value::from(path.to_string_lossy().into_owned()),
            );
        }
        runs.push(status);
    }

    runs.sort_by(|left, right| {
        let active_rank = |value: &Value| match value.get("state").and_then(Value::as_str) {
            Some("running" | "queued") => 0,
            _ => 1,
        };
        active_rank(left).cmp(&active_rank(right)).then_with(|| {
            let timestamp = |value: &Value| {
                value
                    .get("lastUpdate")
                    .and_then(Value::as_u64)
                    .or_else(|| value.get("startedAt").and_then(Value::as_u64))
                    .unwrap_or_default()
            };
            timestamp(right).cmp(&timestamp(left))
        })
    });
    runs.truncate(24);
    Ok(runs)
}

#[tauri::command]
async fn get_git_branch(project: String) -> Result<Option<String>, String> {
    let project = PathBuf::from(project);
    if !project.is_dir() {
        return Ok(None);
    }
    let branch = Command::new("git")
        .arg("-C")
        .arg(&project)
        .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| format!("Could not inspect the Git branch: {error}"))?;
    if branch.status.success() {
        let name = String::from_utf8_lossy(&branch.stdout).trim().to_string();
        return Ok((!name.is_empty()).then_some(name));
    }
    let revision = Command::new("git")
        .arg("-C")
        .arg(&project)
        .args(["rev-parse", "--short", "HEAD"])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| format!("Could not inspect the Git revision: {error}"))?;
    if !revision.status.success() {
        return Ok(None);
    }
    let revision = String::from_utf8_lossy(&revision.stdout).trim().to_string();
    Ok((!revision.is_empty()).then_some(format!("detached @ {revision}")))
}

#[tauri::command]
async fn stop_pi(manager: State<'_, Arc<PiManager>>) -> Result<(), String> {
    stop_active(manager.inner()).await;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Arc::new(PiManager::default()))
        .invoke_handler(tauri::generate_handler![
            detect_pi,
            start_pi,
            send_pi,
            list_pi_sessions,
            sync_known_projects,
            get_git_branch,
            get_subagent_runs,
            get_subagent_activity,
            get_subagent_settings,
            set_subagent_override,
            get_pi_settings,
            set_pi_setting,
            replace_pi_settings,
            get_pi_packages,
            run_pi_package_action,
            stop_pi
        ])
        .run(tauri::generate_context!())
        .expect("error while running LemonPi");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trust_decision_maps_to_explicit_cli_flag() {
        assert_eq!(project_trust_arg(true), "--approve");
        assert_eq!(project_trust_arg(false), "--no-approve");
    }

    #[test]
    fn command_encoding_requires_a_typed_rpc_and_preserves_the_record_bound() {
        assert_eq!(
            encode_validated_pi_command(&json!({ "payload": {} })),
            Err("RPC commands must be JSON objects with a string type.".to_string())
        );

        let encoded = encode_validated_pi_command(&json!({
            "type": "get_state",
            "payload": {},
        }))
        .unwrap();
        assert!(encoded.ends_with(b"\n"));
        assert_eq!(
            serde_json::from_slice::<Value>(&encoded[..encoded.len() - 1]).unwrap(),
            json!({ "type": "get_state", "payload": {} })
        );

        let oversized = json!({
            "type": "prompt",
            "payload": "x".repeat(MAX_RPC_RECORD_BYTES),
        });
        assert_eq!(
            encode_validated_pi_command(&oversized),
            Err("RPC command is too large.".to_string())
        );
    }

    #[test]
    fn explicit_command_project_is_canonical_and_does_not_replace_the_active_project() {
        let root = env::temp_dir().join(format!(
            "lemonpi-command-project-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let active = root.join("active");
        let requested = root.join("requested");
        fs::create_dir_all(&active).unwrap();
        fs::create_dir_all(&requested).unwrap();
        let canonical_active = active.canonicalize().unwrap();
        let canonical_requested = requested.canonicalize().unwrap();

        assert_eq!(
            select_pi_command_project(
                Some(requested.to_string_lossy().into_owned()),
                Some(canonical_active.clone()),
            )
            .unwrap(),
            canonical_requested
        );
        assert_eq!(
            select_pi_command_project(None, Some(canonical_active.clone())).unwrap(),
            canonical_active
        );
        assert_eq!(
            select_pi_command_project(None, None),
            Err("Pi is not running.".to_string())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn strips_windows_verbatim_prefixes_from_frontend_paths() {
        assert_eq!(
            path_for_frontend(Path::new(r"\\?\C:\Users\Christopher\Finches")),
            r"C:\Users\Christopher\Finches"
        );
        assert_eq!(
            path_for_frontend(Path::new(r"\\?\UNC\server\share\Finches")),
            r"\\server\share\Finches"
        );
        assert_eq!(
            path_for_frontend(Path::new("//?/C:/Users/Christopher/Finches")),
            "C:/Users/Christopher/Finches"
        );
    }

    #[test]
    fn recognizes_versioned_required_pi_packages() {
        assert!(required_pi_package("npm:pi-subagents").is_some());
        assert!(required_pi_package("npm:pi-subagents@1.2.3").is_some());
        assert!(required_pi_package("npm:pi-web-access").is_some());
        assert!(required_pi_package("npm:pi-web-access@0.17.1").is_some());
        assert!(required_pi_package("npm:@juicesharp/rpiv-ask-user-question").is_some());
        assert!(required_pi_package("npm:@juicesharp/rpiv-ask-user-question@2.3.1").is_some());
        assert!(required_pi_package("npm:@juicesharp/rpiv-todo").is_some());
        assert!(required_pi_package("npm:@juicesharp/rpiv-todo@2.3.1").is_some());
        assert!(required_pi_package("npm:pi-subagents-extra").is_none());
        assert_eq!(
            npm_package_name("npm:@scope/tools@2.0.0"),
            Some("@scope/tools")
        );
    }

    #[test]
    fn attention_episode_recovers_only_after_new_child_work() {
        let waiting = r#"{"type":"subagent.control","event":{"to":"needs_attention","ts":100,"index":0}}
{"type":"message_end","observedAt":101,"subagentStepIndex":0,"message":{"role":"toolResult"}}
{"type":"tool_execution_start","observedAt":102,"subagentStepIndex":0,"toolName":"contact_supervisor"}"#;
        let waiting_episode = subagent_attention_episodes(waiting)
            .get(&0)
            .copied()
            .expect("attention episode");
        assert_eq!(waiting_episode.attention_at, 100);
        assert_eq!(waiting_episode.recovered_at, None);

        let recovered = format!(
            "{waiting}\n{{\"type\":\"message_end\",\"observedAt\":103,\"subagentStepIndex\":0,\"message\":{{\"role\":\"assistant\"}}}}"
        );
        assert_eq!(
            subagent_attention_episodes(&recovered)
                .get(&0)
                .and_then(|episode| episode.recovered_at),
            Some(103)
        );

        let needs_attention_again = format!(
            "{recovered}\n{{\"type\":\"subagent.control\",\"event\":{{\"to\":\"needs_attention\",\"ts\":104,\"index\":0}}}}"
        );
        assert_eq!(
            subagent_attention_episodes(&needs_attention_again)
                .get(&0)
                .and_then(|episode| episode.recovered_at),
            None
        );
    }

    #[test]
    fn reconciles_latched_attention_after_recovery() {
        let root =
            env::temp_dir().join(format!("lemonpi-attention-recovery-{}", std::process::id()));
        fs::create_dir_all(&root).expect("create attention fixture");
        fs::write(
            root.join("events.jsonl"),
            "{\"type\":\"subagent.control\",\"event\":{\"to\":\"needs_attention\",\"ts\":100,\"index\":0}}\n{\"type\":\"tool_execution_start\",\"observedAt\":110,\"subagentStepIndex\":0,\"toolName\":\"bash\"}\n",
        )
        .expect("write attention events");
        let status_path = root.join("status.json");
        let mut status = json!({
            "state": "running",
            "activityState": "needs_attention",
            "steps": [{
                "agent": "worker",
                "status": "running",
                "activityState": "needs_attention"
            }]
        });

        reconcile_subagent_attention(&mut status, &status_path);

        assert!(status.get("activityState").is_none());
        assert!(status["steps"][0].get("activityState").is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn builtin_and_custom_subagents_receive_todo_without_losing_existing_overrides() {
        let root = env::temp_dir().join(format!(
            "lemonpi-subagent-todo-access-{}",
            std::process::id()
        ));
        let agents = root.join("npm/node_modules/pi-subagents/agents");
        let user_agents = root.join("agents");
        let project = root.join("project");
        let todo = root.join("npm/node_modules/@juicesharp/rpiv-todo");
        let bridge = root.join("child-todo-bridge.ts");
        fs::create_dir_all(&agents).expect("create builtin fixture directory");
        fs::create_dir_all(&user_agents).expect("create user agent fixture directory");
        fs::create_dir_all(&project).expect("create project fixture directory");
        fs::create_dir_all(&todo).expect("create todo fixture directory");
        fs::write(
            agents.join("worker.md"),
            "---\nname: worker\ndescription: Test worker\ntools: read, grep, write\n---\nWorker\n",
        )
        .expect("write builtin agent fixture");
        fs::write(
            user_agents.join("designer.md"),
            "---\nname: designer\ndescription: Test designer\ntools: read, write\n---\nDesigner\n",
        )
        .expect("write custom agent fixture");
        fs::write(todo.join("index.ts"), "export default () => {};\n")
            .expect("write todo extension fixture");
        fs::write(&bridge, "export default () => {};\n").expect("write child todo bridge fixture");
        let legacy_todo_path = path_for_frontend(&todo.join("index.ts"));
        write_settings_object(
            &root.join("settings.json"),
            &serde_json::Map::from_iter([
                (
                    "packages".to_string(),
                    json!(["npm:@juicesharp/rpiv-todo", "npm:keep-this-package"]),
                ),
                (
                    "subagents".to_string(),
                    json!({ "agentOverrides": { "worker": {
                        "model": "example/model",
                        "tools": ["read", "bash"],
                        "subagentOnlyExtensions": ["/keep-this-extension.ts", legacy_todo_path]
                    } } }),
                ),
            ]),
        )
        .expect("write settings fixture");

        ensure_subagent_todo_access(&root, &project, true, &bridge)
            .expect("grant subagent todo access");
        let settings = read_settings_object(&root.join("settings.json")).expect("read settings");
        assert_eq!(
            settings["packages"],
            json!(["npm:@juicesharp/rpiv-todo", "npm:keep-this-package"])
        );
        let worker = &settings["subagents"]["agentOverrides"]["worker"];
        assert_eq!(worker["model"], json!("example/model"));
        assert_eq!(worker["tools"], json!(["read", "bash", "child_todo"]));
        assert_eq!(
            worker["subagentOnlyExtensions"],
            json!(["/keep-this-extension.ts", path_for_frontend(&bridge)])
        );
        let designer = &settings["subagents"]["agentOverrides"]["designer"];
        assert_eq!(designer["tools"], json!(["read", "write", "child_todo"]));
        assert_eq!(
            designer["subagentOnlyExtensions"],
            json!([path_for_frontend(&bridge)])
        );
        fs::remove_dir_all(root).expect("remove todo access fixture");
    }

    #[test]
    fn auto_compaction_is_seeded_without_overriding_user_choice() {
        let root = env::temp_dir().join(format!(
            "lemonpi-auto-compaction-default-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create settings fixture directory");

        write_settings_object(
            &root.join("settings.json"),
            &serde_json::Map::from_iter([("theme".to_string(), json!("dark"))]),
        )
        .expect("write settings fixture");
        ensure_auto_compaction_default(&root).expect("seed auto compaction");
        let seeded =
            read_settings_object(&root.join("settings.json")).expect("read seeded settings");
        assert_eq!(seeded["compaction"]["enabled"], json!(true));
        assert_eq!(seeded["theme"], json!("dark"));

        let mut explicit = seeded;
        explicit.insert(
            "compaction".to_string(),
            json!({ "enabled": false, "reserveTokens": 9000 }),
        );
        write_settings_object(&root.join("settings.json"), &explicit)
            .expect("write explicit setting");
        ensure_auto_compaction_default(&root).expect("preserve explicit setting");
        let preserved =
            read_settings_object(&root.join("settings.json")).expect("read preserved settings");
        assert_eq!(preserved["compaction"]["enabled"], json!(false));
        assert_eq!(preserved["compaction"]["reserveTokens"], json!(9000));

        fs::remove_dir_all(root).expect("remove settings fixture");
    }

    #[test]
    fn subagent_todo_snapshots_are_scoped_to_the_child_owner() {
        let path =
            env::temp_dir().join(format!("lemonpi-child-todos-{}.jsonl", std::process::id()));
        fs::write(
            &path,
            concat!(
                "{\"type\":\"custom\",\"customType\":\"lemonpi-child-todos\",\"data\":{\"version\":1,\"owner\":\"planner\",\"nextId\":3,\"tasks\":[{\"id\":1,\"subject\":\"Inspect scope\",\"status\":\"in_progress\",\"blockedBy\":[],\"owner\":\"planner\"},{\"id\":2,\"subject\":\"Return plan\",\"status\":\"pending\",\"blockedBy\":[1],\"owner\":\"planner\"}]}}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"toolResult\",\"toolName\":\"child_todo\",\"timestamp\":2000,\"details\":{\"tasks\":[{\"id\":1,\"subject\":\"Main task\",\"status\":\"in_progress\"},{\"id\":1,\"subject\":\"Inspect scope\",\"status\":\"completed\",\"owner\":\"planner\"},{\"id\":2,\"subject\":\"Return plan\",\"status\":\"in_progress\",\"owner\":\"planner\"}]}}}\n",
            ),
        )
        .expect("write child todo fixture");

        let snapshot = read_subagent_todos(&path, "planner").expect("read child todos");
        assert_eq!(snapshot.updated_at, Some(2000));
        let tasks = snapshot.tasks;
        fs::remove_file(&path).expect("remove child todo fixture");

        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].subject, "Inspect scope");
        assert_eq!(tasks[0].status, "completed");
        assert_eq!(tasks[1].subject, "Return plan");
        assert_eq!(tasks[1].status, "in_progress");
        assert_eq!(tasks[0].owner.as_deref(), Some("planner"));
    }

    #[test]
    fn delegated_prompt_hides_internal_child_initialization_blocks() {
        let prompt = concat!(
            "Chunk outcome: inspect the parser.\n",
            "Child checklist:\n- Inspect parser :: Find the seam\n",
            "<lemonpi-child-checklist>internal guidance</lemonpi-child-checklist>\n",
            "<lemonpi-child-todo-seed>{\"version\":1}</lemonpi-child-todo-seed>",
        );
        assert_eq!(
            strip_internal_child_prompt_blocks(prompt),
            "Chunk outcome: inspect the parser.\nChild checklist:\n- Inspect parser :: Find the seam"
        );
    }

    #[test]
    fn nested_setting_updates_preserve_siblings_and_clean_empty_objects() {
        let mut settings = serde_json::Map::from_iter([
            ("theme".to_string(), json!("dark")),
            (
                "retry".to_string(),
                json!({ "enabled": true, "maxRetries": 3 }),
            ),
        ]);
        set_nested_setting(&mut settings, &["retry", "maxRetries"], Some(json!(5))).unwrap();
        assert_eq!(settings["retry"]["enabled"], json!(true));
        assert_eq!(settings["retry"]["maxRetries"], json!(5));
        set_nested_setting(&mut settings, &["retry", "maxRetries"], None).unwrap();
        set_nested_setting(&mut settings, &["retry", "enabled"], None).unwrap();
        assert!(settings.get("retry").is_none());
        assert_eq!(settings["theme"], json!("dark"));
    }

    #[test]
    fn subagent_transcript_surfaces_reasoning_and_tool_activity() {
        let path = env::temp_dir().join(format!(
            "lemonpi-activity-{}-designer_0_transcript.jsonl",
            std::process::id(),
        ));
        fs::write(
            &path,
            concat!(
                "{\"recordType\":\"message\",\"role\":\"assistant\",\"ts\":1000,\"message\":{\"content\":[{\"type\":\"thinking\",\"thinking\":\"Auditing the sidebar hierarchy and navigation states\"}]}}\n",
                "{\"recordType\":\"tool_start\",\"toolName\":\"read\",\"argsPreview\":\"src/components/WorkspaceRail.tsx\",\"ts\":2000}\n",
                "{\"recordType\":\"tool_end\",\"toolName\":\"read\",\"isError\":false,\"ts\":3000}\n",
                "{\"recordType\":\"message\",\"role\":\"toolResult\",\"toolName\":\"todo\",\"ts\":4000,\"message\":{\"role\":\"toolResult\",\"toolName\":\"todo\",\"details\":{\"tasks\":[{\"id\":1,\"subject\":\"Audit navigation\",\"activeForm\":\"auditing navigation\",\"status\":\"in_progress\"}],\"nextId\":2}}}\n",
            ),
        )
        .expect("write transcript fixture");

        let activity = read_subagent_activity(&path, "run:0".to_string());
        fs::remove_file(&path).expect("remove transcript fixture");

        assert_eq!(activity.events.len(), 3);
        assert_eq!(activity.events[0].kind, "reasoning");
        assert_eq!(
            activity.events[1].text,
            "read · src/components/WorkspaceRail.tsx"
        );
        assert_eq!(activity.headline.as_deref(), Some("Finished read"));
        assert_eq!(activity.last_activity_at, Some(3000));
        assert_eq!(activity.todos.as_ref().map(Vec::len), Some(1));
        assert_eq!(activity.todos.unwrap()[0].subject, "Audit navigation");
    }

    #[test]
    fn parses_lf_delimited_rpc_records() {
        let value = parse_rpc_record(b"{\"type\":\"agent_start\"}\n")
            .unwrap()
            .unwrap();
        assert_eq!(value["type"], "agent_start");
    }

    #[test]
    fn accepts_crlf_and_final_unterminated_records() {
        assert!(parse_rpc_record(b"{\"type\":\"agent_end\"}\r\n")
            .unwrap()
            .is_some());
        assert!(parse_rpc_record(b"{\"type\":\"agent_end\"}")
            .unwrap()
            .is_some());
    }

    #[test]
    fn does_not_split_unicode_line_separators() {
        let separator = '\u{2028}';
        let record = format!("{{\"message\":\"a{separator}b\"}}\n");
        let value = parse_rpc_record(record.as_bytes()).unwrap().unwrap();
        assert_eq!(value["message"].as_str(), Some("a\u{2028}b"));
    }

    #[test]
    fn frames_records_across_split_utf8_chunks() {
        let record = "{\"message\":\"hello 🧪\"}\n";
        let split = record.find('🧪').unwrap() + 1;
        let mut framer = JsonlFramer::new(1024);

        assert!(framer.push(&record.as_bytes()[..split]).is_empty());
        let output = framer.push(&record.as_bytes()[split..]);

        assert_eq!(output.len(), 1);
        assert_eq!(
            output[0].as_ref().unwrap().as_ref().unwrap()["message"],
            "hello 🧪"
        );
    }

    #[test]
    fn bounds_oversized_records_and_recovers_at_next_lf() {
        let mut framer = JsonlFramer::new(8);
        let output = framer.push(b"123456789012\n{\"ok\":1}\n");

        assert!(output[0].is_err());
        assert_eq!(output[1].as_ref().unwrap().as_ref().unwrap()["ok"], 1);
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(parse_rpc_record(b"not-json\n").is_err());
    }

    #[test]
    fn agent_frontmatter_updates_owned_model_fields() {
        let path = env::temp_dir().join(format!(
            "lemonpi-agent-test-{}-{}.md",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(
            &path,
            "---\nname: designer\nmodel: anthropic/old\ndescription: Design specialist\n---\n\nPrompt body.\n",
        )
        .unwrap();

        update_agent_frontmatter(&path, "model", Some("openai/gpt-next".to_string())).unwrap();
        update_agent_frontmatter(&path, "thinking", Some("high".to_string())).unwrap();
        let updated = fs::read_to_string(&path).unwrap();
        assert!(updated.contains("model: openai/gpt-next"));
        assert!(updated.contains("thinking: high"));
        assert!(updated.ends_with("Prompt body.\n"));

        update_agent_frontmatter(&path, "model", None).unwrap();
        assert!(!fs::read_to_string(&path).unwrap().contains("model:"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn subagent_override_updates_preserve_unrelated_settings() {
        let root = env::temp_dir().join(format!(
            "lemonpi-settings-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = root.join("settings.json");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            &path,
            r#"{
  "theme": "matte",
  "subagents": {
    "agentOverrides": {
      "reviewer": { "thinking": "high", "tools": ["read"] }
    }
  }
}"#,
        )
        .unwrap();

        update_subagent_override_file(
            &path,
            "reviewer",
            "model",
            Some("anthropic/claude-sonnet-5".to_string()),
        )
        .unwrap();
        let updated = read_settings_object(&path).unwrap();
        assert_eq!(updated["theme"], "matte");
        assert_eq!(
            updated["subagents"]["agentOverrides"]["reviewer"]["thinking"],
            "high"
        );
        assert_eq!(
            updated["subagents"]["agentOverrides"]["reviewer"]["tools"][0],
            "read"
        );
        assert_eq!(
            updated["subagents"]["agentOverrides"]["reviewer"]["model"],
            "anthropic/claude-sonnet-5"
        );

        update_subagent_override_file(&path, "reviewer", "model", None).unwrap();
        let reset = read_settings_object(&path).unwrap();
        assert!(reset["subagents"]["agentOverrides"]["reviewer"]
            .get("model")
            .is_none());
        assert_eq!(
            reset["subagents"]["agentOverrides"]["reviewer"]["thinking"],
            "high"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn summarizes_pi_session_files() {
        let root = env::temp_dir().join(format!(
            "lemonpi-session-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let project = project.canonicalize().unwrap();
        let session = root.join("session.jsonl");
        fs::write(
            &session,
            format!(
                "{{\"type\":\"session\",\"id\":\"session-1\",\"cwd\":{}}}\n\
                 {{\"type\":\"session_info\",\"name\":\"Readable name\"}}\n\
                 {{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"Fix the sidebar\"}}]}}}}\n\
                 {{\"type\":\"message\",\"message\":{{\"role\":\"assistant\",\"content\":\"Done\"}}}}\n",
                serde_json::to_string(&project.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();

        let summary = read_session_summary(&session, &project).unwrap();
        assert_eq!(summary.id, "session-1");
        assert_eq!(summary.name.as_deref(), Some("Readable name"));
        assert_eq!(summary.first_message, "Fix the sidebar");
        assert_eq!(summary.message_count, 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn identifies_anonymous_subagent_bootstrap_forks_without_hiding_real_fork_activity() {
        let root = env::temp_dir().join(format!(
            "lemonpi-subagent-fork-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let project = project.canonicalize().unwrap();
        let session = root.join("fork.jsonl");
        let records = format!(
            "{{\"type\":\"session\",\"id\":\"fork-1\",\"cwd\":{},\"parentSession\":\"/sessions/main.jsonl\"}}\n\
             {{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"Build the feature\"}}}}\n\
             {{\"type\":\"message\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"toolCall\",\"name\":\"subagent\",\"arguments\":{{\"tasks\":[{{\"agent\":\"worker\",\"task\":\"Implement it\"}}],\"context\":\"fork\",\"async\":true}}}}]}}}}\n\
             {{\"type\":\"custom\",\"customType\":\"lemonpi-mission-state\",\"data\":{{\"phase\":\"delegated\"}}}}\n",
            serde_json::to_string(&project.to_string_lossy()).unwrap()
        );
        fs::write(&session, &records).unwrap();

        assert!(
            read_session_summary(&session, &project)
                .unwrap()
                .anonymous_subagent_bootstrap
        );

        fs::write(
            &session,
            format!(
                "{records}{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"Continue this real fork\"}}}}\n"
            ),
        )
        .unwrap();
        assert!(
            !read_session_summary(&session, &project)
                .unwrap()
                .anonymous_subagent_bootstrap
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn summarizes_only_the_current_terminal_agent_reply() {
        let root = env::temp_dir().join(format!(
            "lemonpi-final-reply-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let project = project.canonicalize().unwrap();
        let session = root.join("session.jsonl");
        let records = format!(
            "{{\"type\":\"session\",\"id\":\"session-1\",\"cwd\":{}}}\n\
             {{\"type\":\"message\",\"id\":\"user-1\",\"message\":{{\"role\":\"user\",\"content\":\"Question\"}}}}\n\
             {{\"type\":\"message\",\"id\":\"tool-use\",\"message\":{{\"role\":\"assistant\",\"stopReason\":\"toolUse\",\"content\":\"Looking up an answer\"}}}}\n\
             {{\"type\":\"message\",\"id\":\"final-1\",\"message\":{{\"role\":\"assistant\",\"stopReason\":\"stop\",\"timestamp\":1234,\"content\":\"Answer\"}}}}\n",
            serde_json::to_string(&project.to_string_lossy()).unwrap()
        );
        fs::write(&session, &records).unwrap();

        let summary = read_session_summary(&session, &project).unwrap();
        let final_reply = summary.last_final_reply.expect("terminal reply metadata");
        assert_eq!(final_reply.timestamp.as_deref(), Some("1234"));
        assert_eq!(final_reply.marker, "timestamp:1234|id:final-1");

        fs::write(
            &session,
            format!(
                "{records}{{\"type\":\"message\",\"id\":\"user-2\",\"message\":{{\"role\":\"user\",\"content\":\"Follow-up\"}}}}\n"
            ),
        )
        .unwrap();
        assert!(read_session_summary(&session, &project)
            .unwrap()
            .last_final_reply
            .is_none());
        fs::remove_dir_all(root).unwrap();
    }
}
