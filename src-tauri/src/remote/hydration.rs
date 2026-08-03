//! Crate-private, non-serializable state and transcript hydration foundations.
//!
//! Live state is replaced only by a fully validated `get_state` response. The repository has no
//! known compaction start/end Pi events, so `is_compacting` intentionally remains authoritative
//! from `get_state`; only the exact `agent_start` and `agent_settled` events adjust live streaming
//! state between snapshots.

use super::protocol::SafeMessage;
use crate::session_directory;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File, Metadata},
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use time::{
    format_description::well_known::Rfc3339, Date, Month, OffsetDateTime, PrimitiveDateTime, Time,
};

pub(crate) const MAX_TRANSCRIPT_FILE_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const MAX_TRANSCRIPT_RECORD_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_PROJECTED_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_MESSAGE_TEXT_SCALARS: usize = 16 * 1024;
const MAX_MESSAGE_THINKING_SCALARS: usize = 16 * 1024;
const MAX_SESSION_NAME_SCALARS: usize = 160;
const MAX_TOOL_NAME_SCALARS: usize = 160;
const READ_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl ThinkingLevel {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "off" => Some(Self::Off),
            "minimal" => Some(Self::Minimal),
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            "xhigh" => Some(Self::Xhigh),
            "max" => Some(Self::Max),
            _ => None,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

/// A validated process-local state projection. It deliberately has no serializer and retains no
/// Pi session ID, response correlation, model/settings/tool data, tokens, errors, or arbitrary
/// response members.
#[derive(Clone, Eq, PartialEq)]
pub(crate) struct SafeLiveState {
    pub(crate) session_file: Option<PathBuf>,
    pub(crate) session_name: Option<String>,
    pub(crate) is_streaming: bool,
    pub(crate) is_compacting: bool,
    pub(crate) thinking_level: ThinkingLevel,
    pub(crate) message_count: u64,
    pub(crate) pending_message_count: u64,
}

/// Cheap cloneable state cache keyed only by canonical project paths. Lock hold times are limited
/// to one map lookup/update; filesystem and JSON validation happens before acquiring the lock.
#[derive(Clone)]
struct GenerationState {
    generation: u64,
    state: SafeLiveState,
}

#[derive(Clone, Default)]
pub(crate) struct SafeLiveStateCache {
    inner: Arc<Mutex<HashMap<PathBuf, GenerationState>>>,
}

impl SafeLiveStateCache {
    pub(crate) fn observe(&self, project: &Path, event: &Value) {
        self.observe_generation(project, 0, event);
    }

    /// Associates process output with its exact manager generation. A late response can never
    /// replace a snapshot already observed from a newer generation.
    pub(crate) fn observe_generation(&self, project: &Path, generation: u64, event: &Value) {
        let Some(project) = canonical_project(project) else {
            return;
        };
        match event.get("type").and_then(Value::as_str) {
            Some("response")
                if event.get("command").and_then(Value::as_str) == Some("get_state")
                    && event.get("success").and_then(Value::as_bool) == Some(true) =>
            {
                let Some(candidate) = state_candidate(&project, event) else {
                    return;
                };
                let mut snapshots = self.lock();
                if snapshots
                    .get(&project)
                    .is_some_and(|existing| existing.generation > generation)
                {
                    return;
                }
                snapshots.insert(
                    project,
                    GenerationState {
                        generation,
                        state: candidate,
                    },
                );
            }
            Some("agent_start") => {
                if let Some(snapshot) = self
                    .lock()
                    .get_mut(&project)
                    .filter(|snapshot| snapshot.generation == generation)
                {
                    snapshot.state.is_streaming = true;
                }
            }
            Some("agent_settled") => {
                if let Some(snapshot) = self
                    .lock()
                    .get_mut(&project)
                    .filter(|snapshot| snapshot.generation == generation)
                {
                    snapshot.state.is_streaming = false;
                }
            }
            _ => {}
        }
    }

    pub(crate) fn clear(&self, project: &Path) {
        let canonical = canonical_project(project);
        let mut snapshots = self.lock();
        snapshots.remove(project);
        if let Some(canonical) = canonical {
            snapshots.remove(&canonical);
        }
    }

    pub(crate) fn snapshot(&self, project: &Path) -> Option<SafeLiveState> {
        let project = canonical_project(project)?;
        self.snapshot_canonical(&project)
    }

    /// Looks up a caller-revalidated canonical project without performing filesystem work. The
    /// manager uses this while holding its process registry lock so generation and cache state are
    /// observed at one point in time.
    pub(crate) fn snapshot_canonical(&self, project: &Path) -> Option<SafeLiveState> {
        self.lock()
            .get(project)
            .map(|snapshot| snapshot.state.clone())
    }

    pub(crate) fn snapshot_generation_canonical(
        &self,
        project: &Path,
        generation: u64,
    ) -> Option<SafeLiveState> {
        self.lock()
            .get(project)
            .filter(|snapshot| snapshot.generation == generation)
            .map(|snapshot| snapshot.state.clone())
    }

    #[cfg(test)]
    fn contains_exact_key(&self, project: &Path) -> bool {
        self.lock().contains_key(project)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, GenerationState>> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn state_candidate(project: &Path, event: &Value) -> Option<SafeLiveState> {
    let data = event.get("data")?.as_object()?;
    let is_streaming = data.get("isStreaming")?.as_bool()?;
    let is_compacting = data.get("isCompacting")?.as_bool()?;
    let thinking_level = ThinkingLevel::parse(data.get("thinkingLevel")?.as_str()?)?;
    let message_count = data.get("messageCount")?.as_u64()?;
    let pending_message_count = data.get("pendingMessageCount")?.as_u64()?;

    let context = match data.get("sessionFile") {
        None | Some(Value::Null) => None,
        Some(Value::String(path)) => {
            Some(validate_session_context(project, Path::new(path), false).ok()?)
        }
        Some(_) => return None,
    };

    let mut secrets = vec![project.to_string_lossy().into_owned()];
    if let Ok(directory) = derived_session_directory(project) {
        secrets.push(directory.to_string_lossy().into_owned());
        if let Ok(directory) = directory.canonicalize() {
            secrets.push(directory.to_string_lossy().into_owned());
        }
    }
    if let Some(raw_session_id) = data.get("sessionId").and_then(Value::as_str) {
        secrets.push(raw_session_id.to_string());
    }
    if let Some(context) = &context {
        secrets.extend(context.secrets.iter().cloned());
    }
    let sanitizer = TextSanitizer::new(secrets);
    let session_name = match data.get("sessionName") {
        None | Some(Value::Null) => None,
        Some(Value::String(name)) => sanitizer.sanitize(name, MAX_SESSION_NAME_SCALARS),
        Some(_) => return None,
    };

    Some(SafeLiveState {
        session_file: context.map(|context| context.path),
        session_name,
        is_streaming,
        is_compacting,
        thinking_level,
        message_count,
        pending_message_count,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HydrationError {
    InvalidLimit,
    InvalidProject,
    InvalidSession,
    InvalidHeader,
    CwdMismatch,
    FileTooLarge,
    RecordTooLarge,
    MalformedRecord,
    ResponseTooLarge,
    FileChanged,
    Io,
}

/// Streams and safely projects one canonical Pi session transcript. This synchronous function is
/// intended to be called by a future endpoint from `spawn_blocking`.
pub(crate) fn project_transcript(
    project: &Path,
    session_file: &Path,
    session_id: &str,
    limit: usize,
) -> Result<Vec<SafeMessage>, HydrationError> {
    if !(1..=200).contains(&limit) {
        return Err(HydrationError::InvalidLimit);
    }
    let project = require_canonical_project(project)?;
    let context = validate_session_context(&project, session_file, true)?;
    let initial_metadata = fs::metadata(&context.path).map_err(|_| HydrationError::Io)?;
    if initial_metadata.len() > MAX_TRANSCRIPT_FILE_BYTES {
        return Err(HydrationError::FileTooLarge);
    }

    let mut secrets = context.secrets.clone();
    secrets.push(session_id.to_string());
    // A transcript can quote an identifier emitted by a different record. Collect every
    // identifier in the bounded file before projecting any text so the projection never depends
    // on record order.
    secrets.extend(collect_transcript_id_secrets(
        &context.path,
        &initial_metadata,
    )?);
    let base_sanitizer = TextSanitizer::new(secrets);

    let mut file = File::open(&context.path).map_err(|_| HydrationError::Io)?;
    let opened_metadata = file.metadata().map_err(|_| HydrationError::Io)?;
    if !opened_metadata.is_file() || !same_file(&initial_metadata, &opened_metadata) {
        return Err(HydrationError::FileChanged);
    }
    let mut projected = VecDeque::<PendingMessage>::new();
    let mut pending_tools = HashMap::<String, String>::new();
    let mut record = Vec::new();
    let mut chunk = vec![0_u8; READ_CHUNK_BYTES];
    let mut total_bytes = 0_u64;
    let mut record_ordinal = 0_u64;
    let mut header_seen = false;

    loop {
        let count = file.read(&mut chunk).map_err(|_| HydrationError::Io)?;
        if count == 0 {
            break;
        }
        total_bytes = total_bytes
            .checked_add(count as u64)
            .ok_or(HydrationError::FileTooLarge)?;
        if total_bytes > MAX_TRANSCRIPT_FILE_BYTES {
            return Err(HydrationError::FileTooLarge);
        }
        for &byte in &chunk[..count] {
            if byte == b'\n' {
                consume_transcript_record(
                    &record,
                    record_ordinal,
                    &project,
                    session_id,
                    limit,
                    &base_sanitizer,
                    &mut header_seen,
                    &mut projected,
                    &mut pending_tools,
                )?;
                record.clear();
                record_ordinal = record_ordinal
                    .checked_add(1)
                    .ok_or(HydrationError::FileTooLarge)?;
            } else {
                if record.len() == MAX_TRANSCRIPT_RECORD_BYTES {
                    return Err(HydrationError::RecordTooLarge);
                }
                record.push(byte);
            }
        }
    }
    if !record.is_empty() {
        consume_transcript_record(
            &record,
            record_ordinal,
            &project,
            session_id,
            limit,
            &base_sanitizer,
            &mut header_seen,
            &mut projected,
            &mut pending_tools,
        )?;
    }
    if !header_seen {
        return Err(HydrationError::InvalidHeader);
    }

    revalidate_session_file(&context.path, &initial_metadata)?;
    let fresh_directory = canonical_session_directory(&project)?;
    if !context.path.starts_with(&fresh_directory) {
        return Err(HydrationError::FileChanged);
    }

    if serialized_response_bytes(&projected)? > MAX_PROJECTED_RESPONSE_BYTES {
        return Err(HydrationError::ResponseTooLarge);
    }
    Ok(projected.into_iter().map(|message| message.safe).collect())
}

struct PendingMessage {
    safe: SafeMessage,
    tool_call_id: Option<String>,
}

#[allow(clippy::too_many_arguments)]
fn consume_transcript_record(
    bytes: &[u8],
    record_ordinal: u64,
    project: &Path,
    session_id: &str,
    limit: usize,
    base_sanitizer: &TextSanitizer,
    header_seen: &mut bool,
    projected: &mut VecDeque<PendingMessage>,
    pending_tools: &mut HashMap<String, String>,
) -> Result<(), HydrationError> {
    let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
    if bytes.is_empty() {
        return Ok(());
    }
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| HydrationError::MalformedRecord)?;
    let object = value.as_object().ok_or(HydrationError::MalformedRecord)?;
    let record_type = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or(HydrationError::MalformedRecord)?;

    if !*header_seen {
        if record_type != "session" {
            return Err(HydrationError::InvalidHeader);
        }
        let cwd = object
            .get("cwd")
            .and_then(Value::as_str)
            .ok_or(HydrationError::InvalidHeader)?;
        if canonical_existing_directory(Path::new(cwd)).as_deref() != Some(project) {
            return Err(HydrationError::CwdMismatch);
        }
        *header_seen = true;
        return Ok(());
    }

    if record_type != "message" {
        return Ok(());
    }
    let message = object
        .get("message")
        .and_then(Value::as_object)
        .ok_or(HydrationError::MalformedRecord)?;
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .ok_or(HydrationError::MalformedRecord)?;
    let Some(timestamp) = normalized_record_timestamp(object, message) else {
        return Ok(());
    };

    let mut record_secrets = Vec::new();
    collect_scalar_secret(object.get("id"), &mut record_secrets);
    collect_scalar_secret(message.get("id"), &mut record_secrets);
    collect_scalar_secret(message.get("toolCallId"), &mut record_secrets);
    if let Some(parts) = message.get("content").and_then(Value::as_array) {
        for part in parts {
            if part.get("type").and_then(Value::as_str) == Some("toolCall") {
                collect_scalar_secret(part.get("id"), &mut record_secrets);
            }
        }
    }
    let sanitizer = base_sanitizer.with_additional(record_secrets);

    match role {
        "user" => {
            let text = display_content(message.get("content"));
            let text = sanitizer
                .sanitize(&strip_attachment_wrappers(&text), MAX_MESSAGE_TEXT_SCALARS)
                .unwrap_or_default();
            push_projected(
                projected,
                pending_tools,
                limit,
                PendingMessage {
                    safe: SafeMessage {
                        message_id: opaque_message_id(session_id, record_ordinal, 0),
                        role: "user".to_string(),
                        text,
                        thinking: None,
                        is_error: Some(false),
                        timestamp,
                        tool_name: None,
                        tool_status: None,
                    },
                    tool_call_id: None,
                },
            );
        }
        "assistant" => {
            let text = display_content(message.get("content"));
            let text = sanitizer
                .sanitize(&strip_attachment_wrappers(&text), MAX_MESSAGE_TEXT_SCALARS)
                .unwrap_or_default();
            let thinking = thinking_content(message.get("content")).and_then(|thinking| {
                sanitizer.sanitize(
                    &strip_attachment_wrappers(&thinking),
                    MAX_MESSAGE_THINKING_SCALARS,
                )
            });
            push_projected(
                projected,
                pending_tools,
                limit,
                PendingMessage {
                    safe: SafeMessage {
                        message_id: opaque_message_id(session_id, record_ordinal, 0),
                        role: "assistant".to_string(),
                        text,
                        thinking,
                        is_error: Some(
                            message.get("stopReason").and_then(Value::as_str) == Some("error"),
                        ),
                        timestamp: timestamp.clone(),
                        tool_name: None,
                        tool_status: None,
                    },
                    tool_call_id: None,
                },
            );

            if let Some(parts) = message.get("content").and_then(Value::as_array) {
                for (part_index, part) in parts.iter().enumerate() {
                    if part.get("type").and_then(Value::as_str) != Some("toolCall") {
                        continue;
                    }
                    let Some(tool_call_id) = part.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some(raw_name) = part.get("name").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some(tool_name) = sanitizer.sanitize(raw_name, MAX_TOOL_NAME_SCALARS)
                    else {
                        continue;
                    };
                    let subrecord_ordinal = u64::try_from(part_index)
                        .ok()
                        .and_then(|index| index.checked_add(1))
                        .ok_or(HydrationError::MalformedRecord)?;
                    push_projected(
                        projected,
                        pending_tools,
                        limit,
                        PendingMessage {
                            safe: SafeMessage {
                                message_id: opaque_message_id(
                                    session_id,
                                    record_ordinal,
                                    subrecord_ordinal,
                                ),
                                role: "tool".to_string(),
                                text: String::new(),
                                thinking: None,
                                is_error: Some(false),
                                timestamp: timestamp.clone(),
                                tool_name: Some(tool_name),
                                tool_status: Some("queued".to_string()),
                            },
                            tool_call_id: Some(tool_call_id.to_string()),
                        },
                    );
                }
            }
        }
        "toolResult" => {
            let Some(tool_call_id) = message.get("toolCallId").and_then(Value::as_str) else {
                return Ok(());
            };
            let Some(message_id) = pending_tools.remove(tool_call_id) else {
                return Ok(());
            };
            if let Some(tool) = projected
                .iter_mut()
                .find(|candidate| candidate.safe.message_id == message_id)
            {
                let is_error = message.get("isError").and_then(Value::as_bool) == Some(true);
                tool.safe.is_error = Some(is_error);
                tool.safe.tool_status =
                    Some(if is_error { "error" } else { "complete" }.to_string());
                tool.tool_call_id = None;
            }
        }
        _ => {}
    }
    Ok(())
}

fn push_projected(
    projected: &mut VecDeque<PendingMessage>,
    pending_tools: &mut HashMap<String, String>,
    limit: usize,
    message: PendingMessage,
) {
    if let Some(tool_call_id) = &message.tool_call_id {
        pending_tools.insert(tool_call_id.clone(), message.safe.message_id.clone());
    }
    projected.push_back(message);
    while projected.len() > limit {
        let Some(removed) = projected.pop_front() else {
            break;
        };
        if let Some(tool_call_id) = removed.tool_call_id {
            if pending_tools.get(&tool_call_id) == Some(&removed.safe.message_id) {
                pending_tools.remove(&tool_call_id);
            }
        }
    }
}

fn serialized_response_bytes(messages: &VecDeque<PendingMessage>) -> Result<usize, HydrationError> {
    let mut total = 2_usize;
    for (index, message) in messages.iter().enumerate() {
        if index > 0 {
            total = total
                .checked_add(1)
                .ok_or(HydrationError::ResponseTooLarge)?;
        }
        let bytes = serde_json::to_vec(&message.safe)
            .map_err(|_| HydrationError::ResponseTooLarge)?
            .len();
        total = total
            .checked_add(bytes)
            .ok_or(HydrationError::ResponseTooLarge)?;
    }
    Ok(total)
}

fn opaque_message_id(session_id: &str, record_ordinal: u64, subrecord_ordinal: u64) -> String {
    let mut digest = Sha256::new();
    digest.update(b"lemonpi-remote-message-v1\0");
    digest.update((session_id.len() as u64).to_be_bytes());
    digest.update(session_id.as_bytes());
    digest.update(record_ordinal.to_be_bytes());
    digest.update(subrecord_ordinal.to_be_bytes());
    let digest = digest.finalize();
    format!("message_{}", URL_SAFE_NO_PAD.encode(&digest[..18]))
}

fn display_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn thinking_content(content: Option<&Value>) -> Option<String> {
    let thinking = content?
        .as_array()?
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("thinking"))
        .filter_map(|part| part.get("thinking").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    (!thinking.is_empty()).then_some(thinking)
}

fn strip_attachment_wrappers(value: &str) -> String {
    const OPEN: &str = "<lemonpi-attachment";
    const CLOSE: &str = "</lemonpi-attachment>";
    let mut remaining = value;
    let mut output = String::with_capacity(value.len().min(MAX_MESSAGE_TEXT_SCALARS));
    while let Some(start) = remaining.find(OPEN) {
        output.push_str(&remaining[..start]);
        let wrapper = &remaining[start..];
        let Some(tag_end) = wrapper.find('>') else {
            remaining = "";
            break;
        };
        let opening = &wrapper[..=tag_end];
        if opening.trim_end().ends_with("/>") {
            remaining = &wrapper[tag_end + 1..];
            continue;
        }
        let after_open = &wrapper[tag_end + 1..];
        let Some(close) = after_open.find(CLOSE) else {
            remaining = "";
            break;
        };
        remaining = &after_open[close + CLOSE.len()..];
    }
    output.push_str(remaining);
    output
}

#[derive(Clone)]
struct TextSanitizer {
    secrets: Vec<String>,
}

impl TextSanitizer {
    fn new(mut secrets: Vec<String>) -> Self {
        secrets.retain(|secret| !secret.is_empty());
        secrets.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
        secrets.dedup();
        Self { secrets }
    }

    fn with_additional(&self, additional: Vec<String>) -> Self {
        let mut secrets = self.secrets.clone();
        secrets.extend(additional);
        Self::new(secrets)
    }

    fn sanitize(&self, value: &str, limit: usize) -> Option<String> {
        let mut redacted = value.to_string();
        for secret in &self.secrets {
            redacted = redacted.replace(secret, "[redacted]");
        }
        let printable = redacted
            .chars()
            .map(|character| {
                if character.is_control() {
                    ' '
                } else {
                    character
                }
            })
            .collect::<String>();
        let compact = redact_embedded_sensitive_text(&printable)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if compact.is_empty() {
            return None;
        }
        Some(compact.chars().take(limit).collect())
    }
}

/// Applies the transcript boundary's fail-closed text projection to bounded catalogue labels and
/// previews as well as hydrated messages.
pub(crate) fn sanitize_wire_text(value: &str, secrets: &[String], limit: usize) -> Option<String> {
    TextSanitizer::new(secrets.to_vec()).sanitize(value, limit)
}

fn redact_embedded_sensitive_text(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = String::with_capacity(value.len());
    let mut copied = 0;
    let mut index = 0;
    while index < bytes.len() {
        let span = sensitive_text_span(bytes, index);
        if let Some((start, end)) = span {
            output.push_str(&value[copied..start]);
            output.push_str("[redacted]");
            copied = end;
            index = end;
        } else {
            index += 1;
        }
    }
    output.push_str(&value[copied..]);
    output
}

fn sensitive_text_span(bytes: &[u8], index: usize) -> Option<(usize, usize)> {
    if starts_ascii_case_insensitive(bytes, index, b"file://") {
        return Some((index, sensitive_path_end(bytes, index)));
    }
    if bytes[index] == b'/' && path_boundary(bytes, index) {
        return Some((index, sensitive_path_end(bytes, index)));
    }
    if bytes[index] == b'~'
        && path_boundary(bytes, index)
        && matches!(bytes.get(index + 1), Some(b'/' | b'\\'))
    {
        return Some((index, sensitive_path_end(bytes, index)));
    }
    if bytes[index] == b'\\' && bytes.get(index + 1) == Some(&b'\\') && path_boundary(bytes, index)
    {
        return Some((index, sensitive_path_end(bytes, index)));
    }
    if bytes[index].is_ascii_alphabetic()
        && bytes.get(index + 1) == Some(&b':')
        && matches!(bytes.get(index + 2), Some(b'/' | b'\\'))
        && path_boundary(bytes, index)
    {
        return Some((index, sensitive_path_end(bytes, index)));
    }
    if starts_ascii_case_insensitive(bytes, index, b"bearer")
        && path_boundary(bytes, index)
        && bytes
            .get(index + b"bearer".len())
            .is_some_and(u8::is_ascii_whitespace)
    {
        let mut token = index + b"bearer".len();
        while bytes.get(token).is_some_and(u8::is_ascii_whitespace) {
            token += 1;
        }
        if token < bytes.len() {
            return Some((token, bearer_value_end(bytes, token)));
        }
    }
    if is_token_byte(bytes[index]) && (index == 0 || !is_token_byte(bytes[index - 1])) {
        let end = sensitive_token_end(bytes, index);
        if looks_like_issued_token(&bytes[index..end]) {
            return Some((index, end));
        }
    }
    None
}

fn starts_ascii_case_insensitive(bytes: &[u8], index: usize, expected: &[u8]) -> bool {
    bytes
        .get(index..index.saturating_add(expected.len()))
        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(expected))
}

fn path_boundary(bytes: &[u8], index: usize) -> bool {
    index == 0
        || !matches!(
            bytes[index - 1],
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'-' | b'.'
        )
}

fn sensitive_path_end(bytes: &[u8], mut index: usize) -> usize {
    while bytes.get(index).is_some_and(|byte| {
        !byte.is_ascii_whitespace()
            && !matches!(
                byte,
                b'\''
                    | b'"'
                    | b'`'
                    | b'('
                    | b')'
                    | b'['
                    | b']'
                    | b'{'
                    | b'}'
                    | b'<'
                    | b'>'
                    | b','
                    | b';'
            )
    }) {
        index += 1;
    }
    index
}

fn is_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
}

fn sensitive_token_end(bytes: &[u8], mut index: usize) -> usize {
    while bytes.get(index).is_some_and(|byte| is_token_byte(*byte)) {
        index += 1;
    }
    index
}

fn bearer_value_end(bytes: &[u8], mut index: usize) -> usize {
    while bytes.get(index).is_some_and(|byte| {
        !byte.is_ascii_whitespace()
            && !matches!(
                byte,
                b'\'' | b'"' | b'`' | b'(' | b')' | b'[' | b']' | b'{' | b'}' | b'<' | b'>'
            )
    }) {
        index += 1;
    }
    index
}

fn looks_like_issued_token(value: &[u8]) -> bool {
    // The issued device token is unpadded base64url and 43 bytes long, but accept any long
    // base64url-shaped run so an unrecognized bearer-shaped secret fails closed.
    value.len() >= 32
}

fn collect_transcript_id_secrets(
    path: &Path,
    initial_metadata: &Metadata,
) -> Result<Vec<String>, HydrationError> {
    let mut file = File::open(path).map_err(|_| HydrationError::Io)?;
    let opened = file.metadata().map_err(|_| HydrationError::Io)?;
    if !opened.is_file() || !same_file(initial_metadata, &opened) {
        return Err(HydrationError::FileChanged);
    }

    let mut secrets = Vec::new();
    let mut record = Vec::new();
    let mut chunk = vec![0_u8; READ_CHUNK_BYTES];
    let mut total_bytes = 0_u64;
    loop {
        let count = file.read(&mut chunk).map_err(|_| HydrationError::Io)?;
        if count == 0 {
            break;
        }
        total_bytes = total_bytes
            .checked_add(count as u64)
            .ok_or(HydrationError::FileTooLarge)?;
        if total_bytes > MAX_TRANSCRIPT_FILE_BYTES {
            return Err(HydrationError::FileTooLarge);
        }
        for &byte in &chunk[..count] {
            if byte == b'\n' {
                collect_record_id_secrets(&record, &mut secrets)?;
                record.clear();
            } else {
                if record.len() == MAX_TRANSCRIPT_RECORD_BYTES {
                    return Err(HydrationError::RecordTooLarge);
                }
                record.push(byte);
            }
        }
    }
    if !record.is_empty() {
        collect_record_id_secrets(&record, &mut secrets)?;
    }
    revalidate_session_file(path, initial_metadata)?;
    Ok(secrets)
}

fn collect_record_id_secrets(
    bytes: &[u8],
    secrets: &mut Vec<String>,
) -> Result<(), HydrationError> {
    let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
    if bytes.is_empty() {
        return Ok(());
    }
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| HydrationError::MalformedRecord)?;
    value.as_object().ok_or(HydrationError::MalformedRecord)?;
    collect_identifier_values(&value, secrets);
    Ok(())
}

fn collect_identifier_values(value: &Value, secrets: &mut Vec<String>) {
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                if key == "id" || key == "parentSession" || key.ends_with("Id") {
                    collect_scalar_secret(Some(value), secrets);
                }
                collect_identifier_values(value, secrets);
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_identifier_values(value, secrets);
            }
        }
        _ => {}
    }
}

