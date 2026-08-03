//! The deliberately small, pinned-TLS HTTP surface for LemonPi Go v1.
//!
//! This module owns only `/health`, `/pair`, and `/projects`. It deliberately has no generic Pi
//! command, filesystem, settings, session, or WebSocket route. Internal paths remain confined to
//! `ProjectCatalog`; handlers serialize only explicitly safe projections.

use super::{
    auth::{DeviceStore, PairingAttempt, PairingWindow},
    config::{AccessMode, RemoteConfig},
    identity::HostIdentity,
    policy::allows_peer,
    projects::{ProjectCatalog, RemoteProjectSummary},
    protocol::{
        Capability, Envelope, Health, Limits, PairRequest, PairResponse, PairedDevice,
        ProtocolError,
    },
    RemoteError, RemoteResult,
};
use crate::PiManager;
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
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::{
    net::TcpStream,
    sync::{watch, Mutex},
};
use tokio_rustls::TlsAcceptor;
use tower::ServiceExt;
use uuid::Uuid;

pub(crate) const MAX_HTTP_BODY_BYTES: usize = 2 * 1024 * 1024;
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

/// Builds the v1 router. The actual TCP listener also checks peers before TLS negotiation; this
/// route-level check keeps the rule true for every request and permits deterministic router tests.
pub(crate) fn router(state: BridgeState) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/pair", post(pair))
        .route("/v1/projects", get(projects))
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
        let Ok(tls_stream) = acceptor.accept(stream).await else {
            return;
        };
        let service = app
            .into_make_service_with_connect_info::<SocketAddr>()
            .oneshot(peer)
            .await
            .expect("infallible Axum make service");
        let io = TokioIo::new(tls_stream);
        let _ = HyperBuilder::new(TokioExecutor::new())
            .serve_connection_with_upgrades(io, TowerToHyperService::new(service))
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
    use tempfile::tempdir;
    use tower::ServiceExt;

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

    #[test]
    fn persisted_identity_builds_a_ring_backed_tls_server_config() {
        let root = tempdir().unwrap();
        let identity = HostIdentityStore::new(root.path())
            .load_or_create()
            .unwrap();
        assert!(tls_server_config(&identity).is_ok());
    }
}
