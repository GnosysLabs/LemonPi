//! The deliberately small, pinned-TLS HTTP surface for LemonPi Go v1.
//!
//! This module owns only `/health`, `/pair`, `/projects`, and the read-only session catalogue. It
//! deliberately has no generic Pi command, filesystem, settings, or WebSocket route. Internal
//! paths remain confined to crate-private code; handlers serialize only explicitly safe projections.

use super::{
    auth::{DeviceStore, PairingAttempt, PairingWindow},
    config::{AccessMode, RemoteConfig},
    identity::HostIdentity,
    policy::allows_peer,
    projects::{ProjectCatalog, RemoteProjectSummary, SessionSyncInput},
    protocol::{
        Capability, Envelope, Health, Limits, PairRequest, PairResponse, PairedDevice,
        ProtocolError, SessionSummary, SessionsResponse,
    },
    RemoteError, RemoteResult,
};
use crate::{list_pi_sessions_sync, session_directory, PiManager, PiSessionSummary};
use axum::{
    body::{to_bytes, Body},
    extract::{ConnectInfo, State},
    http::{header, HeaderMap, Method, StatusCode, Uri},
    response::Response,
    routing::{get, post},
    Router,
};
use hyper_util::{
    rt::{TokioExecutor, TokioIo},
    server::conn::auto::Builder as HyperBuilder,
    service::TowerToHyperService,
};
use rustls::{
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
    ServerConfig,
};
use serde::Serialize;
use std::{
    future::Future,
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use time::{
    format_description::well_known::Rfc3339, Date, Month, OffsetDateTime, PrimitiveDateTime, Time,
};
use tokio::{
    net::TcpStream,
    sync::{watch, Mutex},
};
use tokio_rustls::TlsAcceptor;
use tower::ServiceExt;
use uuid::Uuid;

pub(crate) const MAX_HTTP_BODY_BYTES: usize = 2 * 1024 * 1024;
/// Slow allowed peers must complete TLS before consuming a server task indefinitely.
pub(crate) const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// This current slice has only short request/response routes. A future WebSocket stream must
/// explicitly replace this policy rather than silently inheriting a 60-second HTTP deadline.
pub(crate) const HTTP_CONNECTION_LIFETIME: Duration = Duration::from_secs(60);
pub(crate) const EVENT_ENVELOPE_BYTES: u64 = 1024 * 1024;
pub(crate) const DEVICE_LIMIT: u64 = 16;
pub(crate) const SOCKET_LIMIT: u64 = 8;
pub(crate) const REPLAY_EVENT_LIMIT: u64 = 4096;
pub(crate) const BROADCAST_QUEUE_LIMIT: u64 = 1024;

const PROTOCOL_HEADER: &str = "x-lemonpi-protocol";
const REQUEST_ID_HEADER: &str = "x-lemonpi-request-id";
const CAPABILITIES_HEADER: &str = "x-lemonpi-capabilities";

/// Only capabilities backed by this listener slice are advertised. The frozen model accepts the
/// complete v1 token vocabulary, but an unfinished capability is never advertised as available.
const AVAILABLE_CAPABILITIES: &[Capability] = &[Capability::Projects];

#[derive(Clone)]
pub(crate) struct BridgeState {
    pub(crate) config: RemoteConfig,
    pub(crate) storage: PathBuf,
    pub(crate) identity: Arc<HostIdentity>,
    pub(crate) devices: Arc<Mutex<DeviceStore>>,
    pub(crate) pairing: Arc<Mutex<Option<PairingWindow>>>,
    pub(crate) manager: Arc<PiManager>,
}

#[derive(Clone, Debug)]
struct RequestContext {
    request_id: String,
    accepted_capabilities: Vec<Capability>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectsPayload {
    projects: Vec<RemoteProjectSummary>,
    accepted_capabilities: Vec<Capability>,
}

#[derive(Debug)]
enum SessionCatalogError {
    ProjectNotFound,
    HostUnavailable,
}

/// Builds the v1 router. The actual TCP listener also checks peers before TLS negotiation; this
/// route-level check keeps the rule true for every request and permits deterministic router tests.
pub(crate) fn router(state: BridgeState) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/pair", post(pair))
        .route("/v1/projects", get(projects))
        .route("/v1/sessions", get(sessions))
        .with_state(state)
}

pub(crate) fn tls_server_config(identity: &HostIdentity) -> RemoteResult<Arc<ServerConfig>> {
    let (certificate_der, private_key_der) = identity.tls_der()?;
    let certificate = CertificateDer::from(certificate_der);
    let private_key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(private_key_der));
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|error| {
            RemoteError::InvalidIdentity(format!("TLS version configuration failed: {error}"))
        })?
        .with_no_client_auth()
        .with_single_cert(vec![certificate], private_key)
        .map_err(|error| {
            RemoteError::InvalidIdentity(format!(
                "certificate and private key are incompatible: {error}"
            ))
        })?;
    Ok(Arc::new(config))
}

/// Runs a finite pre-TLS or HTTP operation. It is intentionally small and testable so the
/// connection lifetime policy cannot drift from the task that holds a connection permit.
async fn complete_within<T>(duration: Duration, operation: impl Future<Output = T>) -> Option<T> {
    tokio::time::timeout(duration, operation).await.ok()
}