struct SessionContext {
    path: PathBuf,
    secrets: Vec<String>,
}

fn validate_session_context(
    project: &Path,
    supplied_session: &Path,
    require_canonical_session: bool,
) -> Result<SessionContext, HydrationError> {
    if !supplied_session.is_absolute() {
        return Err(HydrationError::InvalidSession);
    }
    let link_metadata =
        fs::symlink_metadata(supplied_session).map_err(|_| HydrationError::InvalidSession)?;
    if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
        return Err(HydrationError::InvalidSession);
    }
    let path = supplied_session
        .canonicalize()
        .map_err(|_| HydrationError::InvalidSession)?;
    if require_canonical_session && path != supplied_session {
        return Err(HydrationError::InvalidSession);
    }
    let directory = canonical_session_directory(project)?;
    if path == directory || !path.starts_with(&directory) {
        return Err(HydrationError::InvalidSession);
    }

    let initial_metadata = fs::metadata(&path).map_err(|_| HydrationError::InvalidSession)?;
    let mut file = File::open(&path).map_err(|_| HydrationError::InvalidSession)?;
    let opened_metadata = file
        .metadata()
        .map_err(|_| HydrationError::InvalidSession)?;
    if !same_file(&initial_metadata, &opened_metadata) {
        return Err(HydrationError::FileChanged);
    }
    let header = read_first_record(&mut file)?;
    let header: Value =
        serde_json::from_slice(&header).map_err(|_| HydrationError::InvalidHeader)?;
    let header = header.as_object().ok_or(HydrationError::InvalidHeader)?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return Err(HydrationError::InvalidHeader);
    }
    let cwd = header
        .get("cwd")
        .and_then(Value::as_str)
        .ok_or(HydrationError::InvalidHeader)?;
    if canonical_existing_directory(Path::new(cwd)).as_deref() != Some(project) {
        return Err(HydrationError::CwdMismatch);
    }
    revalidate_session_file(&path, &initial_metadata)?;

    let mut secrets = vec![
        project.to_string_lossy().into_owned(),
        directory.to_string_lossy().into_owned(),
        path.to_string_lossy().into_owned(),
        cwd.to_string(),
    ];
    collect_scalar_secret(header.get("id"), &mut secrets);
    collect_scalar_secret(header.get("parentSession"), &mut secrets);
    Ok(SessionContext { path, secrets })
}

