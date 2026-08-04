//! The deliberately small, pinned-TLS HTTP surface for LemonPi Go v1.
//!
//! This module owns the small HTTP catalogue/hydration surface, one authenticated allowlisted Pi
//! command route, and the authenticated server-only event WebSocket. It deliberately has no generic
//! Pi command, filesystem, or settings route. Internal paths remain confined to crate-private code;
//! handlers serialize only strict safe projections.

use super::{
    auth::{DeviceStore, PairingAttempt, PairingWindow},
    config::{AccessMode, RemoteConfig},
    events::{
        EventEnvelope as InternalEventEnvelope, EventHub, EventKind as InternalEventKind,
        EVENT_SOCKET_CAPACITY,
    },
    hydration::{self, HydrationError},
    identity::HostIdentity,
    policy::allows_peer,
    projects::{InternalProjectBinding, ProjectCatalog, RemoteProjectSummary, SessionSyncInput},
    protocol::{
        Capability, Envelope, EventEnvelope as WireEventEnvelope, EventKind as WireEventKind,
        EventPayload, Health, Hello, Limits, MessagesResponse, PairRequest, PairResponse,
        PairedDevice, ProjectSummary, ProjectedPiEvent, ProtocolError, RpcAccepted, RpcRequest,
        SafeMessage, SessionState, SessionSummary, SessionsResponse, StateResponse,
    },
    restrict_file_permissions, RemoteError, RemoteResult,
};
use crate::{list_pi_sessions_sync, session_directory, PiManager, PiSessionSummary};
use axum::{
    body::{to_bytes, Body},
    extract::{
        ws::{close_code, CloseFrame, Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, State,
    },
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
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
    fs::{self, OpenOptions},
    future::Future,
    io::Write,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use time::{
    format_description::well_known::Rfc3339, Date, Month, OffsetDateTime, PrimitiveDateTime, Time,
};
use tokio::{
    net::TcpStream,
    sync::{broadcast, watch, Mutex, OwnedSemaphorePermit},
};
use tokio_rustls::TlsAcceptor;
use tower::ServiceExt;
use uuid::Uuid;

pub(crate) const MAX_HTTP_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES: usize = 256 * 1024;
/// Slow allowed peers must complete TLS before consuming a server task indefinitely.
pub(crate) const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Slow HTTP connections must finish request/response service within this deadline. Hyper hands
/// upgraded WebSocket tasks off after the 101 response, so event sockets are not bounded by it.
pub(crate) const HTTP_CONNECTION_LIFETIME: Duration = Duration::from_secs(60);
pub(crate) const EVENT_ENVELOPE_BYTES: u64 = 1024 * 1024;
pub(crate) const DEVICE_LIMIT: u64 = 16;
pub(crate) const SOCKET_LIMIT: u64 = EVENT_SOCKET_CAPACITY as u64;
pub(crate) const REPLAY_EVENT_LIMIT: u64 = 4096;
pub(crate) const BROADCAST_QUEUE_LIMIT: u64 = 1024;

const PROTOCOL_HEADER: &str = "x-lemonpi-protocol";
const REQUEST_ID_HEADER: &str = "x-lemonpi-request-id";
const CAPABILITIES_HEADER: &str = "x-lemonpi-capabilities";

/// Only capabilities backed by this listener slice are advertised. The frozen model accepts the
/// complete v1 token vocabulary, but an unfinished capability is never advertised as available.
const AVAILABLE_CAPABILITIES: &[Capability] = &[
    Capability::Projects,
    Capability::State,
    Capability::Rpc,
    Capability::Events,
];

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

enum SessionTransactionResult {
    Sessions(Vec<SessionSummary>),
    ProjectNotFound,
    HostUnavailable,
}

enum StateSessionTransactionResult {
    Session(String),
    ProjectNotFound,
    HostUnavailable,
}

struct StateProjectResource {
    binding: InternalProjectBinding,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StateResourceError {
    ProjectNotFound,
    HostUnavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MessagesResourceError {
    ProjectNotFound,
    SessionNotFound,
    HostUnavailable,
}

struct MessagesQuery {
    project_id: String,
    session_id: String,
    limit: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RpcResourceError {
    ProjectNotFound,
    SessionNotFound,
    HostUnavailable,
}

struct RpcResource {
    project: InternalProjectBinding,
    session_path: Option<PathBuf>,
}

/// Server-private evidence that this request created the session file. It is never serialized.
struct CreatedPiSession {
    path: PathBuf,
    command_path: String,
    metadata: fs::Metadata,
}

enum ValidatedRpcCommand {
    NewSession,
    Prompt(String),
    Abort,
    SwitchSession,
}

#[cfg(test)]
#[derive(Clone)]
struct TranscriptResolutionBarrier {
    session_id: String,
    entered: Arc<std::sync::Barrier>,
    release: Arc<std::sync::Barrier>,
}

#[cfg(test)]
static TEST_TRANSCRIPT_RESOLUTION_BARRIER: std::sync::Mutex<Option<TranscriptResolutionBarrier>> =
    std::sync::Mutex::new(None);

#[cfg(test)]
struct TranscriptResolutionBarrierGuard;

#[cfg(test)]
impl Drop for TranscriptResolutionBarrierGuard {
    fn drop(&mut self) {
        *TEST_TRANSCRIPT_RESOLUTION_BARRIER
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }
}

#[cfg(test)]
fn pause_after_session_resolution(session_id: &str) {
    let barrier = TEST_TRANSCRIPT_RESOLUTION_BARRIER
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .filter(|barrier| barrier.session_id == session_id);
    if let Some(barrier) = barrier {
        barrier.entered.wait();
        barrier.release.wait();
    }
}

#[cfg(not(test))]
fn pause_after_session_resolution(_: &str) {}

/// Builds the v1 router. The actual TCP listener also checks peers before TLS negotiation; this
/// route-level check keeps the rule true for every request and permits deterministic router tests.
pub(crate) fn router(state: BridgeState) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/pair", post(pair))
        .route("/v1/projects", get(projects))
        .route("/v1/sessions", get(sessions))
        .route("/v1/state", get(state_snapshot))
        .route("/v1/messages", get(messages))
        .route("/v1/rpc", post(rpc))
        .route("/v1/events", get(events))
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
    let storage = state.storage.clone();
    let summaries = match tokio::task::spawn_blocking(move || {
        ProjectCatalog::load_or_create(&storage)
            .map(|catalog| catalog.safe_projects(active_project.as_deref()))
    })
    .await
    {
        Ok(Ok(summaries)) => summaries,
        Ok(Err(_)) | Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                &context.request_id,
                "host_unavailable",
                "The host cannot provide projects right now.",
                true,
            )
        }
    };
    let Some(_authentication_lease) = authentication_lease(&headers, &state).await else {
        return unauthenticated(&context.request_id);
    };
    success(
        StatusCode::OK,
        &context.request_id,
        ProjectsPayload {
            projects: summaries,
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

    let Some(_authentication_lease) = authentication_lease(&headers, &state).await else {
        return unauthenticated(&context.request_id);
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

async fn state_snapshot(
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
        return unauthenticated(&context.request_id);
    }
    if !AVAILABLE_CAPABILITIES.contains(&Capability::State) {
        return error(
            StatusCode::NOT_IMPLEMENTED,
            &context.request_id,
            "capability_unavailable",
            "Live state is not available on this host.",
            false,
        );
    }
    let Some(project_id) = project_id_query(&uri) else {
        return error(
            StatusCode::BAD_REQUEST,
            &context.request_id,
            "malformed_request",
            "The state request is invalid.",
            false,
        );
    };

    let active_project = state.manager.remote_active_project().await;
    let storage = state.storage.clone();
    let requested_project_id = project_id.clone();
    let resource = match tokio::task::spawn_blocking(move || {
        state_project_resource(&storage, &requested_project_id, active_project.as_deref())
    })
    .await
    {
        Ok(Ok(resource)) => resource,
        Ok(Err(error_kind)) => {
            return state_resource_error(&context.request_id, error_kind);
        }
        Err(_) => {
            return state_resource_error(&context.request_id, StateResourceError::HostUnavailable);
        }
    };
    if !resource.binding.trusted {
        return state_resource_error(&context.request_id, StateResourceError::HostUnavailable);
    }

    let Some(live) = state
        .manager
        .remote_live_state(&resource.binding.path)
        .await
    else {
        return state_resource_error(&context.request_id, StateResourceError::HostUnavailable);
    };
    let active_session = if let Some(session_path) = live.state.session_file.clone() {
        let storage = state.storage.clone();
        let requested_project_id = project_id.clone();
        let project_path = resource.binding.path.clone();
        let mapped_path = session_path.clone();
        let session_id = match tokio::task::spawn_blocking(move || {
            state_session_id(&storage, &requested_project_id, &project_path, &mapped_path)
        })
        .await
        {
            Ok(Ok(session_id)) => session_id,
            Ok(Err(error_kind)) => {
                return state_resource_error(&context.request_id, error_kind);
            }
            Err(_) => {
                return state_resource_error(
                    &context.request_id,
                    StateResourceError::HostUnavailable,
                );
            }
        };
        Some((session_id, session_path))
    } else {
        None
    };

    // Revalidate catalogue trust and the optional active session mapping after all blocking work.
    let storage = state.storage.clone();
    let requested_project_id = project_id.clone();
    let project_path = resource.binding.path.clone();
    let active_session_for_check = active_session.clone();
    let project = match tokio::task::spawn_blocking(move || {
        revalidate_state_project(
            &storage,
            &requested_project_id,
            &project_path,
            active_session_for_check.as_ref(),
        )
    })
    .await
    {
        Ok(Ok(project)) => project,
        Ok(Err(error_kind)) => {
            return state_resource_error(&context.request_id, error_kind);
        }
        Err(_) => {
            return state_resource_error(&context.request_id, StateResourceError::HostUnavailable);
        }
    };
    if !state.manager.remote_live_state_is_current(&live).await {
        return state_resource_error(&context.request_id, StateResourceError::HostUnavailable);
    }

    let session_name = active_session
        .as_ref()
        .and_then(|_| live.state.session_name.clone());
    let session_id = active_session.map(|(session_id, _)| session_id);
    let Some(_authentication_lease) = authentication_lease(&headers, &state).await else {
        return unauthenticated(&context.request_id);
    };
    success(
        StatusCode::OK,
        &context.request_id,
        StateResponse {
            project,
            state: SessionState {
                session_id,
                session_name,
                is_streaming: live.state.is_streaming,
                is_compacting: live.state.is_compacting,
                thinking_level: live.state.thinking_level.as_str().to_string(),
                message_count: live.state.message_count,
                pending_message_count: live.state.pending_message_count,
            },
            accepted_capabilities: context.accepted_capabilities,
        },
    )
}

async fn messages(
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
        return unauthenticated(&context.request_id);
    }
    if !AVAILABLE_CAPABILITIES.contains(&Capability::State) {
        return error(
            StatusCode::NOT_IMPLEMENTED,
            &context.request_id,
            "capability_unavailable",
            "Transcript hydration is not available on this host.",
            false,
        );
    }
    let Some(query) = messages_query(&uri) else {
        return error(
            StatusCode::BAD_REQUEST,
            &context.request_id,
            "malformed_request",
            "The messages request is invalid.",
            false,
        );
    };

    let storage = state.storage.clone();
    let requested_project_id = query.project_id.clone();
    let requested_session_id = query.session_id.clone();
    let limit = query.limit;
    let result = tokio::task::spawn_blocking(move || {
        hydrated_messages(
            &storage,
            &requested_project_id,
            &requested_session_id,
            limit,
        )
    })
    .await;
    let projected = match result {
        Ok(Ok(messages)) => messages,
        Ok(Err(error_kind)) => {
            return messages_resource_error(&context.request_id, error_kind);
        }
        Err(_) => {
            return messages_resource_error(
                &context.request_id,
                MessagesResourceError::HostUnavailable,
            );
        }
    };

    let Some(_authentication_lease) = authentication_lease(&headers, &state).await else {
        return unauthenticated(&context.request_id);
    };
    success(
        StatusCode::OK,
        &context.request_id,
        MessagesResponse {
            project_id: query.project_id,
            session_id: query.session_id,
            messages: projected,
            accepted_capabilities: context.accepted_capabilities,
        },
    )
}

async fn events(
    State(state): State<BridgeState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    websocket: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
) -> Response {
    let context = match validate_request(&headers, peer, state.config.access_mode) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(authentication) = authentication_lease(&headers, &state).await else {
        return unauthenticated(&context.request_id);
    };
    let since = match event_since_query(&uri) {
        Some(since) => since,
        None => {
            return error(
                StatusCode::BAD_REQUEST,
                &context.request_id,
                "malformed_request",
                "The event stream request is invalid.",
                false,
            )
        }
    };
    let websocket = match websocket {
        Ok(websocket) => websocket,
        Err(_) => {
            return error(
                StatusCode::BAD_REQUEST,
                &context.request_id,
                "malformed_request",
                "The event stream request is invalid.",
                false,
            )
        }
    };

    let hub = state.manager.remote_event_hub();
    let Some(socket_permit) = hub.try_acquire_socket() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            &context.request_id,
            "socket_limit_reached",
            "The host cannot accept another event stream right now.",
            true,
        );
    };
    // Subscribe before selecting the hello cutoff so publication cannot race between replay and
    // the live receiver. Authorization remains leased through all pre-upgrade validation.
    let receiver = hub.subscribe();
    let cutoff = hub.high_water_seq();
    if since.is_some_and(|since| since > cutoff) {
        return error(
            StatusCode::BAD_REQUEST,
            &context.request_id,
            "malformed_request",
            "The event stream request is invalid.",
            false,
        );
    }
    drop(authentication);

    let storage = state.storage.clone();
    let host_id = state.identity.host_id().to_string();
    let capabilities = context.accepted_capabilities;
    let request_id = context.request_id;
    let mut response = websocket
        .max_message_size(1024)
        .max_frame_size(1024)
        .on_upgrade(move |socket| {
            serve_event_socket(
                socket,
                socket_permit,
                hub,
                receiver,
                storage,
                host_id,
                capabilities,
                since,
                cutoff,
            )
        });
    response
        .headers_mut()
        .insert(PROTOCOL_HEADER, HeaderValue::from_static("1"));
    if let Ok(value) = request_id.parse::<HeaderValue>() {
        response.headers_mut().insert(REQUEST_ID_HEADER, value);
    }
    response
}

/// `Some(None)` is the valid query-less form, `Some(Some(_))` is one exact decimal UInt64, and
/// `None` rejects duplicate, encoded, signed, overflowing, or otherwise malformed values.
fn event_since_query(uri: &Uri) -> Option<Option<u64>> {
    let Some(query) = uri.query() else {
        return Some(None);
    };
    let value = query.strip_prefix("since=")?;
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse::<u64>().ok().map(Some)
}

fn event_socket_limits() -> Limits {
    Limits {
        http_body_bytes: None,
        event_envelope_bytes: EVENT_ENVELOPE_BYTES,
        devices: None,
        sockets: None,
        replay_events: REPLAY_EVENT_LIMIT,
        broadcast_queue: BROADCAST_QUEUE_LIMIT,
    }
}

async fn serve_event_socket(
    mut socket: WebSocket,
    _socket_permit: OwnedSemaphorePermit,
    hub: EventHub,
    mut receiver: broadcast::Receiver<InternalEventEnvelope>,
    storage: PathBuf,
    host_id: String,
    capabilities: Vec<Capability>,
    since: Option<u64>,
    cutoff: u64,
) {
    let hello = Hello {
        message_type: "hello".to_string(),
        protocol: super::protocol::PROTOCOL_VERSION,
        host_id,
        high_water_seq: cutoff,
        accepted_capabilities: capabilities,
        limits: event_socket_limits(),
    };
    let Ok(hello) = serde_json::to_string(&hello) else {
        close_event_socket(&mut socket, close_code::ERROR).await;
        return;
    };
    if socket.send(Message::Text(hello.into())).await.is_err() {
        return;
    }

    let replay_since = since.unwrap_or(cutoff);
    let replay = hub.replay_through(replay_since, cutoff);
    let mut cursor = replay_since;
    let mut skip_through = cutoff;
    for event in replay {
        cursor = cursor.max(event.seq);
        if event.kind == InternalEventKind::Gap {
            skip_through = skip_through.max(event.seq);
        }
        if !send_internal_event(&mut socket, &storage, event).await {
            return;
        }
    }

    loop {
        enum SocketAction {
            Incoming(Option<Result<Message, axum::Error>>),
            Event(Result<InternalEventEnvelope, broadcast::error::RecvError>),
        }
        let action = tokio::select! {
            incoming = socket.recv() => SocketAction::Incoming(incoming),
            event = receiver.recv() => SocketAction::Event(event),
        };
        match action {
            SocketAction::Incoming(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => {}
            SocketAction::Incoming(Some(Ok(Message::Close(frame)))) => {
                let _ = socket.send(Message::Close(frame)).await;
                return;
            }
            SocketAction::Incoming(Some(Ok(Message::Text(_) | Message::Binary(_)))) => {
                close_event_socket(&mut socket, close_code::POLICY).await;
                return;
            }
            SocketAction::Incoming(Some(Err(_)) | None) => return,
            SocketAction::Event(Ok(event)) => {
                if event.seq <= skip_through {
                    cursor = cursor.max(event.seq);
                    continue;
                }
                cursor = cursor.max(event.seq);
                if !send_internal_event(&mut socket, &storage, event).await {
                    return;
                }
            }
            SocketAction::Event(Err(broadcast::error::RecvError::Lagged(_))) => {
                let gap = hub.allocate_client_lag_gap(cursor.saturating_add(1));
                skip_through = gap.seq;
                cursor = gap.seq;
                if !send_internal_event(&mut socket, &storage, gap).await {
                    return;
                }
            }
            SocketAction::Event(Err(broadcast::error::RecvError::Closed)) => {
                close_event_socket(&mut socket, close_code::NORMAL).await;
                return;
            }
        }
    }
}

async fn close_event_socket(socket: &mut WebSocket, code: u16) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: "Event stream closed.".into(),
        })))
        .await;
}