/// Serves one already-peer-validated TLS connection. TLS handshake failures are intentionally
/// silent: reporting details would turn an unauthenticated socket into a certificate oracle.
pub(crate) async fn serve_tls_connection(
    acceptor: TlsAcceptor,
    stream: TcpStream,
    peer: SocketAddr,
    app: Router,
    mut shutdown: watch::Receiver<bool>,
) {
    // A listener stop also releases in-progress TLS handshakes and active request tasks. This
    // prevents a malicious peer that never completes a handshake from outliving a local disable.
    let served = async move {
        let Some(handshake) = complete_within(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await
        else {
            return;
        };
        let Ok(tls_stream) = handshake else {
            return;
        };
        let service = app
            .into_make_service_with_connect_info::<SocketAddr>()
            .oneshot(peer)
            .await
            .expect("infallible Axum make service");
        let io = TokioIo::new(tls_stream);
        let _ = complete_within(
            HTTP_CONNECTION_LIFETIME,
            HyperBuilder::new(TokioExecutor::new())
                .serve_connection_with_upgrades(io, TowerToHyperService::new(service)),
        )
        .await;
    };
    tokio::select! {
        _ = served => {}
        changed = shutdown.changed() => {
            let _ = changed;
        }
    }
}

async fn health(
    State(state): State<BridgeState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let context = match validate_request(&headers, peer, state.config.access_mode) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let data = Health {
        host_id: state.identity.host_id().to_string(),
        display_name: format!("LemonPi on {}", state.identity.hostname()),
        port: state.config.port,
        capabilities: AVAILABLE_CAPABILITIES.to_vec(),
        accepted_capabilities: context.accepted_capabilities.clone(),
        limits: standard_limits(),
    };
    success(StatusCode::OK, &context.request_id, data)
}

async fn pair(
    State(state): State<BridgeState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let context = match validate_request(&headers, peer, state.config.access_mode) {
        Ok(context) => context,
        Err(response) => return response,
    };
    if !is_json_content_type(&headers) {
        return error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            &context.request_id,
            "unsupported_content_type",
            "This endpoint requires a JSON request body.",
            false,
        );
    }
    let body = match to_bytes(body, MAX_HTTP_BODY_BYTES).await {
        Ok(body) => body,
        Err(_) => {
            return error(
                StatusCode::PAYLOAD_TOO_LARGE,
                &context.request_id,
                "payload_too_large",
                "The request body is too large.",
                false,
            )
        }
    };
    let request: PairRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(_) => {
            return error(
                StatusCode::BAD_REQUEST,
                &context.request_id,
                "malformed_request",
                "The pairing request is invalid.",
                false,
            )
        }
    };
    let device_id = match Uuid::parse_str(&request.device_id) {
        Ok(id) => id.to_string(),
        Err(_) => {
            return error(
                StatusCode::BAD_REQUEST,
                &context.request_id,
                "malformed_request",
                "The pairing request is invalid.",
                false,
            )
        }
    };
    let Some(display_name) = validated_display_name(&request.display_name) else {
        return error(
            StatusCode::BAD_REQUEST,
            &context.request_id,
            "malformed_request",
            "The pairing request is invalid.",
            false,
        );
    };

    let now = unix_seconds();
    let mut pairing = state.pairing.lock().await;
    let Some(window) = pairing.as_mut() else {
        return error(
            StatusCode::GONE,
            &context.request_id,
            "pairing_expired",
            "The pairing window is no longer available.",
            false,
        );
    };
    let mut devices = state.devices.lock().await;
    match window.attempt(&request.code, device_id, display_name, now, &mut devices) {
        PairingAttempt::Success {
            device,
            device_token,
        } => success(
            StatusCode::CREATED,
            &context.request_id,
            PairResponse {
                token: device_token,
                device: PairedDevice {
                    id: device.id,
                    display_name: device.display_name,
                    paired_at: rfc3339(device.paired_at),
                },
                accepted_capabilities: context.accepted_capabilities,
            },
        ),
        PairingAttempt::InvalidCode { .. } => error(
            StatusCode::UNAUTHORIZED,
            &context.request_id,
            "invalid_pairing_code",
            "The pairing code is invalid or no longer available.",
            true,
        ),
        PairingAttempt::Expired | PairingAttempt::Closed => error(
            StatusCode::GONE,
            &context.request_id,
            "pairing_expired",
            "The pairing window is no longer available.",
            false,
        ),
        PairingAttempt::AttemptsExceeded => error(
            StatusCode::TOO_MANY_REQUESTS,
            &context.request_id,
            "pairing_attempts_exceeded",
            "The pairing window is no longer available.",
            false,
        ),
        PairingAttempt::DeviceLimitReached => error(
            StatusCode::CONFLICT,
            &context.request_id,
            "device_limit_reached",
            "The host has reached its paired-device limit.",
            false,
        ),
        PairingAttempt::DeviceAlreadyPaired => error(
            StatusCode::CONFLICT,
            &context.request_id,
            "device_id_already_paired",
            "This device is already paired.",
            false,
        ),
        PairingAttempt::StorageFailure => error(
            StatusCode::SERVICE_UNAVAILABLE,
            &context.request_id,
            "host_unavailable",
            "The host cannot complete pairing right now.",
            true,
        ),
    }
}

async fn projects(
    State(state): State<BridgeState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let context = match validate_request(&headers, peer, state.config.access_mode) {
        Ok(context) => context,
        Err(response) => return response,
    };
    if !is_authenticated(&headers, &state).await {
        return error(
            StatusCode::UNAUTHORIZED,
            &context.request_id,
            "unauthenticated",
            "Authentication is required.",
            false,
        );
    }
    let active_project = state.manager.remote_active_project().await;
    let catalog = match ProjectCatalog::load_or_create(&state.storage) {
        Ok(catalog) => catalog,
        Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                &context.request_id,
                "host_unavailable",
                "The host cannot provide projects right now.",
                true,
            )
        }
    };
    success(
        StatusCode::OK,
        &context.request_id,
        ProjectsPayload {
            projects: catalog.safe_projects(active_project.as_deref()),
            accepted_capabilities: context.accepted_capabilities,
        },
    )
}