fn read_first_record(file: &mut File) -> Result<Vec<u8>, HydrationError> {
    let mut record = Vec::new();
    let mut chunk = [0_u8; 8 * 1024];
    loop {
        let count = file.read(&mut chunk).map_err(|_| HydrationError::Io)?;
        if count == 0 {
            break;
        }
        for &byte in &chunk[..count] {
            if byte == b'\n' {
                let candidate = record.strip_suffix(b"\r").unwrap_or(&record);
                if candidate.is_empty() {
                    record.clear();
                    continue;
                }
                return Ok(candidate.to_vec());
            }
            if record.len() == MAX_TRANSCRIPT_RECORD_BYTES {
                return Err(HydrationError::RecordTooLarge);
            }
            record.push(byte);
        }
    }
    let record = record.strip_suffix(b"\r").unwrap_or(&record).to_vec();
    if record.is_empty() {
        Err(HydrationError::InvalidHeader)
    } else {
        Ok(record)
    }
}

fn canonical_project(project: &Path) -> Option<PathBuf> {
    canonical_existing_directory(project)
}

fn require_canonical_project(project: &Path) -> Result<PathBuf, HydrationError> {
    let link_metadata =
        fs::symlink_metadata(project).map_err(|_| HydrationError::InvalidProject)?;
    if link_metadata.file_type().is_symlink() || !link_metadata.is_dir() {
        return Err(HydrationError::InvalidProject);
    }
    let canonical = canonical_existing_directory(project).ok_or(HydrationError::InvalidProject)?;
    if canonical != project {
        return Err(HydrationError::InvalidProject);
    }
    Ok(canonical)
}