async fn send_internal_event(
    socket: &mut WebSocket,
    storage: &Path,
    event: InternalEventEnvelope,
) -> bool {
    let storage = storage.to_path_buf();
    let projected = tokio::task::spawn_blocking(move || project_wire_event(&storage, &event)).await;
    let bytes = match projected {
        Ok(Ok(Some(bytes))) => bytes,
        Ok(Ok(None)) => return true,
        Ok(Err(())) | Err(_) => {
            close_event_socket(socket, close_code::ERROR).await;
            return false;
        }
    };
    let Ok(text) = String::from_utf8(bytes) else {
        close_event_socket(socket, close_code::ERROR).await;
        return false;
    };
    if socket.send(Message::Text(text.into())).await.is_err() {
        return false;
    }
    true
}

fn project_wire_event(
    storage: &Path,
    event: &InternalEventEnvelope,
) -> Result<Option<Vec<u8>>, ()> {
    let projected = (|| {
        let (project_id, session_id, secrets) = match event.kind {
            InternalEventKind::Gap => (None, None, Vec::new()),
            InternalEventKind::PiEvent | InternalEventKind::ProcessEvent => {
                let (project_id, session_id, secrets) = map_event_scope(storage, event)?;
                (Some(project_id), session_id, secrets)
            }
            InternalEventKind::Truncated if event.project.is_some() => {
                let (project_id, session_id, secrets) = map_event_scope(storage, event)?;
                (Some(project_id), session_id, secrets)
            }
            InternalEventKind::Truncated => (None, None, Vec::new()),
        };
        let timestamp = rfc3339_millis(event.published_at_millis)
            .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string());
        let (kind, payload) = match event.kind {
            InternalEventKind::PiEvent => (
                WireEventKind::PiEvent,
                EventPayload {
                    operation_id: None,
                    event: Some(project_pi_event(event, &secrets)?),
                    state: None,
                    exit_code: None,
                    message: None,
                    from_seq: None,
                    to_seq: None,
                    reason: None,
                    original_kind: None,
                    original_bytes: None,
                },
            ),
            InternalEventKind::ProcessEvent => (
                WireEventKind::ProcessEvent,
                project_process_payload(&event.payload)?,
            ),
            InternalEventKind::Gap => (WireEventKind::Gap, project_gap_payload(&event.payload)?),
            InternalEventKind::Truncated => (
                WireEventKind::Truncated,
                project_truncated_payload(&event.payload)?,
            ),
        };
        Some(WireEventEnvelope {
            seq: event.seq,
            timestamp,
            kind,
            project_id,
            session_id,
            payload,
        })
    })();
    let Some(projected) = projected else {
        return Ok(None);
    };
    let bytes = serde_json::to_vec(&projected).map_err(|_| ())?;
    if bytes.len() <= EVENT_ENVELOPE_BYTES as usize {
        return Ok(Some(bytes));
    }
    if !matches!(
        projected.kind,
        WireEventKind::PiEvent | WireEventKind::ProcessEvent
    ) {
        return Ok(None);
    }
    let original_kind = match projected.kind {
        WireEventKind::PiEvent => "piEvent",
        WireEventKind::ProcessEvent => "processEvent",
        _ => return Ok(None),
    };
    let truncated = WireEventEnvelope {
        seq: projected.seq,
        timestamp: projected.timestamp,
        kind: WireEventKind::Truncated,
        project_id: projected.project_id,
        session_id: projected.session_id,
        payload: EventPayload {
            operation_id: None,
            event: None,
            state: None,
            exit_code: None,
            message: None,
            from_seq: None,
            to_seq: None,
            reason: None,
            original_kind: Some(original_kind.to_string()),
            original_bytes: Some(u64::try_from(bytes.len()).map_err(|_| ())?),
        },
    };
    let truncated = serde_json::to_vec(&truncated).map_err(|_| ())?;
    if truncated.len() <= EVENT_ENVELOPE_BYTES as usize {
        Ok(Some(truncated))
    } else {
        Err(())
    }
}

