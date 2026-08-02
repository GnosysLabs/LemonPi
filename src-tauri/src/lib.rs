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

const MAX_RPC_RECORD_BYTES: usize = 8 * 1024 * 1024;
const MAX_SESSION_FILES: usize = 250;
const STDERR_CHUNK_BYTES: usize = 8 * 1024;
const SUBAGENT_TRANSCRIPT_TAIL_BYTES: u64 = 384 * 1024;
const SUBAGENT_ACTIVITY_EVENTS: usize = 12;
const MAX_SETTINGS_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_AGENT_FILE_BYTES: u64 = 256 * 1024;

#[derive(Default)]
struct PiManager {
    registry: Mutex<PiRegistry>,
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
}

const CORE_SUBAGENT_PACKAGE: &str = "npm:pi-subagents";

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
struct PiSessionSummary {
    path: String,
    id: String,
    name: Option<String>,
    parent_session_path: Option<String>,
    modified: u64,
    message_count: usize,
    first_message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubagentActivityTarget {
    key: String,
    run_id: String,
    agent: String,
    index: usize,
    transcript_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SubagentActivityEvent {
    kind: &'static str,
    text: String,
    at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SubagentLiveActivity {
    key: String,
    headline: Option<String>,
    headline_kind: Option<&'static str>,
    last_activity_at: Option<u64>,
    events: Vec<SubagentActivityEvent>,
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

async fn run_pi_cli(
    executable: &PathBuf,
    cwd: &Path,
    args: &[&str],
) -> Result<String, String> {
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

fn is_core_subagent_source(source: &str) -> bool {
    npm_package_name(source) == Some("pi-subagents")
}

fn core_subagent_installed(agent_dir: &Path) -> bool {
    agent_dir
        .join("npm/node_modules/pi-subagents/package.json")
        .is_file()
}

async fn ensure_core_subagent_package(executable: &PathBuf) -> Result<(), String> {
    let agent_dir = pi_agent_dir()?;
    let settings = read_settings_object(&agent_dir.join("settings.json"))?;
    let configured = settings
        .get("packages")
        .and_then(Value::as_array)
        .is_some_and(|packages| {
            packages
                .iter()
                .filter_map(package_source)
                .any(is_core_subagent_source)
        });
    if configured && core_subagent_installed(&agent_dir) {
        return Ok(());
    }

    let cwd = home_dir()?;
    run_pi_cli(
        executable,
        &cwd,
        &["install", CORE_SUBAGENT_PACKAGE, "--no-approve"],
    )
    .await
    .map_err(|error| format!(
        "LemonPi requires pi-subagents and could not install it automatically: {error}"
    ))?;
    if !core_subagent_installed(&agent_dir) {
        return Err("Pi reported a successful pi-subagents install, but the package is unavailable.".to_string());
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
                    if first_message.is_empty()
                        && value
                            .get("message")
                            .and_then(|message| message.get("role"))
                            .and_then(Value::as_str)
                            == Some("user")
                    {
                        first_message = compact_session_label(&session_text(
                            value
                                .get("message")
                                .and_then(|message| message.get("content")),
                        ));
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
    Some(PiSessionSummary {
        path: path.to_string_lossy().into_owned(),
        id: id?,
        name,
        parent_session_path,
        modified,
        message_count,
        first_message: if first_message.is_empty() {
            "New session".to_string()
        } else {
            first_message
        },
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
            !session
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

fn forward_framed_result(result: Result<Option<Value>, String>, app: &AppHandle, pid: u32) {
    match result {
        Ok(Some(mut event)) => {
            if let Value::Object(fields) = &mut event {
                fields.insert("__piPid".to_string(), Value::from(pid));
            }
            let _ = app.emit("pi-event", event);
        }
        Ok(None) => {}
        Err(error) => emit_protocol_error(app, error),
    }
}

async fn forward_stdout<R>(mut reader: R, app: AppHandle, pid: u32)
where
    R: AsyncRead + Unpin,
{
    let mut chunk = vec![0; 16 * 1024];
    let mut framer = JsonlFramer::new(MAX_RPC_RECORD_BYTES);

    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => {
                if let Some(result) = framer.finish() {
                    forward_framed_result(result, &app, pid);
                }
                break;
            }
            Ok(count) => {
                for result in framer.push(&chunk[..count]) {
                    forward_framed_result(result, &app, pid);
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
    ensure_core_subagent_package(&executable).await?;
    let narration_extension = narration_extension_path(&app)?;
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

    let _ = app.emit(
        "pi-process-event",
        PiProcessEvent {
            state: "started",
            pid: Some(pid),
            code: None,
            message: None,
        },
    );

    tauri::async_runtime::spawn(forward_stdout(stdout, app.clone(), pid));
    tauri::async_runtime::spawn(forward_stderr(stderr, app.clone()));

    let manager_for_wait = Arc::clone(manager.inner());
    let app_for_wait = app.clone();
    let project_for_wait = cwd_path.clone();
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

        let _ = app_for_wait.emit(
            "pi-process-event",
            PiProcessEvent {
                state,
                pid: Some(pid),
                code,
                message,
            },
        );
    });

    Ok(info)
}

#[tauri::command]
async fn send_pi(manager: State<'_, Arc<PiManager>>, command: Value) -> Result<(), String> {
    if !command.is_object() || command.get("type").and_then(Value::as_str).is_none() {
        return Err("RPC commands must be JSON objects with a string type.".to_string());
    }

    let mut payload = serde_json::to_vec(&command)
        .map_err(|error| format!("Could not encode RPC command: {error}"))?;
    if payload.len() > MAX_RPC_RECORD_BYTES {
        return Err("RPC command is too large.".to_string());
    }
    payload.push(b'\n');

    let stdin = {
        let registry = manager.registry.lock().await;
        registry
            .active_project
            .as_ref()
            .and_then(|project| registry.processes.get(project))
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

fn read_subagent_activity(path: &Path, key: String) -> SubagentLiveActivity {
    let mut events = Vec::new();
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
            let at = record.get("ts").and_then(Value::as_u64).unwrap_or_default();
            match record.get("recordType").and_then(Value::as_str) {
                Some("tool_start") => {
                    let tool = record
                        .get("toolName")
                        .and_then(Value::as_str)
                        .unwrap_or("tool");
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
                resolve_subagent_transcript(&project, &target)
                    .map(|path| read_subagent_activity(&path, key.clone()))
                    .unwrap_or(SubagentLiveActivity {
                        key,
                        headline: None,
                        headline_kind: None,
                        last_activity_at: None,
                        events: Vec::new(),
                    })
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
    })
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
        Ok(project_settings_path(project.expect("validated project scope")))
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
        let mut effective = Value::Object(read_settings_object(&pi_agent_dir()?.join("settings.json"))?);
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
                && segment
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
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
            let installed = location.as_deref().is_some_and(|path| Path::new(path).exists())
                || (scope == "user" && is_core_subagent_source(&source) && core_subagent_installed(&agent_dir));
            packages.push(PiPackageInfo {
                required: is_core_subagent_source(&source),
                source,
                scope: scope.to_string(),
                location,
                installed,
            });
        }
    }
    packages.sort_by(|left, right| left.scope.cmp(&right.scope).then_with(|| left.source.cmp(&right.source)));
    Ok(PiPackagesSnapshot {
        core_ready: packages.iter().any(|package| package.required && package.installed),
        packages,
    })
}

#[tauri::command]
async fn get_pi_packages(
    manager: State<'_, Arc<PiManager>>,
) -> Result<PiPackagesSnapshot, String> {
    let (project, trusted) = {
        let registry = manager.inner().registry.lock().await;
        (registry.active_project.clone(), registry.active_trusted.unwrap_or(false))
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
        if action == "remove" && is_core_subagent_source(source) {
            return Err("pi-subagents is a required LemonPi package and cannot be removed.".to_string());
        }
    } else if action != "update" {
        return Err("Choose a package source.".to_string());
    }
    if !matches!(scope.as_str(), "user" | "project") {
        return Err("Package scope must be 'user' or 'project'.".to_string());
    }

    let (project, trusted) = {
        let registry = manager.inner().registry.lock().await;
        (registry.active_project.clone(), registry.active_trusted.unwrap_or(false))
    };
    if scope == "project" && project.is_none() {
        return Err("Open a project before managing project packages.".to_string());
    }
    if scope == "project" && !trusted {
        return Err("Trust this project before installing or changing project packages.".to_string());
    }

    let executable = find_pi()?;
    let cwd = project.as_deref().map(Path::to_path_buf).unwrap_or(home_dir()?);
    let trust_arg = if scope == "project" { "--approve" } else { "--no-approve" };
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
            Some("running" | "queued" | "paused") => 0,
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
async fn stop_pi(manager: State<'_, Arc<PiManager>>) -> Result<(), String> {
    stop_active(manager.inner()).await;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(PiManager::default()))
        .invoke_handler(tauri::generate_handler![
            detect_pi,
            start_pi,
            send_pi,
            list_pi_sessions,
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
    fn recognizes_versioned_core_subagent_packages() {
        assert!(is_core_subagent_source("npm:pi-subagents"));
        assert!(is_core_subagent_source("npm:pi-subagents@1.2.3"));
        assert!(!is_core_subagent_source("npm:pi-subagents-extra"));
        assert_eq!(npm_package_name("npm:@scope/tools@2.0.0"), Some("@scope/tools"));
    }

    #[test]
    fn nested_setting_updates_preserve_siblings_and_clean_empty_objects() {
        let mut settings = serde_json::Map::from_iter([
            ("theme".to_string(), json!("dark")),
            ("retry".to_string(), json!({ "enabled": true, "maxRetries": 3 })),
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
}