fn canonical_existing_directory(path: &Path) -> Option<PathBuf> {
    let canonical = path.canonicalize().ok()?;
    canonical.is_dir().then_some(canonical)
}

fn canonical_session_directory(project: &Path) -> Result<PathBuf, HydrationError> {
    let directory =
        derived_session_directory(project).map_err(|_| HydrationError::InvalidSession)?;
    let link_metadata =
        fs::symlink_metadata(&directory).map_err(|_| HydrationError::InvalidSession)?;
    if !link_metadata.is_dir() {
        return Err(HydrationError::InvalidSession);
    }
    directory
        .canonicalize()
        .map_err(|_| HydrationError::InvalidSession)
}

fn derived_session_directory(project: &Path) -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(directory) = TEST_SESSION_DIRECTORY.with(|value| value.borrow().clone()) {
        return Ok(directory);
    }
    session_directory(project)
}

fn revalidate_session_file(path: &Path, initial: &Metadata) -> Result<(), HydrationError> {
    let link_metadata = fs::symlink_metadata(path).map_err(|_| HydrationError::FileChanged)?;
    if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
        return Err(HydrationError::FileChanged);
    }
    if path.canonicalize().ok().as_deref() != Some(path) {
        return Err(HydrationError::FileChanged);
    }
    let current = fs::metadata(path).map_err(|_| HydrationError::FileChanged)?;
    if !same_file(initial, &current) {
        return Err(HydrationError::FileChanged);
    }
    Ok(())
}