fn map_event_scope(
    storage: &Path,
    event: &InternalEventEnvelope,
) -> Option<(String, Option<String>, Vec<String>)> {
    let project_path = event.project.as_deref()?;
    let catalog = ProjectCatalog::load_or_create(storage).ok()?;
    let binding = catalog
        .project_bindings()
        .into_iter()
        .find(|binding| binding.trusted && binding.path == project_path)?;
    let mut secrets = vec![
        project_path.to_string_lossy().into_owned(),
        binding.id.clone(),
    ];
    let session_id = if let Some(session_path) = event.session.as_deref() {
        let directory = session_directory(&binding.path).ok()?;
        secrets.push(directory.to_string_lossy().into_owned());
        secrets.push(session_path.to_string_lossy().into_owned());
        let id = catalog.session_id_for_path(&binding.id, &directory, session_path)?;
        secrets.push(id.clone());
        Some(id)
    } else {
        None
    };
    collect_pi_id_secrets(&event.payload, &mut secrets);
    Some((binding.id, session_id, secrets))
}

fn collect_pi_id_secrets(payload: &serde_json::Value, secrets: &mut Vec<String>) {
    for pointer in [
        "/id",
        "/sessionId",
        "/message/id",
        "/message/sessionId",
        "/message/toolCallId",
        "/assistantMessageEvent/id",
        "/assistantMessageEvent/toolCall/id",
    ] {
        if let Some(value) = payload.pointer(pointer) {
            match value {
                serde_json::Value::String(value) if !value.is_empty() => {
                    secrets.push(value.clone())
                }
                serde_json::Value::Number(value) => secrets.push(value.to_string()),
                _ => {}
            }
        }
    }
}

fn empty_projected_pi_event(event_type: &str) -> ProjectedPiEvent {
    ProjectedPiEvent {
        event_type: event_type.to_string(),
        message: None,
        target: None,
        text: None,
        steering_count: None,
        follow_up_count: None,
        command: None,
        success: None,
        data: None,
        error: None,
    }
}

fn project_pi_event(
    envelope: &InternalEventEnvelope,
    secrets: &[String],
) -> Option<ProjectedPiEvent> {
    let raw = envelope.payload.as_object()?;
    match raw.get("type")?.as_str()? {
        event_type @ ("agent_start" | "agent_settled") => {
            Some(empty_projected_pi_event(event_type))
        }
        "message_update" => {
            let update = raw
                .get("assistantMessageEvent")
                .and_then(serde_json::Value::as_object)?;
            let target = match update.get("type")?.as_str()? {
                "text_delta" => "text",
                "thinking_delta" => "thinking",
                _ => return None,
            };
            let text = safe_delta_text(update.get("delta")?.as_str()?, secrets, 16 * 1024)?;
            let mut projected = empty_projected_pi_event("message_delta");
            projected.target = Some(target.to_string());
            projected.text = Some(text);
            Some(projected)
        }
        event_type @ ("message_start" | "message_end") => {
            let message = raw.get("message")?.as_object()?;
            let mut projected = empty_projected_pi_event(event_type);
            projected.message = Some(project_safe_message(
                envelope.seq,
                envelope.published_at_millis,
                message,
                secrets,
            )?);
            Some(projected)
        }
        "queue_update" => {
            let steering = raw.get("steering")?.as_array()?;
            let follow_up = raw.get("followUp")?.as_array()?;
            let mut projected = empty_projected_pi_event("queue_update");
            projected.steering_count = u64::try_from(steering.len()).ok();
            projected.follow_up_count = u64::try_from(follow_up.len()).ok();
            Some(projected)
        }
        "response" => {
            let command = match raw.get("command")?.as_str()? {
                command @ ("new_session" | "prompt" | "abort" | "switch_session") => command,
                _ => return None,
            };
            let success = raw.get("success")?.as_bool()?;
            let mut projected = empty_projected_pi_event("response");
            projected.command = Some(command.to_string());
            projected.success = Some(success);
            if success {
                projected.data = Some(serde_json::json!({}));
            } else {
                projected.error = Some("The command could not be completed.".to_string());
            }
            Some(projected)
        }
        _ => None,
    }
}

fn project_safe_message(
    seq: u64,
    published_at_millis: u64,
    message: &serde_json::Map<String, serde_json::Value>,
    secrets: &[String],
) -> Option<SafeMessage> {
    let raw_role = message.get("role")?.as_str()?;
    let role = match raw_role {
        "user" => "user",
        "assistant" => "assistant",
        "tool" | "toolResult" => "tool",
        _ => return None,
    };
    let (text, thinking) = safe_message_content(message.get("content"), secrets);
    let thinking = (role == "assistant").then_some(thinking).flatten();
    let timestamp = message
        .get("timestamp")
        .and_then(normalized_event_timestamp)
        .unwrap_or_else(|| {
            rfc3339_millis(published_at_millis)
                .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string())
        });
    let is_error = message
        .get("isError")
        .and_then(serde_json::Value::as_bool)
        .or_else(|| {
            (message
                .get("stopReason")
                .and_then(serde_json::Value::as_str)
                == Some("error"))
            .then_some(true)
        });
    let (tool_name, tool_status) = if role == "tool" {
        let name = message
            .get("toolName")
            .and_then(serde_json::Value::as_str)
            .and_then(|name| hydration::sanitize_wire_text(name, secrets, 160));
        let status = is_error.map(|is_error| {
            if is_error {
                "error".to_string()
            } else {
                "complete".to_string()
            }
        });
        (name, status)
    } else {
        (None, None)
    };
    Some(SafeMessage {
        message_id: format!("message_{seq}"),
        role: role.to_string(),
        text,
        thinking,
        is_error,
        timestamp,
        tool_name,
        tool_status,
    })
}