async fn sessions(
    State(state): State<BridgeState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let context = match validate_request(&headers, peer, state.config.access_mode) {
        Ok(context) => context,
        Err(response) => return response,
    };
    if !is_authenticated(&headers, &state).await {
        return error(
            StatusCode::UNAUTHORIZED,
            &context.request_id,
            "unauthenticated",
            "Authentication is required.",
            false,
        );
    }
    if !AVAILABLE_CAPABILITIES.contains(&Capability::Projects) {
        return error(
            StatusCode::NOT_IMPLEMENTED,
            &context.request_id,
            "capability_unavailable",
            "Session catalogues are not available on this host.",
            false,
        );
    }
    let Some(project_id) = project_id_query(&uri) else {
        return error(
            StatusCode::BAD_REQUEST,
            &context.request_id,
            "malformed_request",
            "The session catalogue request is invalid.",
            false,
        );
    };

    let storage = state.storage.clone();
    let requested_project_id = project_id.clone();
    let result =
        tokio::task::spawn_blocking(move || session_catalogue(&storage, &requested_project_id))
            .await;
    let sessions = match result {
        Ok(Ok(sessions)) => sessions,
        Ok(Err(SessionCatalogError::ProjectNotFound)) => {
            return error(
                StatusCode::NOT_FOUND,
                &context.request_id,
                "project_not_found",
                "The requested project is not available.",
                false,
            )
        }
        Ok(Err(SessionCatalogError::HostUnavailable)) | Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                &context.request_id,
                "host_unavailable",
                "The host cannot provide sessions right now.",
                true,
            )
        }
    };

    success(
        StatusCode::OK,
        &context.request_id,
        SessionsResponse {
            project_id,
            sessions,
            accepted_capabilities: context.accepted_capabilities,
        },
    )
}

fn session_catalogue(
    storage: &std::path::Path,
    project_id: &str,
) -> Result<Vec<SessionSummary>, SessionCatalogError> {
    let mut catalog = ProjectCatalog::load_or_create(storage)
        .map_err(|_| SessionCatalogError::HostUnavailable)?;
    let binding = catalog
        .resolve_project_binding(project_id)
        .ok_or(SessionCatalogError::ProjectNotFound)?;
    if !binding.trusted {
        catalog
            .clear_sessions(project_id)
            .map_err(|_| SessionCatalogError::HostUnavailable)?;
        return Ok(Vec::new());
    }

    let directory =
        session_directory(&binding.path).map_err(|_| SessionCatalogError::HostUnavailable)?;
    let discovered =
        list_pi_sessions_sync(&binding.path).map_err(|_| SessionCatalogError::HostUnavailable)?;
    if catalog.resolve_project_binding(project_id).is_none() {
        return Err(SessionCatalogError::ProjectNotFound);
    }
    let inputs = discovered
        .iter()
        .map(|session| SessionSyncInput {
            path: PathBuf::from(&session.path),
        })
        .collect::<Vec<_>>();
    catalog
        .sync_sessions(project_id, &directory, &inputs)
        .map_err(|_| SessionCatalogError::HostUnavailable)?;

    Ok(discovered
        .into_iter()
        .filter_map(|session| {
            project_session(&catalog, &binding.path, &directory, project_id, session)
        })
        .collect())
}

fn project_session(
    catalog: &ProjectCatalog,
    project_path: &std::path::Path,
    directory: &std::path::Path,
    project_id: &str,
    session: PiSessionSummary,
) -> Option<SessionSummary> {
    let session_path = PathBuf::from(&session.path);
    let session_id = catalog.session_id_for_path(project_id, directory, &session_path)?;
    let modified_at = rfc3339_millis(session.modified)?;
    let message_count = u64::try_from(session.message_count).ok()?;
    let secrets = [
        Some(project_path.to_string_lossy().into_owned()),
        Some(directory.to_string_lossy().into_owned()),
        Some(session.path.clone()),
        Some(session.id.clone()),
        session.parent_session_path.clone(),
    ];
    let name = session
        .name
        .as_deref()
        .and_then(|name| safe_session_text(name, &secrets, 160));
    let first_message_preview = safe_session_text(&session.first_message, &secrets, 280)
        .unwrap_or_else(|| "New session".to_string());
    let last_final_reply_at = session
        .last_final_reply
        .as_ref()
        .and_then(|reply| reply.timestamp.as_deref())
        .and_then(normalized_utc_timestamp);
    Some(SessionSummary {
        session_id,
        name,
        modified_at,
        message_count,
        first_message_preview,
        last_final_reply_at,
    })
}

fn safe_session_text(value: &str, secrets: &[Option<String>], limit: usize) -> Option<String> {
    let mut redacted = value.to_string();
    for secret in secrets.iter().flatten().filter(|secret| !secret.is_empty()) {
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
    let compact = printable
        .split_whitespace()
        .map(|word| {
            if looks_like_internal_path(word) {
                "[redacted]"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    if compact.is_empty() {
        return None;
    }
    Some(compact.chars().take(limit).collect())
}

fn looks_like_internal_path(word: &str) -> bool {
    let candidate = word.trim_matches(|character: char| {
        matches!(
            character,
            '\'' | '"' | '`' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';'
        )
    });
    candidate.starts_with('/')
        || candidate.starts_with('~')
        || candidate.starts_with("\\\\")
        || candidate.as_bytes().get(1) == Some(&b':')
            && candidate
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphabetic)
            && matches!(candidate.as_bytes().get(2), Some(b'/' | b'\\'))
}

fn rfc3339_millis(milliseconds: u64) -> Option<String> {
    let nanoseconds = i128::from(milliseconds).checked_mul(1_000_000)?;
    OffsetDateTime::from_unix_timestamp_nanos(nanoseconds)
        .ok()?
        .format(&Rfc3339)
        .ok()
}

fn normalized_utc_timestamp(value: &str) -> Option<String> {
    let value = value.strip_suffix('Z')?;
    let (date, time) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i32>().ok()?;
    let month = date_parts.next()?.parse::<u8>().ok()?;
    let day = date_parts.next()?.parse::<u8>().ok()?;
    if date_parts.next().is_some() {
        return None;
    }
    let mut time_parts = time.split(':');
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
            parsed.checked_mul(10u32.pow(9 - fraction.len() as u32))?,
        )
    } else {
        (seconds.parse::<u8>().ok()?, 0)
    };
    let month = Month::try_from(month).ok()?;
    let date = Date::from_calendar_date(year, month, day).ok()?;
    let time = Time::from_hms_nano(hour, minute, second, nanosecond).ok()?;
    PrimitiveDateTime::new(date, time)
        .assume_utc()
        .format(&Rfc3339)
        .ok()
}

fn project_id_query(uri: &Uri) -> Option<String> {
    let query = uri.query()?;
    let mut members = query.split('&');
    let member = members.next()?;
    if members.next().is_some() {
        return None;
    }
    let (name, value) = member.split_once('=')?;
    if decode_query_component(name)? != "projectId" {
        return None;
    }
    let value = decode_query_component(value)?;
    (!value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')))
    .then_some(value)
}

fn decode_query_component(value: &str) -> Option<String> {
    fn hex(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }

    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                let high = hex(*bytes.get(index + 1)?)?;
                let low = hex(*bytes.get(index + 2)?)?;
                decoded.push((high << 4) | low);
                index += 3;
            }
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(decoded).ok()
}

fn validate_request(
    headers: &HeaderMap,
    peer: SocketAddr,
    access_mode: AccessMode,
) -> Result<RequestContext, Response> {
    let request_id = effective_request_id(headers);
    if !has_exact_header(headers, PROTOCOL_HEADER, "1") {
        return Err(error(
            StatusCode::UPGRADE_REQUIRED,
            &request_id,
            "unsupported_protocol_version",
            "This LemonPi host requires remote protocol version 1.",
            false,
        ));
    }
    if canonical_request_id(headers).is_none() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            &request_id,
            "malformed_request",
            "The request is invalid.",
            false,
        ));
    }
    if !allows_peer(access_mode, peer.ip()) {
        return Err(error(
            StatusCode::FORBIDDEN,
            &request_id,
            "peer_not_allowed",
            "This network peer is not allowed by the host.",
            false,
        ));
    }
    Ok(RequestContext {
        request_id,
        accepted_capabilities: accepted_capabilities(headers),
    })
}