#[cfg(unix)]
fn same_file(left: &Metadata, right: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_file(left: &Metadata, right: &Metadata) -> bool {
    left.len() == right.len()
        && left.modified().ok() == right.modified().ok()
        && left.created().ok() == right.created().ok()
}

fn collect_scalar_secret(value: Option<&Value>, secrets: &mut Vec<String>) {
    match value {
        Some(Value::String(value)) if !value.is_empty() => secrets.push(value.clone()),
        Some(Value::Number(value)) => secrets.push(value.to_string()),
        _ => {}
    }
}

fn normalized_record_timestamp(
    record: &Map<String, Value>,
    message: &Map<String, Value>,
) -> Option<String> {
    record
        .get("timestamp")
        .and_then(normalized_timestamp)
        .or_else(|| message.get("timestamp").and_then(normalized_timestamp))
}

fn normalized_timestamp(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => normalized_rfc3339_utc(value),
        Value::Number(value) => normalized_unix_timestamp(value.as_u64()?),
        _ => None,
    }
}

fn normalized_unix_timestamp(value: u64) -> Option<String> {
    const MAX_UNIX_SECONDS: u64 = 253_402_300_799;
    const MAX_UNIX_MILLISECONDS: u64 = 253_402_300_799_999;
    let nanoseconds = if value <= MAX_UNIX_SECONDS {
        i128::from(value).checked_mul(1_000_000_000)?
    } else if value <= MAX_UNIX_MILLISECONDS {
        i128::from(value).checked_mul(1_000_000)?
    } else {
        return None;
    };
    OffsetDateTime::from_unix_timestamp_nanos(nanoseconds)
        .ok()?
        .format(&Rfc3339)
        .ok()
}

fn normalized_rfc3339_utc(value: &str) -> Option<String> {
    let value = value
        .strip_suffix('Z')
        .or_else(|| value.strip_suffix('z'))
        .or_else(|| value.strip_suffix("+00:00"))?;
    let (date, clock) = value.split_once('T').or_else(|| value.split_once('t'))?;
    let mut date_parts = date.split('-');
    let year_text = date_parts.next()?;
    if year_text.len() != 4 || !year_text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let year = year_text.parse::<i32>().ok()?;
    let month = date_parts.next()?.parse::<u8>().ok()?;
    let day = date_parts.next()?.parse::<u8>().ok()?;
    if date_parts.next().is_some() {
        return None;
    }
    let mut time_parts = clock.split(':');
    let hour = time_parts.next()?.parse::<u8>().ok()?;
    let minute = time_parts.next()?.parse::<u8>().ok()?;
    let seconds = time_parts.next()?;
    if time_parts.next().is_some() {
        return None;
    }
    let (second, nanosecond) = if let Some((second, fraction)) = seconds.split_once('.') {
        if fraction.is_empty()
            || fraction.len() > 9
            || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        let parsed = fraction.parse::<u32>().ok()?;
        (
            second.parse::<u8>().ok()?,
            parsed.checked_mul(10_u32.pow(9 - fraction.len() as u32))?,
        )
    } else {
        (seconds.parse::<u8>().ok()?, 0)
    };
    let date = Date::from_calendar_date(year, Month::try_from(month).ok()?, day).ok()?;
    let time = Time::from_hms_nano(hour, minute, second, nanosecond).ok()?;
    PrimitiveDateTime::new(date, time)
        .assume_utc()
        .format(&Rfc3339)
        .ok()
}