fn safe_message_content(
    content: Option<&serde_json::Value>,
    secrets: &[String],
) -> (String, Option<String>) {
    let mut text = Vec::new();
    let mut thinking = Vec::new();
    match content {
        Some(serde_json::Value::String(value)) => text.push(value.as_str()),
        Some(serde_json::Value::Array(parts)) => {
            for part in parts {
                let Some(part) = part.as_object() else {
                    continue;
                };
                match part.get("type").and_then(serde_json::Value::as_str) {
                    Some("text") => {
                        if let Some(value) = part.get("text").and_then(serde_json::Value::as_str) {
                            text.push(value);
                        }
                    }
                    Some("thinking") => {
                        if let Some(value) =
                            part.get("thinking").and_then(serde_json::Value::as_str)
                        {
                            thinking.push(value);
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    let text = strip_attachment_markup(&text.join("\n"));
    let text = hydration::sanitize_wire_text(&text, secrets, 16 * 1024).unwrap_or_default();
    let thinking = strip_attachment_markup(&thinking.join("\n"));
    let thinking = hydration::sanitize_wire_text(&thinking, secrets, 16 * 1024);
    (text, thinking)
}

fn strip_attachment_markup(value: &str) -> String {
    const OPEN: &str = "<lemonpi-attachment";
    const CLOSE: &str = "</lemonpi-attachment>";
    let mut remaining = value;
    let mut output = String::with_capacity(value.len().min(16 * 1024));
    while let Some(start) = remaining.find(OPEN) {
        output.push_str(&remaining[..start]);
        let wrapper = &remaining[start..];
        let Some(tag_end) = wrapper.find('>') else {
            remaining = "";
            break;
        };
        if wrapper[..=tag_end].trim_end().ends_with("/>") {
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

fn safe_delta_text(value: &str, secrets: &[String], limit: usize) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    if value.chars().all(char::is_whitespace) {
        return Some(" ".to_string());
    }
    let leading_space = value.chars().next().is_some_and(char::is_whitespace);
    let trailing_space = value.chars().last().is_some_and(char::is_whitespace);
    let value = strip_attachment_markup(value);
    let compact = hydration::sanitize_wire_text(&value, secrets, limit)?;
    let mut projected = String::with_capacity(compact.len().saturating_add(2));
    if leading_space {
        projected.push(' ');
    }
    projected.push_str(&compact);
    if trailing_space && !projected.ends_with(' ') {
        projected.push(' ');
    }
    Some(projected.chars().take(limit).collect())
}

fn normalized_event_timestamp(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(value) => normalized_utc_timestamp(value),
        serde_json::Value::Number(value) => {
            const MAX_UNIX_SECONDS: u64 = 253_402_300_799;
            const MAX_UNIX_MILLIS: u64 = 253_402_300_799_999;
            let value = value.as_u64()?;
            let millis = if value <= MAX_UNIX_SECONDS {
                value.checked_mul(1000)?
            } else if value <= MAX_UNIX_MILLIS {
                value
            } else {
                return None;
            };
            rfc3339_millis(millis)
        }
        _ => None,
    }
}

fn empty_event_payload() -> EventPayload {
    EventPayload {
        operation_id: None,
        event: None,
        state: None,
        exit_code: None,
        message: None,
        from_seq: None,
        to_seq: None,
        reason: None,
        original_kind: None,
        original_bytes: None,
    }
}

fn project_process_payload(payload: &serde_json::Value) -> Option<EventPayload> {
    let payload = payload.as_object()?;
    let state = match payload.get("state")?.as_str()? {
        state @ ("started" | "exited" | "stopped" | "error") => state,
        _ => return None,
    };
    let exit_code = match payload.get("code") {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => i32::try_from(value.as_i64()?).ok(),
    };
    let mut projected = empty_event_payload();
    projected.state = Some(state.to_string());
    projected.exit_code = exit_code;
    if state == "error"
        && payload
            .get("message")
            .is_some_and(|message| !message.is_null())
    {
        projected.message = Some("The Pi process encountered an error.".to_string());
    }
    Some(projected)
}

fn project_gap_payload(payload: &serde_json::Value) -> Option<EventPayload> {
    let payload = payload.as_object()?;
    let from_seq = payload.get("fromSeq")?.as_u64()?;
    let to_seq = payload.get("toSeq")?.as_u64()?;
    if from_seq > to_seq {
        return None;
    }
    let reason = match payload.get("reason")?.as_str()? {
        reason @ ("replay_evicted" | "client_lagged") => reason,
        _ => return None,
    };
    let mut projected = empty_event_payload();
    projected.from_seq = Some(from_seq);
    projected.to_seq = Some(to_seq);
    projected.reason = Some(reason.to_string());
    Some(projected)
}

fn project_truncated_payload(payload: &serde_json::Value) -> Option<EventPayload> {
    let payload = payload.as_object()?;
    let original_kind = match payload.get("originalKind")?.as_str()? {
        kind @ ("piEvent" | "processEvent") => kind,
        _ => return None,
    };
    let original_bytes = payload.get("originalBytes")?.as_u64()?;
    let mut projected = empty_event_payload();
    projected.original_kind = Some(original_kind.to_string());
    projected.original_bytes = Some(original_bytes);
    Some(projected)
}

async fn rpc(
    State(state): State<BridgeState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let context = match validate_request(&headers, peer, state.config.access_mode) {
        Ok(context) => context,
        Err(response) => return response,
    };
    if !is_authenticated(&headers, &state).await {
        return unauthenticated(&context.request_id);
    }
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
    // Serde ignores unknown top-level members for protocol forward compatibility. Every supported
    // command still validates its payload object exactly before constructing a Pi command.
    let request: RpcRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(_) => return malformed_rpc_request(&context.request_id),
    };
    if !valid_opaque_id(&request.project_id) {
        return malformed_rpc_request(&context.request_id);
    }
    let session_id = request.session_id.as_deref();
    let validated_command = match request.command_type.as_str() {
        "new_session" => {
            if request.session_id.is_some()
                || rpc_request_includes_session_member(&body)
                || !request.payload.is_empty()
            {
                return malformed_rpc_request(&context.request_id);
            }
            ValidatedRpcCommand::NewSession
        }
        "prompt" => {
            let Some(session_id) = session_id else {
                return malformed_rpc_request(&context.request_id);
            };
            if !valid_opaque_id(session_id) {
                return malformed_rpc_request(&context.request_id);
            }
            match exact_prompt_text(&request.payload) {
                Some(text) => ValidatedRpcCommand::Prompt(text),
                None => return malformed_rpc_request(&context.request_id),
            }
        }
        "abort" => {
            let Some(session_id) = session_id else {
                return malformed_rpc_request(&context.request_id);
            };
            if !valid_opaque_id(session_id) || !request.payload.is_empty() {
                return malformed_rpc_request(&context.request_id);
            }
            ValidatedRpcCommand::Abort
        }
        "switch_session" => {
            let Some(session_id) = session_id else {
                return malformed_rpc_request(&context.request_id);
            };
            if !valid_opaque_id(session_id)
                || !exact_switch_session_payload(&request.payload, session_id)
            {
                return malformed_rpc_request(&context.request_id);
            }
            ValidatedRpcCommand::SwitchSession
        }
        _ => {
            return error(
                StatusCode::BAD_REQUEST,
                &context.request_id,
                "unsupported_rpc_type",
                "This RPC command type is not supported.",
                false,
            )
        }
    };

    let storage = state.storage.clone();
    let project_id = request.project_id.clone();
    let requested_session_id = request.session_id.clone();
    let resource = match tokio::task::spawn_blocking(move || {
        rpc_resource(&storage, &project_id, requested_session_id.as_deref())
    })
    .await
    {
        Ok(Ok(resource)) => resource,
        Ok(Err(error_kind)) => return rpc_resource_error(&context.request_id, error_kind),
        Err(_) => {
            return rpc_resource_error(&context.request_id, RpcResourceError::HostUnavailable)
        }
    };

    let is_new_session = matches!(&validated_command, ValidatedRpcCommand::NewSession);
    let private_id = Uuid::new_v4().to_string();
    let command = match validated_command {
        ValidatedRpcCommand::NewSession => None,
        ValidatedRpcCommand::Prompt(text) => Some(serde_json::json!({
            "type": "prompt",
            "id": private_id.clone(),
            "message": text,
        })),
        ValidatedRpcCommand::Abort => Some(serde_json::json!({
            "type": "abort",
            "id": private_id.clone(),
        })),
        ValidatedRpcCommand::SwitchSession => {
            let Some(session_path) = resource.session_path.as_deref().and_then(Path::to_str) else {
                return rpc_resource_error(&context.request_id, RpcResourceError::HostUnavailable);
            };
            Some(serde_json::json!({
                "type": "switch_session",
                "id": private_id.clone(),
                "sessionPath": session_path,
            }))
        }
    };

    // Resolve again immediately before the final authorization and write. No catalogue lock lives
    // across the asynchronous stdin write, and a replaced project/session cannot receive a command.
    let storage = state.storage.clone();
    let project_id = request.project_id.clone();
    let requested_session_id = request.session_id.clone();
    let expected_project = resource.project.path.clone();
    let expected_session = resource.session_path.clone();
    match tokio::task::spawn_blocking(move || {
        revalidate_rpc_resource(
            &storage,
            &project_id,
            requested_session_id.as_deref(),
            &expected_project,
            expected_session.as_deref(),
        )
    })
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(error_kind)) => return rpc_resource_error(&context.request_id, error_kind),
        Err(_) => {
            return rpc_resource_error(&context.request_id, RpcResourceError::HostUnavailable)
        }
    }

    // Hold the bearer lease through session-file creation, Pi stdin write/flush, and the accepted
    // response. A local token revocation therefore cannot race a command accepted under stale
    // authority.
    let Some(_authentication_lease) = authentication_lease(&headers, &state).await else {
        return unauthenticated(&context.request_id);
    };

    let created_session = if is_new_session {
        let storage = state.storage.clone();
        let project_id = request.project_id.clone();
        let expected_project = resource.project.path.clone();
        match tokio::task::spawn_blocking(move || {
            // Recheck the trusted catalogue binding in the same blocking operation that creates
            // the file. The request has no path, name, or Pi-session identifier input.
            revalidate_rpc_resource(&storage, &project_id, None, &expected_project, None)?;
            create_empty_pi_v3_session(&expected_project)
                .map_err(|_| RpcResourceError::HostUnavailable)
        })
        .await
        {
            Ok(Ok(created)) => Some(created),
            Ok(Err(error_kind)) => return rpc_resource_error(&context.request_id, error_kind),
            Err(_) => {
                return rpc_resource_error(&context.request_id, RpcResourceError::HostUnavailable)
            }
        }
    } else {
        None
    };

    let command = match (command, created_session.as_ref()) {
        (_, Some(created)) => serde_json::json!({
            "type": "switch_session",
            "id": private_id,
            "sessionPath": created.command_path,
        }),
        (Some(command), None) => command,
        (None, None) => {
            return rpc_resource_error(&context.request_id, RpcResourceError::HostUnavailable)
        }
    };

    if state
        .manager
        .remote_submit(&resource.project.path, &command)
        .await
        .is_err()
    {
        if let Some(created) = created_session {
            let _ = tokio::task::spawn_blocking(move || remove_created_pi_session(&created)).await;
        }
        return rpc_resource_error(&context.request_id, RpcResourceError::HostUnavailable);
    }

    success(
        StatusCode::ACCEPTED,
        &context.request_id,
        RpcAccepted {
            operation_id: Uuid::new_v4().to_string(),
            project_id: request.project_id,
            session_id: request.session_id,
            accepted_at: rfc3339(unix_seconds()),
            accepted_capabilities: context.accepted_capabilities,
        },
    )
}

fn exact_prompt_text(payload: &super::protocol::SafeObject) -> Option<String> {
    if payload.len() != 1 {
        return None;
    }
    let text = payload.get("text")?.as_str()?;
    (!text.trim().is_empty() && text.len() <= MAX_PROMPT_BYTES).then(|| text.to_string())
}

fn exact_switch_session_payload(
    payload: &super::protocol::SafeObject,
    expected_session_id: &str,
) -> bool {
    payload.len() == 1
        && payload.get("sessionId").and_then(serde_json::Value::as_str) == Some(expected_session_id)
}

/// `Option<String>` cannot distinguish an omitted `sessionId` from JSON null. New-session is
/// intentionally stricter: its session member must be absent, while unrelated future members stay
/// serde-forward-compatible.
fn rpc_request_includes_session_member(body: &[u8]) -> bool {
    match serde_json::from_slice::<serde_json::Value>(body) {
        Ok(serde_json::Value::Object(members)) => members.contains_key("sessionId"),
        _ => true,
    }
}

fn malformed_rpc_request(request_id: &str) -> Response {
    error(
        StatusCode::BAD_REQUEST,
        request_id,
        "malformed_request",
        "The RPC request is invalid.",
        false,
    )
}

fn rpc_resource(
    storage: &Path,
    project_id: &str,
    session_id: Option<&str>,
) -> Result<RpcResource, RpcResourceError> {
    let catalog =
        ProjectCatalog::load_or_create(storage).map_err(|_| RpcResourceError::HostUnavailable)?;
    let project = catalog
        .resolve_project_binding(project_id)
        .ok_or(RpcResourceError::ProjectNotFound)?;
    if !project.trusted {
        return Err(RpcResourceError::HostUnavailable);
    }
    let session_path = if let Some(session_id) = session_id {
        let directory =
            session_directory(&project.path).map_err(|_| RpcResourceError::HostUnavailable)?;
        Some(
            catalog
                .resolve_session_path(project_id, session_id, &directory)
                .ok_or(RpcResourceError::SessionNotFound)?,
        )
    } else {
        None
    };
    Ok(RpcResource {
        project,
        session_path,
    })
}

fn revalidate_rpc_resource(
    storage: &Path,
    project_id: &str,
    session_id: Option<&str>,
    expected_project: &Path,
    expected_session: Option<&Path>,
) -> Result<(), RpcResourceError> {
    let catalog =
        ProjectCatalog::load_or_create(storage).map_err(|_| RpcResourceError::HostUnavailable)?;
    let project = catalog
        .resolve_project_binding(project_id)
        .ok_or(RpcResourceError::ProjectNotFound)?;
    if !project.trusted {
        return Err(RpcResourceError::HostUnavailable);
    }
    if project.path != expected_project {
        return Err(RpcResourceError::ProjectNotFound);
    }
    match (session_id, expected_session) {
        (None, None) => Ok(()),
        (Some(session_id), Some(expected_session)) => {
            let directory =
                session_directory(&project.path).map_err(|_| RpcResourceError::HostUnavailable)?;
            let session_path = catalog
                .resolve_session_path(project_id, session_id, &directory)
                .ok_or(RpcResourceError::SessionNotFound)?;
            if session_path.as_path() == expected_session {
                Ok(())
            } else {
                Err(RpcResourceError::SessionNotFound)
            }
        }
        _ => Err(RpcResourceError::HostUnavailable),
    }
}

/// Creates the only filesystem artifact allowed by the remote new-session command. Both its name
/// and its Pi header ID are server-generated and remain private to this module and Pi stdin.
fn create_empty_pi_v3_session(project: &Path) -> Result<CreatedPiSession, ()> {
    let canonical_project = project.canonicalize().map_err(|_| ())?;
    if canonical_project != project {
        return Err(());
    }
    let cwd = canonical_project.to_str().ok_or(())?;
    let directory = session_directory(&canonical_project).map_err(|_| ())?;
    fs::create_dir_all(&directory).map_err(|_| ())?;

    // A random destination plus create_new means a collision can never overwrite a preexisting
    // Pi session. Retry only the astronomically unlikely UUID collision without accepting input.
    for _ in 0..4 {
        let private_session_id = Uuid::new_v4().to_string();
        let path = directory.join(format!("{private_session_id}.jsonl"));
        let command_path = path.to_str().ok_or(())?.to_string();
        let mut header = serde_json::to_vec(&serde_json::json!({
            "type": "session",
            "version": 3,
            "id": private_session_id,
            "timestamp": rfc3339(unix_seconds()),
            "cwd": cwd,
        }))
        .map_err(|_| ())?;
        header.push(b'\n');

        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = match options.open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(()),
        };
        let write_result = (|| -> Result<(), ()> {
            file.write_all(&header).map_err(|_| ())?;
            restrict_file_permissions(&path).map_err(|_| ())?;
            file.sync_all().map_err(|_| ())?;
            Ok(())
        })();
        if write_result.is_err() {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(());
        }
        let metadata = match file.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                drop(file);
                let _ = fs::remove_file(&path);
                return Err(());
            }
        };
        drop(file);
        return Ok(CreatedPiSession {
            path,
            command_path,
            metadata,
        });
    }

    Err(())
}

/// Cleanup is limited to the exact inode/file identity created above. A stale request never
/// removes a different or preexisting session merely because it happens to share a pathname.
fn remove_created_pi_session(created: &CreatedPiSession) {
    let Ok(current_metadata) = fs::metadata(&created.path) else {
        return;
    };
    if crate::same_session_file(&created.metadata, &current_metadata) {
        let _ = fs::remove_file(&created.path);
    }
}

fn rpc_resource_error(request_id: &str, kind: RpcResourceError) -> Response {
    match kind {
        RpcResourceError::ProjectNotFound => error(
            StatusCode::NOT_FOUND,
            request_id,
            "project_not_found",
            "The requested project is not available.",
            false,
        ),
        RpcResourceError::SessionNotFound => error(
            StatusCode::NOT_FOUND,
            request_id,
            "session_not_found",
            "The requested session is not available.",
            false,
        ),
        RpcResourceError::HostUnavailable => error(
            StatusCode::SERVICE_UNAVAILABLE,
            request_id,
            "host_unavailable",
            "The host cannot accept commands right now.",
            true,
        ),
    }
}

fn state_project_resource(
    storage: &Path,
    project_id: &str,
    active_project: Option<&Path>,
) -> Result<StateProjectResource, StateResourceError> {
    let catalog =
        ProjectCatalog::load_or_create(storage).map_err(|_| StateResourceError::HostUnavailable)?;
    let binding = catalog
        .resolve_project_binding(project_id)
        .ok_or(StateResourceError::ProjectNotFound)?;
    // Resolve the safe projection here as well so catalogue metadata and canonical binding must
    // both be valid before any manager state is consulted.
    catalog
        .safe_project(project_id, active_project)
        .ok_or(StateResourceError::ProjectNotFound)?;
    Ok(StateProjectResource { binding })
}

fn state_session_id(
    storage: &Path,
    project_id: &str,
    project_path: &Path,
    session_path: &Path,
) -> Result<String, StateResourceError> {
    let result = ProjectCatalog::transaction(storage, |catalog| {
        let Some(binding) = catalog.resolve_project_binding(project_id) else {
            return Ok(StateSessionTransactionResult::ProjectNotFound);
        };
        if !binding.trusted || binding.path != project_path {
            return Ok(StateSessionTransactionResult::HostUnavailable);
        }
        let Ok(directory) = session_directory(&binding.path) else {
            return Ok(StateSessionTransactionResult::HostUnavailable);
        };
        Ok(
            match catalog.merge_active_session(
                project_id,
                project_path,
                &directory,
                session_path,
            )? {
                Some(session_id) => StateSessionTransactionResult::Session(session_id),
                None => StateSessionTransactionResult::HostUnavailable,
            },
        )
    })
    .map_err(|_| StateResourceError::HostUnavailable)?;
    match result {
        StateSessionTransactionResult::Session(session_id) => Ok(session_id),
        StateSessionTransactionResult::ProjectNotFound => Err(StateResourceError::ProjectNotFound),
        StateSessionTransactionResult::HostUnavailable => Err(StateResourceError::HostUnavailable),
    }
}

fn revalidate_state_project(
    storage: &Path,
    project_id: &str,
    expected_project: &Path,
    active_session: Option<&(String, PathBuf)>,
) -> Result<ProjectSummary, StateResourceError> {
    let catalog =
        ProjectCatalog::load_or_create(storage).map_err(|_| StateResourceError::HostUnavailable)?;
    let binding = catalog
        .resolve_project_binding(project_id)
        .ok_or(StateResourceError::ProjectNotFound)?;
    if binding.path != expected_project {
        return Err(StateResourceError::ProjectNotFound);
    }
    if !binding.trusted {
        return Err(StateResourceError::HostUnavailable);
    }
    if let Some((session_id, expected_session)) = active_session {
        let directory =
            session_directory(&binding.path).map_err(|_| StateResourceError::HostUnavailable)?;
        if catalog
            .resolve_session_path(project_id, session_id, &directory)
            .as_deref()
            != Some(expected_session)
        {
            return Err(StateResourceError::HostUnavailable);
        }
    }
    catalog
        .safe_project(project_id, Some(expected_project))
        .ok_or(StateResourceError::ProjectNotFound)
}

fn hydrated_messages(
    storage: &Path,
    project_id: &str,
    session_id: &str,
    limit: usize,
) -> Result<Vec<SafeMessage>, MessagesResourceError> {
    let catalog = ProjectCatalog::load_or_create(storage)
        .map_err(|_| MessagesResourceError::HostUnavailable)?;
    let binding = catalog
        .resolve_project_binding(project_id)
        .ok_or(MessagesResourceError::ProjectNotFound)?;
    if !binding.trusted {
        return Err(MessagesResourceError::HostUnavailable);
    }
    let directory =
        session_directory(&binding.path).map_err(|_| MessagesResourceError::HostUnavailable)?;
    let Some(session_path) = catalog.resolve_session_path(project_id, session_id, &directory)
    else {
        return if catalog.resolve_project_binding(project_id).is_some() {
            Err(MessagesResourceError::SessionNotFound)
        } else {
            Err(MessagesResourceError::ProjectNotFound)
        };
    };
    // Test-only barrier coverage proves the final catalogue validation rejects an ordinary
    // replacement completed after resolution but before the transcript file is opened.
    pause_after_session_resolution(session_id);
    let messages = hydration::project_transcript(&binding.path, &session_path, session_id, limit)
        .map_err(|error| match error {
        HydrationError::InvalidProject => MessagesResourceError::ProjectNotFound,
        HydrationError::InvalidSession => MessagesResourceError::SessionNotFound,
        HydrationError::InvalidLimit
        | HydrationError::InvalidHeader
        | HydrationError::CwdMismatch
        | HydrationError::FileTooLarge
        | HydrationError::RecordTooLarge
        | HydrationError::MalformedRecord
        | HydrationError::ResponseTooLarge
        | HydrationError::FileChanged
        | HydrationError::Io => MessagesResourceError::HostUnavailable,
    })?;

    // Do not return a projection if catalogue trust or either canonical binding changed mid-read.
    let catalog = ProjectCatalog::load_or_create(storage)
        .map_err(|_| MessagesResourceError::HostUnavailable)?;
    let current_binding = catalog
        .resolve_project_binding(project_id)
        .ok_or(MessagesResourceError::ProjectNotFound)?;
    if !current_binding.trusted {
        return Err(MessagesResourceError::HostUnavailable);
    }
    if current_binding.path != binding.path {
        return Err(MessagesResourceError::ProjectNotFound);
    }
    let current_directory = session_directory(&current_binding.path)
        .map_err(|_| MessagesResourceError::HostUnavailable)?;
    if catalog
        .resolve_session_path(project_id, session_id, &current_directory)
        .as_deref()
        != Some(&session_path)
    {
        return Err(MessagesResourceError::SessionNotFound);
    }
    Ok(messages)
}

fn state_resource_error(request_id: &str, kind: StateResourceError) -> Response {
    match kind {
        StateResourceError::ProjectNotFound => error(
            StatusCode::NOT_FOUND,
            request_id,
            "project_not_found",
            "The requested project is not available.",
            false,
        ),
        StateResourceError::HostUnavailable => error(
            StatusCode::SERVICE_UNAVAILABLE,
            request_id,
            "host_unavailable",
            "The host cannot provide live state right now.",
            true,
        ),
    }
}

fn messages_resource_error(request_id: &str, kind: MessagesResourceError) -> Response {
    match kind {
        MessagesResourceError::ProjectNotFound => error(
            StatusCode::NOT_FOUND,
            request_id,
            "project_not_found",
            "The requested project is not available.",
            false,
        ),
        MessagesResourceError::SessionNotFound => error(
            StatusCode::NOT_FOUND,
            request_id,
            "session_not_found",
            "The requested session is not available.",
            false,
        ),
        MessagesResourceError::HostUnavailable => error(
            StatusCode::SERVICE_UNAVAILABLE,
            request_id,
            "host_unavailable",
            "The host cannot provide messages right now.",
            true,
        ),
    }
}

fn unauthenticated(request_id: &str) -> Response {
    error(
        StatusCode::UNAUTHORIZED,
        request_id,
        "unauthenticated",
        "Authentication is required.",
        false,
    )
}

fn session_catalogue(
    storage: &std::path::Path,
    project_id: &str,
) -> Result<Vec<SessionSummary>, SessionCatalogError> {
    let initial = ProjectCatalog::load_or_create(storage)
        .map_err(|_| SessionCatalogError::HostUnavailable)?;
    let initial_binding = initial
        .resolve_project_binding(project_id)
        .ok_or(SessionCatalogError::ProjectNotFound)?;
    let discovered = if initial_binding.trusted {
        let directory = session_directory(&initial_binding.path)
            .map_err(|_| SessionCatalogError::HostUnavailable)?;
        let sessions = list_pi_sessions_sync(&initial_binding.path)
            .map_err(|_| SessionCatalogError::HostUnavailable)?;
        Some((directory, sessions))
    } else {
        None
    };

    // The scan above is bounded and occurs outside the transaction. Reloading here prevents a
    // stale trusted scan from restoring trust, a removed project, or losing a concurrent ID.
    let result = ProjectCatalog::transaction(storage, |catalog| {
        let Some(binding) = catalog.resolve_project_binding(project_id) else {
            return Ok(SessionTransactionResult::ProjectNotFound);
        };
        if !binding.trusted {
            catalog.clear_sessions(project_id)?;
            return Ok(SessionTransactionResult::Sessions(Vec::new()));
        }
        if binding.path != initial_binding.path {
            return Ok(SessionTransactionResult::ProjectNotFound);
        }
        let Some((directory, discovered)) = discovered.as_ref() else {
            return Ok(SessionTransactionResult::HostUnavailable);
        };
        let inputs = discovered
            .iter()
            .map(|session| SessionSyncInput {
                path: PathBuf::from(&session.path),
            })
            .collect::<Vec<_>>();
        catalog.sync_sessions(project_id, directory, &inputs)?;
        let sessions = discovered
            .iter()
            .cloned()
            .filter_map(|session| {
                project_session(catalog, &binding.path, directory, project_id, session)
            })
            .collect();
        Ok(SessionTransactionResult::Sessions(sessions))
    })
    .map_err(|_| SessionCatalogError::HostUnavailable)?;
    match result {
        SessionTransactionResult::Sessions(sessions) => Ok(sessions),
        SessionTransactionResult::ProjectNotFound => Err(SessionCatalogError::ProjectNotFound),
        SessionTransactionResult::HostUnavailable => Err(SessionCatalogError::HostUnavailable),
    }
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
    let mut secrets = vec![
        project_path.to_string_lossy().into_owned(),
        directory.to_string_lossy().into_owned(),
        session.path.clone(),
        session.id.clone(),
    ];
    if let Some(parent) = &session.parent_session_path {
        secrets.push(parent.clone());
    }
    secrets.extend(session.redaction_secrets.iter().cloned());
    let name = session
        .name
        .as_deref()
        .and_then(|name| safe_session_text(name, &secrets, 160));
    let first_message_preview = if message_count == 0 {
        "New session".to_string()
    } else {
        safe_session_text(&session.first_message, &secrets, 280)
            .unwrap_or_else(|| "New session".to_string())
    };
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

fn safe_session_text(value: &str, secrets: &[String], limit: usize) -> Option<String> {
    hydration::sanitize_wire_text(value, secrets, limit)
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
    valid_opaque_id(&value).then_some(value)
}

fn messages_query(uri: &Uri) -> Option<MessagesQuery> {
    let query = uri.query()?;
    let mut project_id = None;
    let mut session_id = None;
    let mut limit = None;
    let mut member_count = 0_usize;
    for member in query.split('&') {
        member_count = member_count.checked_add(1)?;
        let (name, value) = member.split_once('=')?;
        let name = decode_query_component(name)?;
        let value = decode_query_component(value)?;
        match name.as_str() {
            "projectId" if project_id.is_none() && valid_opaque_id(&value) => {
                project_id = Some(value);
            }
            "sessionId" if session_id.is_none() && valid_opaque_id(&value) => {
                session_id = Some(value);
            }
            "limit" if limit.is_none() => {
                limit = canonical_limit(&value);
                limit?;
            }
            _ => return None,
        }
    }
    (member_count == 3).then_some(MessagesQuery {
        project_id: project_id?,
        session_id: session_id?,
        limit: limit?,
    })
}

fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn canonical_limit(value: &str) -> Option<usize> {
    if value.is_empty()
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || value.len() > 1 && value.starts_with('0')
    {
        return None;
    }
    let parsed = value.parse::<usize>().ok()?;
    (1..=200).contains(&parsed).then_some(parsed)
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
    match values.iter().count() {
        0 => return AVAILABLE_CAPABILITIES.to_vec(),
        1 => {}
        _ => return Vec::new(),
    }
    let Some(value) = values.iter().next().and_then(|value| value.to_str().ok()) else {
        return Vec::new();
    };
    let mut requested = Vec::new();
    for token in value.split(',') {
        // A present header is exact and case-sensitive. Whitespace, empty tokens, duplicate
        // tokens, and non-UTF-8 values are malformed rather than silently broadened.
        if token.is_empty() || token.trim() != token {
            return Vec::new();
        }
        let capability = match token {
            "projects" => Capability::Projects,
            "state" => Capability::State,
            "rpc" => Capability::Rpc,
            "events" => Capability::Events,
            // Unknown future capabilities do not broaden the currently available intersection.
            _ => continue,
        };
        if requested.contains(&capability) {
            return Vec::new();
        }
        requested.push(capability);
    }
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
    authentication_lease(headers, state).await.is_some()
}

/// Rechecks the bearer immediately before materializing a successful body. Keeping this lease
/// through `success` serializes a local revocation with that final authorization decision.
async fn authentication_lease<'a>(
    headers: &HeaderMap,
    state: &'a BridgeState,
) -> Option<tokio::sync::MutexGuard<'a, DeviceStore>> {
    let values = headers.get_all(header::AUTHORIZATION);
    if values.iter().count() != 1 {
        return None;
    }
    let value = values.iter().next()?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?;
    if token.is_empty() || token.contains(char::is_whitespace) {
        return None;
    }
    let devices = state.devices.lock().await;
    devices.verifies(token).then_some(devices)
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

    fn write_records(path: &Path, records: &[serde_json::Value]) {
        let contents = records
            .iter()
            .map(|record| serde_json::to_string(record).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(path, format!("{contents}\n")).unwrap();
    }

    fn sync_session(storage: &Path, project_id: &str, directory: &Path, session: &Path) -> String {
        let mut catalog = ProjectCatalog::load_or_create(storage).unwrap();
        catalog
            .sync_sessions(
                project_id,
                directory,
                &[SessionSyncInput {
                    path: session.to_path_buf(),
                }],
            )
            .unwrap();
        catalog
            .session_id_for_path(project_id, directory, session)
            .unwrap()
    }

    fn live_state_event(session: Option<&Path>, session_name: Option<&str>) -> serde_json::Value {
        let mut data = serde_json::json!({
            "isStreaming": false,
            "isCompacting": false,
            "thinkingLevel": "high",
            "messageCount": 12,
            "pendingMessageCount": 0,
            "sessionId": "raw-pi-session-id-never-serialize",
            "model": { "id": "private-model" },
        });
        if let Some(session) = session {
            data["sessionFile"] = serde_json::Value::String(session.to_string_lossy().into_owned());
        }
        if let Some(session_name) = session_name {
            data["sessionName"] = serde_json::Value::String(session_name.to_string());
        }
        serde_json::json!({
            "type": "response",
            "command": "get_state",
            "success": true,
            "id": "raw-correlation-id",
            "data": data,
        })
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
            serde_json::json!(["projects", "state"])
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

    #[test]
    fn capability_headers_require_an_exact_single_case_sensitive_request() {
        let mut headers = HeaderMap::new();
        assert_eq!(accepted_capabilities(&headers), AVAILABLE_CAPABILITIES);

        headers.insert(CAPABILITIES_HEADER, "projects,state".parse().unwrap());
        assert_eq!(
            accepted_capabilities(&headers),
            vec![Capability::Projects, Capability::State]
        );
        headers.append(CAPABILITIES_HEADER, "projects".parse().unwrap());
        assert!(accepted_capabilities(&headers).is_empty());

        let mut malformed = HeaderMap::new();
        for value in ["projects, state", "projects,projects", "Projects", ""] {
            malformed.insert(CAPABILITIES_HEADER, value.parse().unwrap());
            assert!(accepted_capabilities(&malformed).is_empty(), "{value}");
        }
        malformed.insert(
            CAPABILITIES_HEADER,
            header::HeaderValue::from_bytes(b"\xff").unwrap(),
        );
        assert!(accepted_capabilities(&malformed).is_empty());
    }

    #[tokio::test]
    async fn final_authentication_lease_serializes_revocation_with_success_materialization() {
        let root = tempdir().unwrap();
        let state = state(root.path().to_path_buf()).await;
        authorize(&state).await;
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {TEST_TOKEN}").parse().unwrap(),
        );
        let lease = authentication_lease(&headers, &state)
            .await
            .expect("authorized device receives a lease");
        let devices = Arc::clone(&state.devices);
        let revoke = tokio::spawn(async move {
            devices
                .lock()
                .await
                .revoke("82c6fbb6-fa93-4672-8b48-b7755a947e7d")
        });
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;
        assert!(
            !revoke.is_finished(),
            "revocation must wait for the final lease"
        );
        drop(lease);
        assert!(revoke.await.unwrap().unwrap());
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
    async fn projects_requires_a_valid_unrevoked_bearer_and_returns_display_only_path_metadata() {
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
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let summary = &value["data"]["projects"][0];
        assert!(summary["projectId"]
            .as_str()
            .unwrap()
            .starts_with("project_"));
        assert_eq!(
            summary["displayPath"],
            project.canonicalize().unwrap().to_string_lossy().as_ref()
        );
        assert!(summary.get("path").is_none());
        assert!(!String::from_utf8_lossy(&bytes).contains(token));
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
    async fn sessions_returns_safe_stable_opaque_catalogue_and_full_capability_intersection() {
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
                    "acceptedCapabilities": ["projects", "state"],
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
    async fn sessions_sanitize_embedded_paths_tokens_and_later_raw_ids() {
        let _environment_lock = SESSION_DIRECTORY_ENV.lock().unwrap();
        let root = tempdir().unwrap();
        let project = root.path().join("private-project");
        let sessions = root.path().join("private-sessions");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&sessions).unwrap();
        let project = project.canonicalize().unwrap();
        let _override = SessionDirectoryOverride::set(&sessions);
        let state = state(root.path().to_path_buf()).await;
        let project_id = sync_project(root.path(), &project, true);
        let path = sessions.join("one.jsonl");
        let later_id = "pi-id-recorded-later";
        write_records(
            &path,
            &[
                serde_json::json!({
                    "type": "session",
                    "id": "pi-header-id",
                    "cwd": project,
                }),
                serde_json::json!({
                    "type": "session_info",
                    "name": format!("file:///Users/maya/name C:\\Users\\maya\\name Bearer {TEST_TOKEN}"),
                }),
                serde_json::json!({
                    "type": "message",
                    "message": {
                        "role": "user",
                        "content": format!("preview=/Users/maya/secret token={TEST_TOKEN} later={later_id}"),
                    },
                }),
                serde_json::json!({
                    "type": "message",
                    "id": later_id,
                    "message": { "role": "assistant", "content": "done", "stopReason": "stop" },
                }),
            ],
        );
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
        let serialized = String::from_utf8(
            to_bytes(response.into_body(), MAX_HTTP_BODY_BYTES)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        for secret in [
            "file:///Users/maya/name",
            r"C:\Users\maya\name",
            "/Users/maya/secret",
            TEST_TOKEN,
            later_id,
            "pi-header-id",
        ] {
            assert!(
                !serialized.contains(secret),
                "leaked {secret}: {serialized}"
            );
        }
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
    async fn state_returns_fixture_compatible_snapshot_with_display_only_path_and_omits_absent_session(
    ) {
        let _environment_lock = SESSION_DIRECTORY_ENV.lock().unwrap();
        let root = tempdir().unwrap();
        let project = root.path().join("private-project-location");
        let sessions = root.path().join("private-session-directory");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&sessions).unwrap();
        let project = project.canonicalize().unwrap();
        let _override = SessionDirectoryOverride::set(&sessions);
        let state = state(root.path().to_path_buf()).await;
        let project_id = sync_project(root.path(), &project, true);
        let session = sessions.join("private-active-session.jsonl");
        write_session(
            &session,
            &project,
            "raw-pi-session-id-never-serialize",
            Some("/private/parent-session.jsonl"),
            Some("Remote bridge"),
            "Start remote work",
        );
        authorize(&state).await;
        state.manager.remote_test_activate(&project, true).await;
        state
            .manager
            .remote_test_observe(
                &project,
                &live_state_event(Some(&session), Some("Remote bridge")),
            )
            .await;

        let app = router(state.clone());
        let request_id = "734cd9ef-1afe-48b5-8893-7d806679c6fd";
        let uri = format!("/v1/state?projectId={project_id}");
        let mut request = authorized_request(Method::GET, &uri, request_id);
        request.headers_mut().insert(
            CAPABILITIES_HEADER,
            "events,state,projects,rpc".parse().unwrap(),
        );
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), MAX_HTTP_BODY_BYTES)
            .await
            .unwrap();
        let serialized = String::from_utf8(bytes.to_vec()).unwrap();
        for secret in [
            sessions.to_string_lossy().as_ref(),
            session.to_string_lossy().as_ref(),
            "raw-pi-session-id-never-serialize",
            "raw-correlation-id",
            "private-model",
            TEST_TOKEN,
            "__piPid",
            "generation",
        ] {
            assert!(
                !serialized.contains(secret),
                "leaked {secret}: {serialized}"
            );
        }
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let session_id = value["data"]["state"]["sessionId"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(session_id.starts_with("session_"));
        assert_eq!(
            value,
            serde_json::json!({
                "protocol": 1,
                "requestId": request_id,
                "data": {
                    "project": {
                        "projectId": project_id,
                        "displayName": "private-project-location",
                        "displayPath": project.to_string_lossy(),
                        "trustState": "trusted",
                        "isActive": true,
                    },
                    "state": {
                        "sessionId": session_id,
                        "sessionName": "Remote bridge",
                        "isStreaming": false,
                        "isCompacting": false,
                        "thinkingLevel": "high",
                        "messageCount": 12,
                        "pendingMessageCount": 0,
                    },
                    "acceptedCapabilities": ["projects", "state"],
                },
            })
        );

        state
            .manager
            .remote_test_observe(&project, &live_state_event(None, Some("must be omitted")))
            .await;
        let response = app
            .oneshot(authorized_request(Method::GET, &uri, request_id))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let value = response_json(response).await;
        assert!(value["data"]["state"].get("sessionId").is_none());
        assert!(value["data"]["state"].get("sessionName").is_none());
        assert_eq!(
            value["data"]["acceptedCapabilities"],
            serde_json::json!(["projects", "state"])
        );
    }

    #[tokio::test]
    async fn state_rejects_untrusted_inactive_missing_cache_and_stale_generations_safely() {
        let _environment_lock = SESSION_DIRECTORY_ENV.lock().unwrap();
        let root = tempdir().unwrap();
        let project = root.path().join("secret-project");
        let sessions = root.path().join("secret-sessions");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&sessions).unwrap();
        let project = project.canonicalize().unwrap();
        let _override = SessionDirectoryOverride::set(&sessions);
        let state = state(root.path().to_path_buf()).await;
        let project_id = sync_project(root.path(), &project, true);
        authorize(&state).await;
        let app = router(state.clone());
        let request_id = "7c9b9c14-e910-4be7-8878-5d3ed02b2f02";
        let uri = format!("/v1/state?projectId={project_id}");

        let inactive = app
            .clone()
            .oneshot(authorized_request(Method::GET, &uri, request_id))
            .await
            .unwrap();
        assert_eq!(inactive.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            response_json(inactive).await["error"]["code"],
            "host_unavailable"
        );

        state.manager.remote_test_activate(&project, true).await;
        let no_cache = app
            .clone()
            .oneshot(authorized_request(Method::GET, &uri, request_id))
            .await
            .unwrap();
        assert_eq!(no_cache.status(), StatusCode::SERVICE_UNAVAILABLE);

        state
            .manager
            .remote_test_observe(&project, &live_state_event(None, None))
            .await;
        let candidate = state.manager.remote_live_state(&project).await.unwrap();
        state
            .manager
            .remote_test_observe(&project, &serde_json::json!({ "type": "agent_start" }))
            .await;
        assert!(!state.manager.remote_live_state_is_current(&candidate).await);
        state
            .manager
            .remote_test_observe(&project, &serde_json::json!({ "type": "agent_settled" }))
            .await;
        state.manager.remote_test_activate(&project, true).await;
        assert!(!state.manager.remote_live_state_is_current(&candidate).await);

        assert_eq!(sync_project(root.path(), &project, false), project_id);
        state.manager.remote_test_activate(&project, false).await;
        let untrusted = app
            .clone()
            .oneshot(authorized_request(Method::GET, &uri, request_id))
            .await
            .unwrap();
        assert_eq!(untrusted.status(), StatusCode::SERVICE_UNAVAILABLE);
        let bytes = to_bytes(untrusted.into_body(), MAX_HTTP_BODY_BYTES)
            .await
            .unwrap();
        let serialized = String::from_utf8_lossy(&bytes);
        for secret in [
            project.to_string_lossy().as_ref(),
            sessions.to_string_lossy().as_ref(),
            "raw-pi-session-id-never-serialize",
        ] {
            assert!(!serialized.contains(secret));
        }

        let unknown = "unknown-project";
        let response = app
            .oneshot(authorized_request(
                Method::GET,
                &format!("/v1/state?projectId={unknown}"),
                request_id,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let bytes = to_bytes(response.into_body(), MAX_HTTP_BODY_BYTES)
            .await
            .unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains(unknown));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["error"]["code"],
            "project_not_found"
        );
    }

    #[tokio::test]
    async fn messages_returns_last_safe_messages_in_order_with_full_capabilities() {
        let _environment_lock = SESSION_DIRECTORY_ENV.lock().unwrap();
        let root = tempdir().unwrap();
        let project = root.path().join("private-project");
        let sessions = root.path().join("private-sessions");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&sessions).unwrap();
        let project = project.canonicalize().unwrap();
        let sessions = sessions.canonicalize().unwrap();
        let _override = SessionDirectoryOverride::set(&sessions);
        let state = state(root.path().to_path_buf()).await;
        let project_id = sync_project(root.path(), &project, true);
        let session = sessions.join("private-transcript.jsonl");
        write_records(
            &session,
            &[
                serde_json::json!({
                    "type": "session",
                    "id": "raw-pi-session-id",
                    "cwd": project,
                    "parentSession": "/private/raw-parent.jsonl",
                }),
                serde_json::json!({
                    "type": "message",
                    "id": "raw-user-message-id",
                    "timestamp": "2026-08-03T01:20:00.000Z",
                    "message": {
                        "role": "user",
                        "content": format!("first at {} <lemonpi-attachment name=\"secret\">attachment-secret</lemonpi-attachment>", project.display()),
                        "details": "private-details",
                    },
                }),
                serde_json::json!({
                    "type": "message",
                    "id": "raw-assistant-message-id",
                    "timestamp": "2026-08-03T01:20:01.000Z",
                    "message": {
                        "role": "assistant",
                        "stopReason": "stop",
                        "content": [
                            { "type": "thinking", "thinking": format!("thinking in {}", sessions.display()) },
                            { "type": "text", "text": "safe assistant text raw-assistant-message-id" },
                            { "type": "toolCall", "id": "raw-tool-id", "name": "safe_tool", "arguments": { "secret": "raw-tool-args" } },
                            { "type": "image", "data": "raw-attachment-data" },
                        ],
                    },
                }),
                serde_json::json!({
                    "type": "message",
                    "timestamp": "2026-08-03T01:20:02.000Z",
                    "message": {
                        "role": "toolResult",
                        "toolCallId": "raw-tool-id",
                        "content": format!(
                            "safe tool text at {} for raw-pi-session-id raw-tool-id",
                            session.display()
                        ),
                        "output": "raw-tool-output",
                        "details": "raw-tool-details",
                        "isError": false,
                    },
                }),
                serde_json::json!({
                    "type": "message",
                    "timestamp": "2026-08-03T01:20:03.000Z",
                    "message": {
                        "role": "assistant",
                        "stopReason": "error",
                        "content": "safe final summary",
                    },
                }),
            ],
        );
        let session_id = sync_session(root.path(), &project_id, &sessions, &session);
        authorize(&state).await;
        let app = router(state);
        let request_id = "7c9b9c14-e910-4be7-8878-5d3ed02b2f02";
        let uri = format!("/v1/messages?limit=3&sessionId={session_id}&projectId={project_id}");
        let mut request = authorized_request(Method::GET, &uri, request_id);
        request.headers_mut().insert(
            CAPABILITIES_HEADER,
            "state,events,projects".parse().unwrap(),
        );
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), MAX_HTTP_BODY_BYTES)
            .await
            .unwrap();
        let serialized = String::from_utf8(bytes.to_vec()).unwrap();
        for secret in [
            project.to_string_lossy().as_ref(),
            sessions.to_string_lossy().as_ref(),
            session.to_string_lossy().as_ref(),
            "raw-pi-session-id",
            "raw-parent",
            "raw-user-message-id",
            "raw-assistant-message-id",
            "raw-tool-id",
            "raw-tool-args",
            "raw-tool-output",
            "raw-tool-details",
            "raw-attachment-data",
            "attachment-secret",
            "private-details",
            TEST_TOKEN,
        ] {
            assert!(
                !serialized.contains(secret),
                "leaked {secret}: {serialized}"
            );
        }
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["data"]["projectId"], project_id);
        assert_eq!(value["data"]["sessionId"], session_id);
        assert_eq!(
            value["data"]["acceptedCapabilities"],
            serde_json::json!(["projects", "state"])
        );
        let messages = value["data"]["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], "assistant");
        assert_eq!(messages[0]["text"], "safe assistant text [redacted]");
        assert_eq!(messages[0]["thinking"], "thinking in [redacted]");
        assert_eq!(messages[1]["role"], "tool");
        assert_eq!(
            messages[1]["text"],
            "safe tool text at [redacted] for [redacted] [redacted]"
        );
        assert_eq!(messages[1]["toolName"], "safe_tool");
        assert_eq!(messages[1]["toolStatus"], "complete");
        assert_eq!(messages[2]["text"], "safe final summary");
        assert_eq!(messages[2]["isError"], true);
        assert!(messages.iter().all(|message| message
            .get("isError")
            .and_then(serde_json::Value::as_bool)
            .is_some()));
    }

    #[tokio::test]
    async fn messages_maps_unknown_untrusted_and_malformed_resources_to_safe_errors() {
        let _environment_lock = SESSION_DIRECTORY_ENV.lock().unwrap();
        let root = tempdir().unwrap();
        let project = root.path().join("private-project");
        let sessions = root.path().join("private-sessions");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&sessions).unwrap();
        let project = project.canonicalize().unwrap();
        let sessions = sessions.canonicalize().unwrap();
        let _override = SessionDirectoryOverride::set(&sessions);
        let state = state(root.path().to_path_buf()).await;
        let project_id = sync_project(root.path(), &project, true);
        let session = sessions.join("malformed.jsonl");
        write_session(&session, &project, "raw-pi-id", None, None, "safe");
        let session_id = sync_session(root.path(), &project_id, &sessions, &session);
        authorize(&state).await;
        let app = router(state);
        let request_id = "7c9b9c14-e910-4be7-8878-5d3ed02b2f02";

        for (uri, status, code, secret) in [
            (
                "/v1/messages?projectId=unknown-project&sessionId=unknown-session&limit=10"
                    .to_string(),
                StatusCode::NOT_FOUND,
                "project_not_found",
                "unknown-project",
            ),
            (
                format!("/v1/messages?projectId={project_id}&sessionId=unknown-session&limit=10"),
                StatusCode::NOT_FOUND,
                "session_not_found",
                "unknown-session",
            ),
        ] {
            let response = app
                .clone()
                .oneshot(authorized_request(Method::GET, &uri, request_id))
                .await
                .unwrap();
            assert_eq!(response.status(), status);
            let bytes = to_bytes(response.into_body(), MAX_HTTP_BODY_BYTES)
                .await
                .unwrap();
            assert!(!String::from_utf8_lossy(&bytes).contains(secret));
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["error"]["code"],
                code
            );
        }

        assert_eq!(sync_project(root.path(), &project, false), project_id);
        let uri = format!("/v1/messages?projectId={project_id}&sessionId={session_id}&limit=10");
        let response = app
            .clone()
            .oneshot(authorized_request(Method::GET, &uri, request_id))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            response_json(response).await["error"]["code"],
            "host_unavailable"
        );

        assert_eq!(sync_project(root.path(), &project, true), project_id);
        std::fs::write(&session, "not-json\n").unwrap();
        let response = app
            .clone()
            .oneshot(authorized_request(Method::GET, &uri, request_id))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let bytes = to_bytes(response.into_body(), MAX_HTTP_BODY_BYTES)
            .await
            .unwrap();
        let serialized = String::from_utf8_lossy(&bytes);
        assert!(!serialized.contains("not-json"));
        assert!(!serialized.contains(project.to_string_lossy().as_ref()));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["error"]["code"],
            "host_unavailable"
        );

        let oversized = sessions.join("oversized.jsonl");
        write_records(
            &oversized,
            &[serde_json::json!({
                "type": "session",
                "id": "raw-oversized-id",
                "cwd": project,
            })],
        );
        let oversized_id = sync_session(root.path(), &project_id, &sessions, &oversized);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&oversized)
            .unwrap()
            .set_len(hydration::MAX_TRANSCRIPT_FILE_BYTES + 1)
            .unwrap();
        let oversized_uri =
            format!("/v1/messages?projectId={project_id}&sessionId={oversized_id}&limit=10");
        let response = app
            .oneshot(authorized_request(Method::GET, &oversized_uri, request_id))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            response_json(response).await["error"]["code"],
            "host_unavailable"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn replacement_between_session_resolution_and_open_is_rejected_before_output() {
        let _environment_lock = SESSION_DIRECTORY_ENV.lock().unwrap();
        let root = tempdir().unwrap();
        let project = root.path().join("project");
        let sessions = root.path().join("sessions");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&sessions).unwrap();
        let project = project.canonicalize().unwrap();
        let sessions = sessions.canonicalize().unwrap();
        let _override = SessionDirectoryOverride::set(&sessions);
        let state = state(root.path().to_path_buf()).await;
        let project_id = sync_project(root.path(), &project, true);
        let session = sessions.join("active.jsonl");
        write_session(&session, &project, "old-pi-id", None, None, "old contents");
        let session_id = sync_session(root.path(), &project_id, &sessions, &session);
        authorize(&state).await;
        let app = router(state);
        let barrier = TranscriptResolutionBarrier {
            session_id: session_id.clone(),
            entered: Arc::new(std::sync::Barrier::new(2)),
            release: Arc::new(std::sync::Barrier::new(2)),
        };
        *TEST_TRANSCRIPT_RESOLUTION_BARRIER
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(barrier.clone());
        let _barrier_guard = TranscriptResolutionBarrierGuard;
        let request_id = "7c9b9c14-e910-4be7-8878-5d3ed02b2f02";
        let uri = format!("/v1/messages?projectId={project_id}&sessionId={session_id}&limit=10");
        let request = tokio::spawn({
            let app = app.clone();
            async move {
                app.oneshot(authorized_request(Method::GET, &uri, request_id))
                    .await
                    .unwrap()
            }
        });
        let entered = Arc::clone(&barrier.entered);
        tokio::task::spawn_blocking(move || entered.wait())
            .await
            .unwrap();

        let moved = root.path().join("moved.jsonl");
        std::fs::rename(&session, &moved).unwrap();
        write_session(
            &session,
            &project,
            "replacement-pi-id",
            None,
            None,
            "REPLACEMENT_DURING_READ_SECRET",
        );
        let release = Arc::clone(&barrier.release);
        tokio::task::spawn_blocking(move || release.wait())
            .await
            .unwrap();
        let response = request.await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = String::from_utf8_lossy(
            &to_bytes(response.into_body(), MAX_HTTP_BODY_BYTES)
                .await
                .unwrap(),
        )
        .into_owned();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap()["error"]["code"],
            "session_not_found"
        );
        assert!(!body.contains("REPLACEMENT_DURING_READ_SECRET"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ordinary_same_path_session_replacement_gets_a_new_opaque_id() {
        let _environment_lock = SESSION_DIRECTORY_ENV.lock().unwrap();
        let root = tempdir().unwrap();
        let project = root.path().join("project");
        let sessions = root.path().join("sessions");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&sessions).unwrap();
        let project = project.canonicalize().unwrap();
        let sessions = sessions.canonicalize().unwrap();
        let _override = SessionDirectoryOverride::set(&sessions);
        let state = state(root.path().to_path_buf()).await;
        let project_id = sync_project(root.path(), &project, true);
        let session = sessions.join("active.jsonl");
        write_session(
            &session,
            &project,
            "old-pi-session-id",
            None,
            Some("Old session"),
            "old contents",
        );
        let old_session_id = sync_session(root.path(), &project_id, &sessions, &session);
        state.manager.remote_test_activate(&project, true).await;
        state
            .manager
            .remote_test_observe(
                &project,
                &live_state_event(Some(&session), Some("Old session")),
            )
            .await;
        authorize(&state).await;
        let app = router(state);
        let moved = root.path().join("moved.jsonl");
        std::fs::rename(&session, &moved).unwrap();
        write_session(
            &session,
            &project,
            "replacement-pi-session-id",
            None,
            Some("Replacement session"),
            "REPLACEMENT_SECRET",
        );
        let request_id = "7c9b9c14-e910-4be7-8878-5d3ed02b2f02";
        let messages = app
            .clone()
            .oneshot(authorized_request(
                Method::GET,
                &format!("/v1/messages?projectId={project_id}&sessionId={old_session_id}&limit=10"),
                request_id,
            ))
            .await
            .unwrap();
        assert_eq!(messages.status(), StatusCode::NOT_FOUND);
        assert!(!String::from_utf8_lossy(
            &to_bytes(messages.into_body(), MAX_HTTP_BODY_BYTES)
                .await
                .unwrap()
        )
        .contains("REPLACEMENT_SECRET"));

        let state_response = app
            .oneshot(authorized_request(
                Method::GET,
                &format!("/v1/state?projectId={project_id}"),
                request_id,
            ))
            .await
            .unwrap();
        assert_eq!(state_response.status(), StatusCode::OK);
        let value = response_json(state_response).await;
        assert_ne!(value["data"]["state"]["sessionId"], old_session_id);
        assert!(!value.to_string().contains("replacement-pi-session-id"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn state_and_messages_revalidate_replaced_projects_and_sessions() {
        use std::os::unix::fs::symlink;

        let _environment_lock = SESSION_DIRECTORY_ENV.lock().unwrap();
        let root = tempdir().unwrap();
        let project = root.path().join("project");
        let sessions = root.path().join("sessions");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&sessions).unwrap();
        let project = project.canonicalize().unwrap();
        let sessions = sessions.canonicalize().unwrap();
        let _override = SessionDirectoryOverride::set(&sessions);
        let state = state(root.path().to_path_buf()).await;
        let project_id = sync_project(root.path(), &project, true);
        let session = sessions.join("active.jsonl");
        write_session(
            &session,
            &project,
            "raw-replaced-session-id",
            None,
            Some("Replaced secret name"),
            "REPLACED_SESSION_SECRET",
        );
        let session_id = sync_session(root.path(), &project_id, &sessions, &session);
        authorize(&state).await;
        state.manager.remote_test_activate(&project, true).await;
        state
            .manager
            .remote_test_observe(
                &project,
                &live_state_event(Some(&session), Some("Replaced secret name")),
            )
            .await;
        let app = router(state);
        let request_id = "7c9b9c14-e910-4be7-8878-5d3ed02b2f02";

        let moved_session = root.path().join("moved-session.jsonl");
        std::fs::rename(&session, &moved_session).unwrap();
        symlink(&moved_session, &session).unwrap();
        let messages_uri =
            format!("/v1/messages?projectId={project_id}&sessionId={session_id}&limit=10");
        let response = app
            .clone()
            .oneshot(authorized_request(Method::GET, &messages_uri, request_id))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let bytes = to_bytes(response.into_body(), MAX_HTTP_BODY_BYTES)
            .await
            .unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("REPLACED_SESSION_SECRET"));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["error"]["code"],
            "session_not_found"
        );

        let state_uri = format!("/v1/state?projectId={project_id}");
        let response = app
            .clone()
            .oneshot(authorized_request(Method::GET, &state_uri, request_id))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let bytes = to_bytes(response.into_body(), MAX_HTTP_BODY_BYTES)
            .await
            .unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("Replaced secret name"));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["error"]["code"],
            "host_unavailable"
        );

        let moved_project = root.path().join("moved-project");
        std::fs::rename(&project, &moved_project).unwrap();
        symlink(&moved_project, &project).unwrap();
        let response = app
            .oneshot(authorized_request(Method::GET, &state_uri, request_id))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response_json(response).await["error"]["code"],
            "project_not_found"
        );
    }

    #[tokio::test]
    async fn state_and_messages_auth_precedes_strict_query_validation_and_revocation() {
        let root = tempdir().unwrap();
        let state = state(root.path().to_path_buf()).await;
        let app = router(state.clone());
        let request_id = "7c9b9c14-e910-4be7-8878-5d3ed02b2f02";
        let malformed_uris = [
            "/v1/state",
            "/v1/state?projectId=",
            "/v1/state?projectId=one&projectId=two",
            "/v1/state?projectId=%2Fprivate%2Fproject",
            "/v1/messages?projectId=one&sessionId=two",
            "/v1/messages?projectId=one&sessionId=two&limit=0",
            "/v1/messages?projectId=one&sessionId=two&limit=01",
            "/v1/messages?projectId=one&sessionId=two&limit=201",
            "/v1/messages?projectId=one&sessionId=two&limit=999999999999999999999999999999999999",
            "/v1/messages?projectId=one&sessionId=two&limit=+1",
            "/v1/messages?projectId=one&sessionId=two&limit=1.0",
            "/v1/messages?projectId=one&sessionId=two&limit=1&extra=x",
            "/v1/messages?projectId=one&projectId=two&sessionId=three&limit=1",
            "/v1/messages?projectId=one&sessionId=%FF&limit=1",
            "/v1/messages?projectId=one&sessionId=two&limit=%ZZ",
        ];

        let unauthenticated_response = app
            .clone()
            .oneshot(request(
                Method::GET,
                malformed_uris[0],
                request_id,
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(unauthenticated_response.status(), StatusCode::UNAUTHORIZED);
        let unauthenticated_body = response_json(unauthenticated_response).await;
        let mut invalid = request(Method::GET, malformed_uris[4], request_id, Body::empty());
        invalid.headers_mut().insert(
            header::AUTHORIZATION,
            "Bearer invalid-token".parse().unwrap(),
        );
        let invalid_response = app.clone().oneshot(invalid).await.unwrap();
        assert_eq!(invalid_response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response_json(invalid_response).await, unauthenticated_body);

        authorize(&state).await;
        for uri in malformed_uris {
            let response = app
                .clone()
                .oneshot(authorized_request(Method::GET, uri, request_id))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{uri}");
            assert_eq!(
                response_json(response).await["error"]["code"],
                "malformed_request",
                "{uri}"
            );
        }

        state
            .devices
            .lock()
            .await
            .revoke("82c6fbb6-fa93-4672-8b48-b7755a947e7d")
            .unwrap();
        for uri in [malformed_uris[0], malformed_uris[4]] {
            let response = app
                .clone()
                .oneshot(authorized_request(Method::GET, uri, request_id))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(response_json(response).await, unauthenticated_body);
        }
    }

    #[test]
    fn query_projection_helpers_accept_any_order_and_reject_noncanonical_limits() {
        let query = messages_query(
            &"/v1/messages?limit=200&project%49d=project_abc&sessionId=session_xyz"
                .parse()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(query.project_id, "project_abc");
        assert_eq!(query.session_id, "session_xyz");
        assert_eq!(query.limit, 200);
        for invalid in ["", "0", "00", "01", "+1", " 1", "1.0", "201"] {
            assert!(canonical_limit(invalid).is_none(), "{invalid}");
        }
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