fn canonical_request_id(headers: &HeaderMap) -> Option<String> {
    let values = headers.get_all(REQUEST_ID_HEADER);
    if values.iter().count() != 1 {
        return None;
    }
    let value = values.iter().next()?.to_str().ok()?;
    let parsed = Uuid::parse_str(value).ok()?;
    (parsed.to_string() == value).then_some(value.to_string())
}

fn effective_request_id(headers: &HeaderMap) -> String {
    canonical_request_id(headers).unwrap_or_else(|| Uuid::new_v4().to_string())
}

fn has_exact_header(headers: &HeaderMap, name: &str, expected: &str) -> bool {
    let values = headers.get_all(name);
    values.iter().count() == 1
        && values.iter().next().and_then(|value| value.to_str().ok()) == Some(expected)
}

fn accepted_capabilities(headers: &HeaderMap) -> Vec<Capability> {
    let values = headers.get_all(CAPABILITIES_HEADER);
    if values.iter().count() != 1 {
        return AVAILABLE_CAPABILITIES.to_vec();
    }
    let Some(value) = values.iter().next().and_then(|value| value.to_str().ok()) else {
        return AVAILABLE_CAPABILITIES.to_vec();
    };
    let requested = value
        .split(',')
        .filter_map(|token| match token.trim() {
            "projects" => Some(Capability::Projects),
            "state" => Some(Capability::State),
            "rpc" => Some(Capability::Rpc),
            "events" => Some(Capability::Events),
            _ => None,
        })
        .collect::<Vec<_>>();
    AVAILABLE_CAPABILITIES
        .iter()
        .copied()
        .filter(|capability| requested.contains(capability))
        .collect()
}

fn is_json_content_type(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
}

async fn is_authenticated(headers: &HeaderMap, state: &BridgeState) -> bool {
    let values = headers.get_all(header::AUTHORIZATION);
    if values.iter().count() != 1 {
        return false;
    }
    let Some(value) = values.iter().next().and_then(|value| value.to_str().ok()) else {
        return false;
    };
    let Some(token) = value.strip_prefix("Bearer ") else {
        return false;
    };
    !token.is_empty()
        && !token.contains(char::is_whitespace)
        && state.devices.lock().await.verifies(token)
}

fn validated_display_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (trimmed == value
        && !trimmed.is_empty()
        && trimmed.chars().count() <= 64
        && !trimmed.chars().any(char::is_control))
    .then_some(trimmed.to_string())
}