#[cfg(test)]
thread_local! {
    static TEST_SESSION_DIRECTORY: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
struct TestSessionDirectory {
    previous: Option<PathBuf>,
}

#[cfg(test)]
impl TestSessionDirectory {
    fn set(path: &Path) -> Self {
        let previous = TEST_SESSION_DIRECTORY.with(|value| value.replace(Some(path.to_path_buf())));
        Self { previous }
    }
}

#[cfg(test)]
impl Drop for TestSessionDirectory {
    fn drop(&mut self) {
        TEST_SESSION_DIRECTORY.with(|value| {
            value.replace(self.previous.take());
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    struct Fixture {
        _root: tempfile::TempDir,
        project: PathBuf,
        sessions: PathBuf,
        session: PathBuf,
        _override: TestSessionDirectory,
    }

    fn assert_hydration_error(
        result: Result<Vec<SafeMessage>, HydrationError>,
        expected: HydrationError,
    ) {
        assert_eq!(result.err(), Some(expected));
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempdir().unwrap();
            let project = root.path().join("private-project");
            let sessions = root.path().join("private-sessions");
            fs::create_dir(&project).unwrap();
            fs::create_dir(&sessions).unwrap();
            let project = project.canonicalize().unwrap();
            let sessions = sessions.canonicalize().unwrap();
            let session = sessions.join("private-session.jsonl");
            let directory_override = TestSessionDirectory::set(&sessions);
            Self {
                _root: root,
                project,
                sessions,
                session,
                _override: directory_override,
            }
        }

        fn write(&self, records: &[Value]) {
            let contents = records
                .iter()
                .map(|record| serde_json::to_string(record).unwrap())
                .collect::<Vec<_>>()
                .join("\n");
            fs::write(&self.session, format!("{contents}\n")).unwrap();
        }

        fn header(&self) -> Value {
            json!({
                "type": "session",
                "id": "raw-pi-session-id",
                "cwd": self.project,
                "parentSession": "/private/raw-parent-session.jsonl",
            })
        }

        fn state_event(&self, overrides: Value) -> Value {
            let mut data = json!({
                "sessionFile": self.session,
                "sessionId": "raw-state-session-id",
                "sessionName": "Safe session",
                "isStreaming": false,
                "isCompacting": true,
                "thinkingLevel": "xhigh",
                "messageCount": 12,
                "pendingMessageCount": 3,
                "model": { "id": "must-not-be-retained" },
            });
            for (key, value) in overrides.as_object().unwrap() {
                data[key] = value.clone();
            }
            json!({
                "type": "response",
                "command": "get_state",
                "success": true,
                "id": "raw-correlation-id",
                "data": data,
            })
        }
    }

    #[test]
    fn valid_state_is_cached_safely_and_streaming_events_update_only_existing_state() {
        let fixture = Fixture::new();
        fixture.write(&[fixture.header()]);
        let cache = SafeLiveStateCache::default();
        let event = fixture.state_event(json!({
            "sessionName": format!("  Safe\u{0007} name at {} raw-state-session-id  ", fixture.project.display()),
        }));
        cache.observe(&fixture.project, &event);

        let snapshot = cache.snapshot(&fixture.project).unwrap();
        assert_eq!(
            snapshot.session_file,
            Some(fixture.session.canonicalize().unwrap())
        );
        assert_eq!(
            snapshot.session_name.as_deref(),
            Some("Safe name at [redacted] [redacted]")
        );
        assert!(!snapshot.is_streaming);
        assert!(snapshot.is_compacting);
        assert_eq!(snapshot.thinking_level, ThinkingLevel::Xhigh);
        assert_eq!(snapshot.thinking_level.as_str(), "xhigh");
        assert_eq!(snapshot.message_count, 12);
        assert_eq!(snapshot.pending_message_count, 3);

        cache.observe(&fixture.project, &json!({ "type": "agent_start" }));
        assert!(cache.snapshot(&fixture.project).unwrap().is_streaming);
        cache.observe(&fixture.project, &json!({ "type": "agent_settled" }));
        assert!(!cache.snapshot(&fixture.project).unwrap().is_streaming);

        let empty = SafeLiveStateCache::default();
        empty.observe(&fixture.project, &json!({ "type": "agent_start" }));
        assert!(empty.snapshot(&fixture.project).is_none());
    }

    #[test]
    fn invalid_or_failed_state_candidates_leave_the_last_valid_snapshot_unchanged() {
        let fixture = Fixture::new();
        fixture.write(&[fixture.header()]);
        let cache = SafeLiveStateCache::default();
        cache.observe(&fixture.project, &fixture.state_event(json!({})));
        let expected = cache.snapshot(&fixture.project).unwrap();

        let outside = fixture._root.path().join("outside.jsonl");
        fs::write(&outside, serde_json::to_vec(&fixture.header()).unwrap()).unwrap();
        let candidates = [
            fixture.state_event(json!({ "isStreaming": "false" })),
            fixture.state_event(json!({ "thinkingLevel": "turbo" })),
            fixture.state_event(json!({ "messageCount": -1 })),
            fixture.state_event(json!({ "sessionFile": outside })),
            json!({ "type": "response", "command": "get_state", "success": false, "data": {} }),
            json!({ "type": "response", "command": "other", "success": true, "data": {} }),
            json!({ "type": "unknown", "data": {} }),
        ];
        for candidate in candidates {
            cache.observe(&fixture.project, &candidate);
            assert!(cache.snapshot(&fixture.project).as_ref() == Some(&expected));
        }

        let malformed = fixture.sessions.join("malformed.jsonl");
        fs::write(&malformed, "not json\n").unwrap();
        cache.observe(
            &fixture.project,
            &fixture.state_event(json!({ "sessionFile": malformed })),
        );
        assert!(cache.snapshot(&fixture.project).as_ref() == Some(&expected));

        let wrong = fixture.sessions.join("wrong.jsonl");
        fs::write(
            &wrong,
            format!(
                "{}\n",
                json!({ "type": "session", "cwd": fixture.sessions })
            ),
        )
        .unwrap();
        cache.observe(
            &fixture.project,
            &fixture.state_event(json!({ "sessionFile": wrong })),
        );
        assert!(cache.snapshot(&fixture.project).as_ref() == Some(&expected));

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let link = fixture.sessions.join("linked.jsonl");
            symlink(&outside, &link).unwrap();
            cache.observe(
                &fixture.project,
                &fixture.state_event(json!({ "sessionFile": link })),
            );
            assert!(cache.snapshot(&fixture.project).as_ref() == Some(&expected));
        }
    }

    #[test]
    fn cache_clear_and_project_isolation_are_explicit() {
        let root = tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        let first = first.canonicalize().unwrap();
        let second = second.canonicalize().unwrap();
        let cache = SafeLiveStateCache::default();
        let event = |count| {
            json!({
                "type": "response",
                "command": "get_state",
                "success": true,
                "data": {
                    "isStreaming": false,
                    "isCompacting": false,
                    "thinkingLevel": "off",
                    "messageCount": count,
                    "pendingMessageCount": 0,
                },
            })
        };
        cache.observe(&first, &event(1));
        cache.observe(&second, &event(2));
        assert_eq!(cache.snapshot(&first).unwrap().message_count, 1);
        assert_eq!(cache.snapshot(&second).unwrap().message_count, 2);
        cache.clear(&first);
        assert!(cache.snapshot(&first).is_none());
        assert_eq!(cache.snapshot(&second).unwrap().message_count, 2);
    }

    #[test]
    fn late_process_output_cannot_be_read_or_mutate_a_new_generation() {
        let fixture = Fixture::new();
        fixture.write(&[fixture.header()]);
        let cache = SafeLiveStateCache::default();
        let event = fixture.state_event(json!({ "isStreaming": false }));
        cache.observe_generation(&fixture.project, 2, &event);
        assert!(cache
            .snapshot_generation_canonical(&fixture.project, 1)
            .is_none());
        assert!(
            !cache
                .snapshot_generation_canonical(&fixture.project, 2)
                .unwrap()
                .is_streaming
        );

        cache.observe_generation(&fixture.project, 1, &json!({ "type": "agent_start" }));
        assert!(
            !cache
                .snapshot_generation_canonical(&fixture.project, 2)
                .unwrap()
                .is_streaming
        );

        cache.observe_generation(&fixture.project, 1, &event);
        assert!(cache
            .snapshot_generation_canonical(&fixture.project, 2)
            .is_some());
        assert!(cache
            .snapshot_generation_canonical(&fixture.project, 1)
            .is_none());
    }

    #[test]
    fn cache_clear_removes_exact_key_after_project_directory_moves() {
        let root = tempdir().unwrap();
        let project = root.path().join("project");
        let moved = root.path().join("moved-project");
        fs::create_dir(&project).unwrap();
        let project = project.canonicalize().unwrap();
        let cache = SafeLiveStateCache::default();
        cache.observe(
            &project,
            &json!({
                "type": "response",
                "command": "get_state",
                "success": true,
                "data": {
                    "isStreaming": false,
                    "isCompacting": false,
                    "thinkingLevel": "off",
                    "messageCount": 1,
                    "pendingMessageCount": 0,
                },
            }),
        );
        assert!(cache.contains_exact_key(&project));

        fs::rename(&project, moved).unwrap();
        cache.clear(&project);

        assert!(!cache.contains_exact_key(&project));
    }

    #[test]
    fn process_lifecycle_clear_hook_covers_started_exit_stop_and_error() {
        let fixture = Fixture::new();
        let cache = SafeLiveStateCache::default();
        let event = json!({
            "type": "response",
            "command": "get_state",
            "success": true,
            "data": {
                "isStreaming": false,
                "isCompacting": false,
                "thinkingLevel": "high",
                "messageCount": 1,
                "pendingMessageCount": 0,
            },
        });
        for state in ["started", "exited", "stopped", "error"] {
            cache.observe(&fixture.project, &event);
            assert!(cache.snapshot(&fixture.project).is_some());
            crate::clear_hydration_for_process_state(&cache, &fixture.project, state);
            assert!(cache.snapshot(&fixture.project).is_none(), "{state}");
        }
        cache.observe(&fixture.project, &event);
        crate::clear_hydration_for_process_state(&cache, &fixture.project, "unknown");
        assert!(cache.snapshot(&fixture.project).is_some());
    }

    #[test]
    fn transcript_projects_safe_messages_tools_and_stable_opaque_ids() {
        let fixture = Fixture::new();
        let project_text = fixture.project.to_string_lossy();
        let session_text = fixture.session.to_string_lossy();
        let directory_text = fixture.sessions.to_string_lossy();
        fixture.write(&[
            fixture.header(),
            json!({
                "type": "message",
                "id": "raw-user-message-id",
                "timestamp": "2026-08-03T01:20:00.123+00:00",
                "message": {
                    "id": "raw-inner-user-id",
                    "role": "user",
                    "content": [
                        { "type": "text", "text": format!("Hello\u{0007} {} raw-user-message-id <lemonpi-attachment name=\"secret.txt\" mime=\"text/plain\" size=\"18\">attachment-secret</lemonpi-attachment>", project_text) },
                        { "type": "image", "mimeType": "image/png", "data": "attachment-image-bytes" },
                    ],
                    "timestamp": 1,
                    "details": "private-message-details",
                },
            }),
            json!({
                "type": "message",
                "id": "raw-assistant-message-id",
                "message": {
                    "role": "assistant",
                    "timestamp": 1_754_185_202_011_u64,
                    "stopReason": "stop",
                    "content": [
                        { "type": "thinking", "thinking": format!("Inspecting {} raw-pi-session-id", directory_text) },
                        { "type": "text", "text": format!("Done at {} raw-assistant-message-id", session_text) },
                        { "type": "toolCall", "id": "raw-tool-call-id", "name": "safe_tool", "arguments": { "secret": "raw-tool-arguments" } },
                        { "type": "toolCall", "id": "raw-unmatched-tool-id", "name": "queued_tool", "arguments": { "secret": "queued-tool-arguments" } },
                        { "type": "image", "data": "assistant-image-bytes", "mimeType": "image/png" },
                    ],
                },
            }),
            json!({
                "type": "message",
                "timestamp": "2026-08-03T01:20:03Z",
                "message": {
                    "role": "toolResult",
                    "toolCallId": "raw-tool-call-id",
                    "content": [{ "type": "text", "text": "raw-tool-result-output" }],
                    "details": { "secret": "raw-tool-result-details" },
                    "isError": false,
                },
            }),
            json!({
                "type": "message",
                "timestamp": "2026-08-03T01:20:04Z",
                "message": {
                    "role": "assistant",
                    "stopReason": "error",
                    "content": "A final safe error summary",
                },
            }),
        ]);

        let first =
            project_transcript(&fixture.project, &fixture.session, "session_opaque", 20).unwrap();
        let second =
            project_transcript(&fixture.project, &fixture.session, "session_opaque", 20).unwrap();
        assert_eq!(
            first
                .iter()
                .map(|message| &message.message_id)
                .collect::<Vec<_>>(),
            second
                .iter()
                .map(|message| &message.message_id)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            first
                .iter()
                .map(|message| message.role.as_str())
                .collect::<Vec<_>>(),
            vec!["user", "assistant", "tool", "tool", "assistant"]
        );
        assert_eq!(first[0].text, "Hello [redacted] [redacted]");
        assert_eq!(first[0].is_error, Some(false));
        assert_eq!(first[0].timestamp, "2026-08-03T01:20:00.123Z");
        assert_eq!(first[1].text, "Done at [redacted] [redacted]");
        assert_eq!(
            first[1].thinking.as_deref(),
            Some("Inspecting [redacted] [redacted]")
        );
        assert_eq!(first[1].is_error, Some(false));
        assert_eq!(first[2].tool_name.as_deref(), Some("safe_tool"));
        assert_eq!(first[2].tool_status.as_deref(), Some("complete"));
        assert_eq!(first[2].text, "");
        assert_eq!(first[2].is_error, Some(false));
        assert_eq!(first[3].tool_status.as_deref(), Some("queued"));
        assert_eq!(first[4].is_error, Some(true));
        for message in &first {
            assert!(message.message_id.starts_with("message_"));
            assert!(!message.message_id.contains("raw"));
        }

        let serialized = serde_json::to_string(&first).unwrap();
        for secret in [
            project_text.as_ref(),
            session_text.as_ref(),
            directory_text.as_ref(),
            "raw-pi-session-id",
            "/private/raw-parent-session.jsonl",
            "raw-user-message-id",
            "raw-inner-user-id",
            "raw-assistant-message-id",
            "raw-tool-call-id",
            "raw-unmatched-tool-id",
            "raw-tool-arguments",
            "queued-tool-arguments",
            "raw-tool-result-output",
            "raw-tool-result-details",
            "attachment-secret",
            "attachment-image-bytes",
            "assistant-image-bytes",
            "private-message-details",
        ] {
            assert!(
                !serialized.contains(secret),
                "leaked {secret}: {serialized}"
            );
        }
        assert!(!first.iter().any(|message| {
            message.text.chars().any(char::is_control)
                || message
                    .thinking
                    .as_deref()
                    .is_some_and(|thinking| thinking.chars().any(char::is_control))
        }));
    }

    #[test]
    fn transcript_redacts_embedded_paths_tokens_and_cross_record_identifiers() {
        let fixture = Fixture::new();
        let token = "0LihExfkXNrXC_i04AvBeOx_Iyo9RsmXKQ66wPQPzcw";
        let quoted_record_id = "pi-record-issued-later";
        let quoted_tool_id = "pi-tool-issued-later";
        fixture.write(&[
            fixture.header(),
            json!({
                "type": "message",
                "timestamp": "2026-08-03T01:20:00Z",
                "message": {
                    "role": "user",
                    "content": format!(
                        "path=/Users/maya/.ssh/id_ed25519 markdown](/Users/maya/private) windows=C:\\Users\\maya\\secret uri=file:///Users/maya/token Bearer {token} token={token} quoted={quoted_record_id} tool={quoted_tool_id}"
                    ),
                },
            }),
            json!({
                "type": "message",
                "id": quoted_record_id,
                "timestamp": "2026-08-03T01:20:01Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "thinking", "thinking": format!("thinking=[C:\\Users\\maya\\notes] token={token} quoted={quoted_tool_id}") },
                        { "type": "text", "text": "safe" },
                        { "type": "toolCall", "id": quoted_tool_id, "name": "tool" },
                    ],
                },
            }),
        ]);

        let messages =
            project_transcript(&fixture.project, &fixture.session, "session_opaque", 10).unwrap();
        let serialized = serde_json::to_string(&messages).unwrap();
        for secret in [
            "/Users/maya/.ssh/id_ed25519",
            "/Users/maya/private",
            r"C:\Users\maya\secret",
            "file:///Users/maya/token",
            token,
            quoted_record_id,
            quoted_tool_id,
        ] {
            assert!(
                !serialized.contains(secret),
                "leaked {secret}: {serialized}"
            );
        }
        assert!(messages.iter().all(|message| message.is_error.is_some()));
    }

    #[test]
    fn transcript_keeps_chronological_last_n_projected_messages() {
        let fixture = Fixture::new();
        fixture.write(&[
            fixture.header(),
            json!({ "type": "message", "timestamp": 1_700_000_001_000_u64, "message": { "role": "user", "content": "one" } }),
            json!({ "type": "message", "timestamp": 1_700_000_002_000_u64, "message": { "role": "assistant", "content": "two" } }),
            json!({ "type": "message", "timestamp": 1_700_000_003_000_u64, "message": { "role": "user", "content": "three" } }),
        ]);
        let all =
            project_transcript(&fixture.project, &fixture.session, "session_opaque", 3).unwrap();
        let last =
            project_transcript(&fixture.project, &fixture.session, "session_opaque", 2).unwrap();
        assert_eq!(
            last.iter()
                .map(|message| message.text.as_str())
                .collect::<Vec<_>>(),
            vec!["two", "three"]
        );
        assert_eq!(last[0].message_id, all[1].message_id);
        assert_eq!(last[1].message_id, all[2].message_id);
    }

    #[test]
    fn transcript_ignores_empty_records_but_requires_first_nonempty_record_to_be_header() {
        let fixture = Fixture::new();
        let header = serde_json::to_string(&fixture.header()).unwrap();
        let message = serde_json::to_string(&json!({
            "type": "message",
            "timestamp": 1_700_000_000_u64,
            "message": { "role": "user", "content": "safe" },
        }))
        .unwrap();
        fs::write(
            &fixture.session,
            format!("\r\n{header}\r\n\n\r\n{message}\r\n\n"),
        )
        .unwrap();

        let messages =
            project_transcript(&fixture.project, &fixture.session, "session_opaque", 10).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text, "safe");

        fs::write(&fixture.session, format!("\n\r\n{message}\n")).unwrap();
        assert_hydration_error(
            project_transcript(&fixture.project, &fixture.session, "session_opaque", 10),
            HydrationError::InvalidHeader,
        );
    }

    #[test]
    fn transcript_rejects_missing_malformed_or_mismatched_headers_without_partial_output() {
        let fixture = Fixture::new();
        fixture.write(&[json!({
            "type": "message",
            "timestamp": 1_700_000_000_000_u64,
            "message": { "role": "user", "content": "not a header" },
        })]);
        assert_hydration_error(
            project_transcript(&fixture.project, &fixture.session, "session_opaque", 10),
            HydrationError::InvalidHeader,
        );

        fs::write(&fixture.session, "not json\n").unwrap();
        assert_hydration_error(
            project_transcript(&fixture.project, &fixture.session, "session_opaque", 10),
            HydrationError::InvalidHeader,
        );

        fixture.write(&[json!({
            "type": "session",
            "cwd": fixture.sessions,
        })]);
        assert_hydration_error(
            project_transcript(&fixture.project, &fixture.session, "session_opaque", 10),
            HydrationError::CwdMismatch,
        );

        fixture.write(&[
            fixture.header(),
            json!({ "type": "message", "timestamp": 1_700_000_000_000_u64, "message": { "role": "user", "content": "would be partial" } }),
        ]);
        let mut contents = fs::read_to_string(&fixture.session).unwrap();
        contents.push_str("{malformed}\n");
        fs::write(&fixture.session, contents).unwrap();
        assert_hydration_error(
            project_transcript(&fixture.project, &fixture.session, "session_opaque", 10),
            HydrationError::MalformedRecord,
        );
    }

    #[cfg(unix)]
    #[test]
    fn transcript_rejects_symlink_escape_and_symlink_replacement() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = fixture._root.path().join("outside.jsonl");
        fs::write(
            &outside,
            format!("{}\n", serde_json::to_string(&fixture.header()).unwrap()),
        )
        .unwrap();
        let link = fixture.sessions.join("linked.jsonl");
        symlink(&outside, &link).unwrap();
        assert_hydration_error(
            project_transcript(&fixture.project, &link, "session_opaque", 10),
            HydrationError::InvalidSession,
        );
        assert_hydration_error(
            project_transcript(
                &fixture.project,
                &outside.canonicalize().unwrap(),
                "session_opaque",
                10,
            ),
            HydrationError::InvalidSession,
        );

        fixture.write(&[fixture.header()]);
        fs::remove_file(&fixture.session).unwrap();
        symlink(&outside, &fixture.session).unwrap();
        assert_hydration_error(
            project_transcript(&fixture.project, &fixture.session, "session_opaque", 10),
            HydrationError::InvalidSession,
        );
    }

    #[test]
    fn transcript_enforces_record_file_response_limit_and_timestamp_bounds() {
        let fixture = Fixture::new();
        assert_hydration_error(
            project_transcript(&fixture.project, &fixture.session, "session_opaque", 0),
            HydrationError::InvalidLimit,
        );
        assert_hydration_error(
            project_transcript(&fixture.project, &fixture.session, "session_opaque", 201),
            HydrationError::InvalidLimit,
        );

        let oversized_record = format!(
            "{}\n{}\n",
            serde_json::to_string(&fixture.header()).unwrap(),
            "x".repeat(MAX_TRANSCRIPT_RECORD_BYTES + 1)
        );
        fs::write(&fixture.session, oversized_record).unwrap();
        assert_hydration_error(
            project_transcript(&fixture.project, &fixture.session, "session_opaque", 10),
            HydrationError::RecordTooLarge,
        );

        fs::write(
            &fixture.session,
            format!("{}\n", serde_json::to_string(&fixture.header()).unwrap()),
        )
        .unwrap();
        File::options()
            .write(true)
            .open(&fixture.session)
            .unwrap()
            .set_len(MAX_TRANSCRIPT_FILE_BYTES + 1)
            .unwrap();
        assert_hydration_error(
            project_transcript(&fixture.project, &fixture.session, "session_opaque", 10),
            HydrationError::FileTooLarge,
        );

        let large_text = "x ".repeat(MAX_MESSAGE_TEXT_SCALARS / 2);
        let mut records = vec![fixture.header()];
        for index in 0..140_u64 {
            records.push(json!({
                "type": "message",
                "timestamp": 1_700_000_000_000_u64 + index,
                "message": { "role": "user", "content": large_text },
            }));
        }
        fixture.write(&records);
        assert_hydration_error(
            project_transcript(&fixture.project, &fixture.session, "session_opaque", 200),
            HydrationError::ResponseTooLarge,
        );

        fixture.write(&[
            fixture.header(),
            json!({ "type": "message", "timestamp": "not-a-time", "message": { "role": "user", "content": "invalid string" } }),
            json!({ "type": "message", "timestamp": -1, "message": { "role": "user", "content": "negative" } }),
            json!({ "type": "message", "timestamp": 253_402_300_800_000_u64, "message": { "role": "user", "content": "too late" } }),
            json!({ "type": "message", "timestamp": 1_700_000_000_u64, "message": { "role": "user", "content": "valid seconds" } }),
        ]);
        let messages =
            project_transcript(&fixture.project, &fixture.session, "session_opaque", 10).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text, "valid seconds");
        assert_eq!(messages[0].timestamp, "2023-11-14T22:13:20Z");
    }
}