fn standard_limits() -> Limits {
    Limits {
        http_body_bytes: Some(MAX_HTTP_BODY_BYTES as u64),
        event_envelope_bytes: EVENT_ENVELOPE_BYTES,
        devices: Some(DEVICE_LIMIT),
        sockets: Some(SOCKET_LIMIT),
        replay_events: REPLAY_EVENT_LIMIT,
        broadcast_queue: BROADCAST_QUEUE_LIMIT,
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub(crate) fn rfc3339(seconds: u64) -> String {
    OffsetDateTime::from_unix_timestamp(seconds as i64)
        .ok()
        .and_then(|time| time.format(&Rfc3339).ok())
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string())
}

/// Keeps optional request diagnostics free of credentials, query strings, and bodies. Production
/// service code currently emits no request logs; this helper guards any future operational log.
pub(crate) fn redacted_request_summary(method: &Method, uri: &Uri, status: StatusCode) -> String {
    format!("remote {} {} {}", method, uri.path(), status.as_u16())
}

fn success<T: Serialize>(status: StatusCode, request_id: &str, data: T) -> Response {
    envelope_response::<T>(status, request_id, Some(data), None)
}

fn error(
    status: StatusCode,
    request_id: &str,
    code: &str,
    message: &str,
    retryable: bool,
) -> Response {
    envelope_response::<serde_json::Value>(
        status,
        request_id,
        None,
        Some(ProtocolError {
            code: code.to_string(),
            message: message.to_string(),
            retryable,
            details: None,
        }),
    )
}

fn envelope_response<T: Serialize>(
    status: StatusCode,
    request_id: &str,
    data: Option<T>,
    error: Option<ProtocolError>,
) -> Response {
    let body = serde_json::to_vec(&Envelope {
        protocol: super::protocol::PROTOCOL_VERSION,
        request_id: request_id.to_string(),
        data,
        error,
    })
    .unwrap_or_else(|_| b"{\"protocol\":1,\"error\":{\"code\":\"host_unavailable\",\"message\":\"The host cannot respond right now.\",\"retryable\":true}}".to_vec());
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(PROTOCOL_HEADER, "1")
        .header(REQUEST_ID_HEADER, request_id)
        .body(Body::from(body))
        .expect("fixed HTTP response parts are valid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::{
        auth::PairingWindow,
        config::RemoteConfig,
        identity::HostIdentityStore,
        projects::{KnownProjectInput, ProjectCatalog},
    };
    use axum::{body::to_bytes, http::Request};
    use std::ffi::OsString;
    use tempfile::tempdir;
    use tower::ServiceExt;

    const TEST_TOKEN: &str = "0LihExfkXNrXC_i04AvBeOx_Iyo9RsmXKQ66wPQPzcw";
    static SESSION_DIRECTORY_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct SessionDirectoryOverride {
        previous: Option<OsString>,
    }

    impl SessionDirectoryOverride {
        fn set(path: &std::path::Path) -> Self {
            let previous = std::env::var_os("PI_CODING_AGENT_SESSION_DIR");
            std::env::set_var("PI_CODING_AGENT_SESSION_DIR", path);
            Self { previous }
        }
    }

    impl Drop for SessionDirectoryOverride {
        fn drop(&mut self) {
            if let Some(previous) = self.previous.take() {
                std::env::set_var("PI_CODING_AGENT_SESSION_DIR", previous);
            } else {
                std::env::remove_var("PI_CODING_AGENT_SESSION_DIR");
            }
        }
    }

    async fn state(storage: PathBuf) -> BridgeState {
        let identity = Arc::new(HostIdentityStore::new(&storage).load_or_create().unwrap());
        BridgeState {
            config: RemoteConfig::default(),
            devices: Arc::new(Mutex::new(DeviceStore::load_or_create(&storage).unwrap())),
            pairing: Arc::new(Mutex::new(None)),
            storage,
            identity,
            manager: Arc::new(PiManager::default()),
        }
    }

    fn request(method: Method, uri: &str, request_id: &str, body: Body) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(PROTOCOL_HEADER, "1")
            .header(REQUEST_ID_HEADER, request_id)
            .extension(ConnectInfo("127.0.0.1:9000".parse::<SocketAddr>().unwrap()))
            .body(body)
            .unwrap()
    }

    async fn response_json(response: Response) -> serde_json::Value {
        serde_json::from_slice(
            &to_bytes(response.into_body(), MAX_HTTP_BODY_BYTES)
                .await
                .unwrap(),
        )
        .unwrap()
    }

    async fn authorize(state: &BridgeState) {
        state
            .devices
            .lock()
            .await
            .add_device(
                "82c6fbb6-fa93-4672-8b48-b7755a947e7d".into(),
                "Phone".into(),
                TEST_TOKEN,
                unix_seconds(),
            )
            .unwrap();
    }

    fn authorized_request(method: Method, uri: &str, request_id: &str) -> Request<Body> {
        let mut request = request(method, uri, request_id, Body::empty());
        request.headers_mut().insert(
            header::AUTHORIZATION,
            format!("Bearer {TEST_TOKEN}").parse().unwrap(),
        );
        request
    }

    fn sync_project(storage: &std::path::Path, project: &std::path::Path, trusted: bool) -> String {
        let mut catalog = ProjectCatalog::load_or_create(storage).unwrap();
        let summaries = catalog
            .sync_projects(
                &[KnownProjectInput {
                    path: project.to_string_lossy().into_owned(),
                    trusted,
                    last_opened: 1,
                    pinned: None,
                }],
                None,
            )
            .unwrap();
        serde_json::to_value(&summaries[0]).unwrap()["projectId"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn write_session(
        path: &std::path::Path,
        project: &std::path::Path,
        pi_id: &str,
        parent: Option<&str>,
        name: Option<&str>,
        first_message: &str,
    ) {
        let mut header = serde_json::json!({
            "type": "session",
            "id": pi_id,
            "cwd": project.canonicalize().unwrap().to_string_lossy(),
        });
        if let Some(parent) = parent {
            header["parentSession"] = serde_json::Value::String(parent.to_string());
        }
        let mut records = vec![header];
        if let Some(name) = name {
            records.push(serde_json::json!({ "type": "session_info", "name": name }));
        }
        records.push(serde_json::json!({
            "type": "message",
            "message": { "role": "user", "content": first_message },
        }));
        records.push(serde_json::json!({
            "type": "message",
            "timestamp": "2026-08-03T01:20:00.000Z",
            "message": {
                "role": "assistant",
                "content": "Done",
                "stopReason": "stop",
            },
        }));
        let contents = records
            .into_iter()
            .map(|record| serde_json::to_string(&record).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(path, format!("{contents}\n")).unwrap();
    }

    #[tokio::test]
    async fn protocol_precedence_headers_and_peer_policy_are_enforced() {
        let root = tempdir().unwrap();
        let app = router(state(root.path().to_path_buf()).await);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/health")
                    .header(PROTOCOL_HEADER, "2")
                    .header(REQUEST_ID_HEADER, "bad")
                    .extension(ConnectInfo("127.0.0.1:1".parse::<SocketAddr>().unwrap()))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UPGRADE_REQUIRED);
        assert_eq!(response.headers()[PROTOCOL_HEADER], "1");
        assert!(Uuid::parse_str(response.headers()[REQUEST_ID_HEADER].to_str().unwrap()).is_ok());

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/health")
                    .header(PROTOCOL_HEADER, "1")
                    .header(REQUEST_ID_HEADER, "7c9b9c14-e910-4be7-8878-5d3ed02b2f02")
                    .extension(ConnectInfo("8.8.8.8:1".parse::<SocketAddr>().unwrap()))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            response.headers()[REQUEST_ID_HEADER],
            "7c9b9c14-e910-4be7-8878-5d3ed02b2f02"
        );
    }

    #[tokio::test]
    async fn health_has_safe_v1_shape_and_capability_intersection() {
        let root = tempdir().unwrap();
        let app = router(state(root.path().to_path_buf()).await);
        let mut request = request(
            Method::GET,
            "/v1/health",
            "7c9b9c14-e910-4be7-8878-5d3ed02b2f02",
            Body::empty(),
        );
        request.headers_mut().insert(
            CAPABILITIES_HEADER,
            "events,projects,unknown".parse().unwrap(),
        );
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let value = response_json(response).await;
        assert_eq!(value["protocol"], 1);
        assert_eq!(
            value["data"]["capabilities"],
            serde_json::json!(["projects"])
        );
        assert_eq!(
            value["data"]["acceptedCapabilities"],
            serde_json::json!(["projects"])
        );
        assert_eq!(
            value["data"]["limits"]["httpBodyBytes"],
            MAX_HTTP_BODY_BYTES
        );
        assert!(value.to_string().contains("hostId"));
    }

    #[tokio::test]
    async fn pairing_validates_body_and_persists_only_digest() {
        let root = tempdir().unwrap();
        let state = state(root.path().to_path_buf()).await;
        let code = {
            let mut pairing = state.pairing.lock().await;
            *pairing = Some(PairingWindow::open_at(unix_seconds()));
            pairing
                .as_mut()
                .unwrap()
                .display_code_at(unix_seconds())
                .unwrap()
                .to_string()
        };
        let app = router(state.clone());
        let request_id = "7c9b9c14-e910-4be7-8878-5d3ed02b2f02";
        let body = serde_json::json!({
            "code": code,
            "deviceId": "82c6fbb6-fa93-4672-8b48-b7755a947e7d",
            "displayName": "Maya's iPhone"
        });
        let mut pair_request = request(
            Method::POST,
            "/v1/pair",
            request_id,
            Body::from(body.to_string()),
        );
        pair_request
            .headers_mut()
            .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        let response = app.clone().oneshot(pair_request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let value = response_json(response).await;
        let token = value["data"]["token"].as_str().unwrap().to_string();
        assert_eq!(
            value["data"]["device"]["id"],
            "82c6fbb6-fa93-4672-8b48-b7755a947e7d"
        );
        let stored = std::fs::read_to_string(root.path().join("devices.json")).unwrap();
        assert!(!stored.contains(&token));

        let duplicate_code = {
            let mut pairing = state.pairing.lock().await;
            *pairing = Some(PairingWindow::open_at(unix_seconds()));
            pairing
                .as_mut()
                .unwrap()
                .display_code_at(unix_seconds())
                .unwrap()
                .to_string()
        };
        let duplicate = serde_json::json!({
            "code": duplicate_code,
            "deviceId": "82c6fbb6-fa93-4672-8b48-b7755a947e7d",
            "displayName": "Maya's iPhone"
        });
        let mut duplicate_request = request(
            Method::POST,
            "/v1/pair",
            request_id,
            Body::from(duplicate.to_string()),
        );
        duplicate_request
            .headers_mut()
            .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        let response = app.oneshot(duplicate_request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            response_json(response).await["error"]["code"],
            "device_id_already_paired"
        );
    }

    #[tokio::test]
    async fn pairing_errors_do_not_disclose_attempt_counts_or_codes() {
        let root = tempdir().unwrap();
        let state = state(root.path().to_path_buf()).await;
        let code = {
            let mut pairing = state.pairing.lock().await;
            *pairing = Some(PairingWindow::open_at(unix_seconds()));
            pairing
                .as_mut()
                .unwrap()
                .display_code_at(unix_seconds())
                .unwrap()
                .to_string()
        };
        let app = router(state);
        let request_id = "7c9b9c14-e910-4be7-8878-5d3ed02b2f02";
        for attempt in 1..=5 {
            let body = serde_json::json!({
                "code": "00000000",
                "deviceId": "82c6fbb6-fa93-4672-8b48-b7755a947e7d",
                "displayName": "Maya's iPhone"
            });
            let mut request = request(
                Method::POST,
                "/v1/pair",
                request_id,
                Body::from(body.to_string()),
            );
            request
                .headers_mut()
                .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
            let response = app.clone().oneshot(request).await.unwrap();
            let expected = if attempt == 5 {
                StatusCode::TOO_MANY_REQUESTS
            } else {
                StatusCode::UNAUTHORIZED
            };
            assert_eq!(response.status(), expected);
            let value = response_json(response).await;
            assert!(!value.to_string().contains(&code));
            assert!(value["error"].get("attemptsRemaining").is_none());
        }

        let request = request(Method::POST, "/v1/pair", request_id, Body::from("{}"));
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    #[tokio::test]
    async fn projects_requires_a_valid_unrevoked_bearer_and_never_leaks_paths() {
        let root = tempdir().unwrap();
        let project = root.path().join("private-project");
        std::fs::create_dir(&project).unwrap();
        let state = state(root.path().to_path_buf()).await;
        let mut catalog = ProjectCatalog::load_or_create(root.path()).unwrap();
        catalog
            .sync_projects(
                &[KnownProjectInput {
                    path: project.to_string_lossy().into_owned(),
                    trusted: true,
                    last_opened: 1,
                    pinned: None,
                }],
                None,
            )
            .unwrap();
        let token = "0LihExfkXNrXC_i04AvBeOx_Iyo9RsmXKQ66wPQPzcw";
        state
            .devices
            .lock()
            .await
            .add_device(
                "82c6fbb6-fa93-4672-8b48-b7755a947e7d".into(),
                "Phone".into(),
                token,
                unix_seconds(),
            )
            .unwrap();
        let app = router(state.clone());
        let request_id = "7c9b9c14-e910-4be7-8878-5d3ed02b2f02";
        let response = app
            .clone()
            .oneshot(request(
                Method::GET,
                "/v1/projects",
                request_id,
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let mut authorized_request =
            request(Method::GET, "/v1/projects", request_id, Body::empty());
        authorized_request.headers_mut().insert(
            header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        let response = app.clone().oneshot(authorized_request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), MAX_HTTP_BODY_BYTES)
            .await
            .unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains(project.to_string_lossy().as_ref()));
        state
            .devices
            .lock()
            .await
            .revoke("82c6fbb6-fa93-4672-8b48-b7755a947e7d")
            .unwrap();
        let mut revoked_request = request(Method::GET, "/v1/projects", request_id, Body::empty());
        revoked_request.headers_mut().insert(
            header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        let response = app.oneshot(revoked_request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn sessions_returns_safe_stable_opaque_catalogue_and_projects_only_capability() {
        let _environment_lock = SESSION_DIRECTORY_ENV.lock().unwrap();
        let root = tempdir().unwrap();
        let project = root.path().join("private-project-location");
        let sessions = root.path().join("private-session-directory");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&sessions).unwrap();
        let _override = SessionDirectoryOverride::set(&sessions);
        let state = state(root.path().to_path_buf()).await;
        let project_id = sync_project(root.path(), &project, true);
        let session_path = sessions.join("private-session-file.jsonl");
        let parent_path = root.path().join("private-parent-session.jsonl");
        let pi_id = "pi-internal-session-id-should-not-escape";
        write_session(
            &session_path,
            &project,
            pi_id,
            Some(parent_path.to_string_lossy().as_ref()),
            Some("Remote bridge"),
            &format!(
                "Summarize the remote work in {} from {pi_id} at {}.",
                project.display(),
                session_path.display()
            ),
        );
        authorize(&state).await;
        let app = router(state);
        let request_id = "7c9b9c14-e910-4be7-8878-5d3ed02b2f02";
        let uri = format!("/v1/sessions?projectId={project_id}");
        let mut first_request = authorized_request(Method::GET, &uri, request_id);
        first_request.headers_mut().insert(
            CAPABILITIES_HEADER,
            "projects,state,rpc,events".parse().unwrap(),
        );
        let first_response = app.clone().oneshot(first_request).await.unwrap();
        assert_eq!(first_response.status(), StatusCode::OK);
        assert_eq!(first_response.headers()[PROTOCOL_HEADER], "1");
        assert_eq!(first_response.headers()[REQUEST_ID_HEADER], request_id);
        let first_bytes = to_bytes(first_response.into_body(), MAX_HTTP_BODY_BYTES)
            .await
            .unwrap();
        let serialized = String::from_utf8(first_bytes.to_vec()).unwrap();
        for secret in [
            project.to_string_lossy().as_ref(),
            session_path.to_string_lossy().as_ref(),
            parent_path.to_string_lossy().as_ref(),
            "private-project-location",
            "private-session-directory",
            "private-session-file.jsonl",
            "private-parent-session.jsonl",
            pi_id,
        ] {
            assert!(
                !serialized.contains(secret),
                "leaked {secret}: {serialized}"
            );
        }
        let first: serde_json::Value = serde_json::from_slice(&first_bytes).unwrap();
        assert_eq!(
            first,
            serde_json::json!({
                "protocol": 1,
                "requestId": request_id,
                "data": {
                    "projectId": project_id,
                    "sessions": [first["data"]["sessions"][0].clone()],
                    "acceptedCapabilities": ["projects"],
                },
            })
        );
        let session = &first["data"]["sessions"][0];
        assert_eq!(session.as_object().unwrap().len(), 6);
        assert_eq!(session["name"], "Remote bridge");
        assert_eq!(session["messageCount"], 2);
        assert!(session["firstMessagePreview"]
            .as_str()
            .unwrap()
            .starts_with("Summarize the remote work"));
        assert!(
            session["firstMessagePreview"]
                .as_str()
                .unwrap()
                .chars()
                .count()
                <= 280
        );
        assert_eq!(session["lastFinalReplyAt"], "2026-08-03T01:20:00Z");
        assert!(normalized_utc_timestamp(session["modifiedAt"].as_str().unwrap()).is_some());
        let session_id = session["sessionId"].as_str().unwrap().to_string();
        assert!(session_id.starts_with("session_"));

        let second_response = app
            .oneshot(authorized_request(Method::GET, &uri, request_id))
            .await
            .unwrap();
        assert_eq!(second_response.status(), StatusCode::OK);
        let second = response_json(second_response).await;
        assert_eq!(second["data"]["sessions"][0]["sessionId"], session_id);
    }

    #[tokio::test]
    async fn sessions_rejects_invalid_queries_and_uses_uniform_auth_and_not_found_errors() {
        let root = tempdir().unwrap();
        let state = state(root.path().to_path_buf()).await;
        authorize(&state).await;
        let app = router(state.clone());
        let request_id = "7c9b9c14-e910-4be7-8878-5d3ed02b2f02";

        let missing_auth = app
            .clone()
            .oneshot(request(
                Method::GET,
                "/v1/sessions?projectId=unknown-project",
                request_id,
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(missing_auth.status(), StatusCode::UNAUTHORIZED);
        let missing_auth_body = response_json(missing_auth).await;
        assert_eq!(missing_auth_body["error"]["code"], "unauthenticated");

        for uri in [
            "/v1/sessions",
            "/v1/sessions?",
            "/v1/sessions?projectId",
            "/v1/sessions?projectId=",
            "/v1/sessions?projectId=one&projectId=two",
            "/v1/sessions?projectId=one&extra=two",
            "/v1/sessions?extra=one",
            "/v1/sessions?projectId=%ZZ",
            "/v1/sessions?projectId=%FF",
            "/v1/sessions?projectId=%2Fprivate%2Fproject",
            "/v1/sessions?projectId=one+two",
        ] {
            let response = app
                .clone()
                .oneshot(authorized_request(Method::GET, uri, request_id))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{uri}");
            assert_eq!(response.headers()[PROTOCOL_HEADER], "1");
            assert_eq!(response.headers()[REQUEST_ID_HEADER], request_id);
            assert_eq!(
                response_json(response).await["error"]["code"],
                "malformed_request",
                "{uri}"
            );
        }

        let unknown_id = "unknown-project";
        let not_found = app
            .clone()
            .oneshot(authorized_request(
                Method::GET,
                &format!("/v1/sessions?projectId={unknown_id}"),
                request_id,
            ))
            .await
            .unwrap();
        assert_eq!(not_found.status(), StatusCode::NOT_FOUND);
        let not_found_bytes = to_bytes(not_found.into_body(), MAX_HTTP_BODY_BYTES)
            .await
            .unwrap();
        assert!(!String::from_utf8_lossy(&not_found_bytes).contains(unknown_id));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&not_found_bytes).unwrap()["error"]["code"],
            "project_not_found"
        );

        state
            .devices
            .lock()
            .await
            .revoke("82c6fbb6-fa93-4672-8b48-b7755a947e7d")
            .unwrap();
        let revoked = app
            .oneshot(authorized_request(
                Method::GET,
                "/v1/sessions?projectId=unknown-project",
                request_id,
            ))
            .await
            .unwrap();
        assert_eq!(revoked.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response_json(revoked).await, missing_auth_body);
    }

    #[tokio::test]
    async fn untrusted_projects_return_empty_catalogues_and_clear_stale_session_ids() {
        let root = tempdir().unwrap();
        let project = root.path().join("untrusted-project");
        let sessions = root.path().join("sessions");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&sessions).unwrap();
        let session = sessions.join("stale.jsonl");
        std::fs::write(&session, "{}\n").unwrap();
        let project_id = sync_project(root.path(), &project, true);
        let stale_session_id = {
            let mut catalog = ProjectCatalog::load_or_create(root.path()).unwrap();
            catalog
                .sync_sessions(
                    &project_id,
                    &sessions,
                    &[SessionSyncInput {
                        path: session.clone(),
                    }],
                )
                .unwrap();
            catalog
                .session_id_for_path(&project_id, &sessions, &session)
                .unwrap()
        };
        assert_eq!(sync_project(root.path(), &project, false), project_id);

        let state = state(root.path().to_path_buf()).await;
        authorize(&state).await;
        let response = router(state)
            .oneshot(authorized_request(
                Method::GET,
                &format!("/v1/sessions?projectId={project_id}"),
                "7c9b9c14-e910-4be7-8878-5d3ed02b2f02",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let value = response_json(response).await;
        assert_eq!(value["data"]["sessions"], serde_json::json!([]));
        assert!(!value.to_string().contains(&stale_session_id));
        let catalog = ProjectCatalog::load_or_create(root.path()).unwrap();
        assert!(catalog
            .session_id_for_path(&project_id, &sessions, &session)
            .is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn replaced_projects_and_session_symlink_escapes_are_not_exposed() {
        use std::os::unix::fs::symlink;

        let _environment_lock = SESSION_DIRECTORY_ENV.lock().unwrap();
        let root = tempdir().unwrap();
        let project = root.path().join("project");
        let sessions = root.path().join("sessions");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&sessions).unwrap();
        let _override = SessionDirectoryOverride::set(&sessions);
        let state = state(root.path().to_path_buf()).await;
        let project_id = sync_project(root.path(), &project, true);
        authorize(&state).await;
        let app = router(state);
        let request_id = "7c9b9c14-e910-4be7-8878-5d3ed02b2f02";

        let outside = root.path().join("outside-session.jsonl");
        write_session(
            &outside,
            &project,
            "outside-pi-id",
            None,
            None,
            "SYMLINK_ESCAPE_SECRET",
        );
        symlink(&outside, sessions.join("escape.jsonl")).unwrap();
        let response = app
            .clone()
            .oneshot(authorized_request(
                Method::GET,
                &format!("/v1/sessions?projectId={project_id}"),
                request_id,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), MAX_HTTP_BODY_BYTES)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["data"]["sessions"],
            serde_json::json!([])
        );
        assert!(!String::from_utf8_lossy(&bytes).contains("SYMLINK_ESCAPE_SECRET"));

        let moved = root.path().join("moved-project");
        std::fs::rename(&project, &moved).unwrap();
        symlink(&moved, &project).unwrap();
        let response = app
            .oneshot(authorized_request(
                Method::GET,
                &format!("/v1/sessions?projectId={project_id}"),
                request_id,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response_json(response).await["error"]["code"],
            "project_not_found"
        );
    }

    #[test]
    fn session_projection_helpers_enforce_opaque_query_and_safe_text_timestamp_bounds() {
        assert_eq!(
            project_id_query(&"/v1/sessions?project%49d=project_abc-123".parse().unwrap()),
            Some("project_abc-123".to_string())
        );
        let long = "🍋".repeat(300);
        assert_eq!(
            safe_session_text(&long, &[], 280).unwrap().chars().count(),
            280
        );
        assert_eq!(
            normalized_utc_timestamp("2026-08-03T01:20:00.011Z").as_deref(),
            Some("2026-08-03T01:20:00.011Z")
        );
        for invalid in ["2026-02-30T01:20:00Z", "2026-08-03T01:20:00+01:00", "1234"] {
            assert!(normalized_utc_timestamp(invalid).is_none());
        }
    }

    #[tokio::test]
    async fn content_length_limit_and_request_summary_are_safe() {
        let root = tempdir().unwrap();
        let app = router(state(root.path().to_path_buf()).await);
        let mut request = request(
            Method::POST,
            "/v1/pair",
            "7c9b9c14-e910-4be7-8878-5d3ed02b2f02",
            Body::from(vec![b'x'; MAX_HTTP_BODY_BYTES + 1]),
        );
        request
            .headers_mut()
            .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let secret = "0LihExfkXNrXC_i04AvBeOx_Iyo9RsmXKQ66wPQPzcw";
        let summary = redacted_request_summary(
            &Method::POST,
            &format!("/v1/pair?token={secret}").parse::<Uri>().unwrap(),
            StatusCode::UNAUTHORIZED,
        );
        assert!(!summary.contains(secret));
        assert!(!summary.contains("body"));
    }

    #[tokio::test]
    async fn finite_deadline_helper_releases_stalled_connection_work() {
        assert_eq!(
            complete_within(Duration::from_millis(1), std::future::ready("complete")).await,
            Some("complete")
        );
        assert_eq!(
            complete_within(Duration::ZERO, std::future::pending::<()>()).await,
            None
        );
        assert_eq!(TLS_HANDSHAKE_TIMEOUT, Duration::from_secs(10));
        assert_eq!(HTTP_CONNECTION_LIFETIME, Duration::from_secs(60));
    }

    #[test]
    fn persisted_identity_builds_a_ring_backed_tls_server_config() {
        let root = tempdir().unwrap();
        let identity = HostIdentityStore::new(root.path())
            .load_or_create()
            .unwrap();
        assert!(tls_server_config(&identity).is_ok());
    }
}
