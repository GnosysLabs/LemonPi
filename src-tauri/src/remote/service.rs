//! Explicit lifecycle management for LemonPi's opt-in remote TLS listener.
//!
//! `RemoteService` is the sole owner of the listener task. Constructing it never opens a port;
//! only a persisted or explicitly set `enabled: true` configuration can start the TLS endpoint.

use super::{
    auth::{DeviceStore, DeviceSummary, PairingWindow},
    config::{AccessMode, RemoteConfig, RemoteConfigStore},
    identity::{HostIdentity, HostIdentityStore},
    policy::allows_peer,
    server::{rfc3339, router, serve_tls_connection, tls_server_config, BridgeState},
    RemoteError, RemoteResult,
};
use crate::PiManager;
use serde::Serialize;
use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{watch, Mutex, Semaphore},
    task::JoinHandle,
};
use tokio_rustls::TlsAcceptor;

/// Hard cap for this HTTP-only bridge slice. A future WebSocket implementation must introduce
/// its own explicit lifecycle/budget policy rather than silently inheriting this HTTP budget.
pub(crate) const MAX_REMOTE_CONNECTIONS: usize = 8;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ListenerExit {
    Shutdown,
    AcceptError,
}

struct RunningServer {
    local_addr: SocketAddr,
    shutdown: watch::Sender<bool>,
    task: JoinHandle<ListenerExit>,
}

/// Safe local-settings view. It never contains a filesystem location, certificate private key,
/// pairing code, bearer token, or token digest.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteStatus {
    pub(crate) enabled: bool,
    pub(crate) running: bool,
    pub(crate) port: u16,
    pub(crate) access_mode: AccessMode,
    pub(crate) host_id: String,
    pub(crate) pairing_active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingMaterial {
    pub(crate) version: u8,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) host_id: String,
    pub(crate) code: String,
    pub(crate) certificate_pin: String,
    pub(crate) expires_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteDevice {
    pub(crate) id: String,
    pub(crate) display_name: String,
    pub(crate) paired_at: String,
}

/// Managed state for the one remotely reachable TCP port.
pub(crate) struct RemoteService {
    storage: PathBuf,
    manager: Arc<PiManager>,
    /// Serializes start, restart, disable, and startup-restore transitions. No public lifecycle
    /// method may acquire `running` before this lock.
    transition: Mutex<()>,
    config: Mutex<RemoteConfig>,
    identity: Arc<HostIdentity>,
    devices: Arc<Mutex<DeviceStore>>,
    pairing: Arc<Mutex<Option<PairingWindow>>>,
    running: Mutex<Option<RunningServer>>,
    last_error: Mutex<Option<String>>,
}

impl RemoteService {
    /// Loads owner-only persisted state but intentionally does not bind a socket. Call
    /// `start_if_enabled` after application setup to honor a prior explicit enablement.
    pub(crate) fn load(storage: PathBuf, manager: Arc<PiManager>) -> RemoteResult<Self> {
        let config = RemoteConfigStore::new(&storage).load_or_default()?;
        let identity = Arc::new(HostIdentityStore::new(&storage).load_or_create()?);
        let devices = Arc::new(Mutex::new(DeviceStore::load_or_create(&storage)?));
        Ok(Self {
            storage,
            manager,
            transition: Mutex::new(()),
            config: Mutex::new(config),
            identity,
            devices,
            pairing: Arc::new(Mutex::new(None)),
            running: Mutex::new(None),
            last_error: Mutex::new(None),
        })
    }

    pub(crate) async fn config(&self) -> RemoteConfig {
        self.config.lock().await.clone()
    }

    pub(crate) async fn start_if_enabled(&self) -> RemoteResult<()> {
        let _transition = self.transition.lock().await;
        self.start_locked().await
    }

    /// Persists the setting before enabling. Disabling tears down the listener even if persistence
    /// fails, so a local user's immediate security action is never delayed by a disk error.
    pub(crate) async fn set_config(&self, config: RemoteConfig) -> RemoteResult<()> {
        config.validate()?;
        let _transition = self.transition.lock().await;
        if let Err(error) = RemoteConfigStore::new(&self.storage).save(&config) {
            if !config.enabled {
                self.stop_locked().await;
            }
            return Err(error);
        }
        *self.config.lock().await = config.clone();
        if config.enabled {
            self.start_locked().await
        } else {
            self.stop_locked().await;
            Ok(())
        }
    }

    /// Starts a fresh listener after stopping an existing one. The listener is IPv4-only in v1;
    /// see the user-facing residual risk in the implementation report for IPv6 tailnets.
    pub(crate) async fn start(&self) -> RemoteResult<()> {
        let _transition = self.transition.lock().await;
        self.start_locked().await
    }

    pub(crate) async fn stop(&self) {
        let _transition = self.transition.lock().await;
        self.stop_locked().await;
    }

    pub(crate) async fn status(&self) -> RemoteStatus {
        let _transition = self.transition.lock().await;
        let config = self.config.lock().await.clone();
        let running = self.listener_is_live_locked().await;
        let pairing_active = if running {
            self.pairing
                .lock()
                .await
                .as_mut()
                .and_then(|window| window.display_code_at(unix_seconds()))
                .is_some()
        } else {
            false
        };
        RemoteStatus {
            enabled: config.enabled,
            running,
            port: config.port,
            access_mode: config.access_mode,
            host_id: self.identity.host_id().to_string(),
            pairing_active,
            last_error: self.last_error.lock().await.clone(),
        }
    }

    /// Opens a fresh single-use code only while the remote TLS host is actually running.
    pub(crate) async fn start_pairing(&self, host: String) -> RemoteResult<PairingMaterial> {
        if !valid_pairing_host(&host) {
            return Err(RemoteError::InvalidConfiguration(
                "pairing host is invalid".into(),
            ));
        }
        let _transition = self.transition.lock().await;
        if !self.listener_is_live_locked().await {
            return Err(RemoteError::InvalidConfiguration(
                "remote access is not running".into(),
            ));
        }
        let config = self.config.lock().await.clone();
        let now = unix_seconds();
        *self.pairing.lock().await = Some(PairingWindow::open_at(now));
        // The task can finish independently of a transition; re-check after allocating the local
        // code so a dead listener never leaves a pairing window that looks usable.
        if !self.listener_is_live_locked().await {
            *self.pairing.lock().await = None;
            return Err(RemoteError::InvalidConfiguration(
                "remote access is not running".into(),
            ));
        }
        let mut pairing = self.pairing.lock().await;
        let window = pairing.as_mut().expect("pairing window was inserted");
        let code = window
            .display_code_at(now)
            .expect("fresh pairing window is immediately readable")
            .to_string();
        Ok(PairingMaterial {
            version: super::protocol::PROTOCOL_VERSION,
            host,
            port: config.port,
            host_id: self.identity.host_id().to_string(),
            code,
            certificate_pin: self.identity.certificate_pin_base64url()?,
            expires_at: rfc3339(window.expires_at()),
        })
    }

    pub(crate) async fn cancel_pairing(&self) {
        let _transition = self.transition.lock().await;
        *self.pairing.lock().await = None;
    }

    /// Must be called with `transition` held. It owns the only stop/start sequence and does not
    /// acquire the transition mutex itself, avoiding recursive lock deadlocks.
    async fn start_locked(&self) -> RemoteResult<()> {
        let config = self.config.lock().await.clone();
        if !config.enabled {
            self.stop_locked().await;
            return Ok(());
        }
        self.stop_locked().await;
        let tls = tls_server_config(&self.identity)?;
        let listener = match TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, config.port)).await
        {
            Ok(listener) => listener,
            Err(error) => {
                self.set_last_error("The remote host could not start listening.")
                    .await;
                return Err(RemoteError::Io(error));
            }
        };
        let local_addr = listener.local_addr().map_err(RemoteError::Io)?;
        let state = BridgeState {
            config: config.clone(),
            storage: self.storage.clone(),
            identity: Arc::clone(&self.identity),
            devices: Arc::clone(&self.devices),
            pairing: Arc::clone(&self.pairing),
            manager: Arc::clone(&self.manager),
        };
        let (shutdown, shutdown_rx) = watch::channel(false);
        let task = tokio::spawn(run_listener(
            listener,
            TlsAcceptor::from(tls),
            router(state),
            config.access_mode,
            shutdown_rx,
            connection_budget(),
        ));
        *self.running.lock().await = Some(RunningServer {
            local_addr,
            shutdown,
            task,
        });
        *self.last_error.lock().await = None;
        Ok(())
    }

    /// Must be called with `transition` held. It closes the listening socket before returning and
    /// aborts only the listener task if it does not acknowledge shutdown promptly.
    async fn stop_locked(&self) {
        let running = self.running.lock().await.take();
        if let Some(running) = running {
            let _ = running.shutdown.send(true);
            let mut task = running.task;
            if tokio::time::timeout(Duration::from_secs(2), &mut task)
                .await
                .is_err()
            {
                task.abort();
                let _ = task.await;
            }
        }
        *self.pairing.lock().await = None;
    }

    /// Must be called with `transition` held. Reaps an unexpectedly completed listener so status
    /// and pairing are based on task liveness rather than a stale `Option` handle.
    async fn listener_is_live_locked(&self) -> bool {
        let finished = {
            let running = self.running.lock().await;
            match running.as_ref() {
                Some(running) => running.task.is_finished(),
                None => return false,
            }
        };
        if !finished {
            return true;
        }
        let running = self.running.lock().await.take();
        if let Some(running) = running {
            let outcome = running.task.await;
            if !matches!(outcome, Ok(ListenerExit::Shutdown)) {
                self.set_last_error("The remote host stopped unexpectedly.")
                    .await;
            }
        }
        *self.pairing.lock().await = None;
        false
    }

    pub(crate) async fn list_devices(&self) -> Vec<RemoteDevice> {
        self.devices
            .lock()
            .await
            .list()
            .into_iter()
            .map(remote_device)
            .collect()
    }

    pub(crate) async fn revoke_device(&self, device_id: &str) -> RemoteResult<bool> {
        let device_id = uuid::Uuid::parse_str(device_id)
            .map_err(|_| RemoteError::InvalidConfiguration("device ID is not a UUID".into()))?
            .to_string();
        self.devices.lock().await.revoke(&device_id)
    }

    async fn set_last_error(&self, message: &str) {
        *self.last_error.lock().await = Some(message.to_string());
    }

    #[cfg(test)]
    pub(crate) async fn listening_addr(&self) -> Option<SocketAddr> {
        let _transition = self.transition.lock().await;
        if !self.listener_is_live_locked().await {
            return None;
        }
        self.running
            .lock()
            .await
            .as_ref()
            .map(|running| running.local_addr)
    }

    #[cfg(test)]
    async fn tracked_listener_count(&self) -> usize {
        let _transition = self.transition.lock().await;
        usize::from(self.listener_is_live_locked().await)
    }
}

fn connection_budget() -> Arc<Semaphore> {
    Arc::new(Semaphore::new(MAX_REMOTE_CONNECTIONS))
}

async fn run_listener(
    listener: TcpListener,
    acceptor: TlsAcceptor,
    app: axum::Router,
    access_mode: AccessMode,
    mut shutdown: watch::Receiver<bool>,
    connection_budget: Arc<Semaphore>,
) -> ListenerExit {
    loop {
        let accepted = tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return ListenerExit::Shutdown;
                }
                continue;
            }
            accepted = listener.accept() => accepted,
        };
        let (stream, peer) = match accepted {
            Ok(accepted) => accepted,
            // Do not spin on a persistent listener failure. `status` reaps this completed task
            // and surfaces only a stable local error string, never an OS/peer diagnostic.
            Err(_) => return ListenerExit::AcceptError,
        };
        // This happens before TLS and before route handling. A denied TCP peer gets no protocol
        // information or error body to probe.
        if !allows_peer(access_mode, peer.ip()) {
            continue;
        }
        // Accepted peers get a task only when a permit is immediately available. The permit stays
        // alive through the handshake and HTTP connection, then releases automatically on timeout,
        // shutdown, or normal completion. Excess sockets receive no protocol output.
        let Ok(permit) = connection_budget.clone().try_acquire_owned() else {
            continue;
        };
        let connection_acceptor = acceptor.clone();
        let connection_app = app.clone();
        let connection_shutdown = shutdown.clone();
        tokio::spawn(async move {
            let _permit = permit;
            serve_tls_connection(
                connection_acceptor,
                stream,
                peer,
                connection_app,
                connection_shutdown,
            )
            .await;
        });
    }
}

fn remote_device(device: DeviceSummary) -> RemoteDevice {
    RemoteDevice {
        id: device.id,
        display_name: device.display_name,
        paired_at: rfc3339(device.paired_at),
    }
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn valid_pairing_host(host: &str) -> bool {
    if host.is_empty()
        || host != host.trim()
        || host.len() > 253
        || host.contains(['/', '?', '#', '@', '[', ']'])
    {
        return false;
    }
    if host.parse::<IpAddr>().is_ok() {
        return true;
    }
    !host.starts_with('.')
        && !host.ends_with('.')
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn unused_port() -> u16 {
        unused_ports(1)[0]
    }

    fn unused_ports(count: usize) -> Vec<u16> {
        let reservations = (0..count)
            .map(|_| std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap())
            .collect::<Vec<_>>();
        reservations
            .iter()
            .map(|listener| listener.local_addr().unwrap().port())
            .collect()
    }

    #[tokio::test]
    async fn default_configuration_never_opens_a_listener() {
        let root = tempdir().unwrap();
        let service =
            RemoteService::load(root.path().to_path_buf(), Arc::new(PiManager::default())).unwrap();
        service.start_if_enabled().await.unwrap();
        assert!(!service.status().await.running);
        assert!(service.listening_addr().await.is_none());
    }

    #[tokio::test]
    async fn explicit_enable_starts_tls_and_disable_stops_immediately() {
        let root = tempdir().unwrap();
        let service =
            RemoteService::load(root.path().to_path_buf(), Arc::new(PiManager::default())).unwrap();
        let port = unused_port();
        service
            .set_config(RemoteConfig {
                enabled: true,
                port,
                ..RemoteConfig::default()
            })
            .await
            .unwrap();
        assert_eq!(service.listening_addr().await.unwrap().port(), port);
        assert!(
            tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
                .await
                .is_ok()
        );
        service
            .set_config(RemoteConfig {
                enabled: false,
                port,
                ..RemoteConfig::default()
            })
            .await
            .unwrap();
        assert!(!service.status().await.running);
        assert!(
            tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn serialized_restarts_close_old_ports_and_leave_no_orphan_listener() {
        let root = tempdir().unwrap();
        let service = Arc::new(
            RemoteService::load(root.path().to_path_buf(), Arc::new(PiManager::default())).unwrap(),
        );
        let ports = unused_ports(3);
        let (first_port, second_port, third_port) = (ports[0], ports[1], ports[2]);
        service
            .set_config(RemoteConfig {
                enabled: true,
                port: first_port,
                ..RemoteConfig::default()
            })
            .await
            .unwrap();
        assert!(
            tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, first_port))
                .await
                .is_ok()
        );
        service
            .set_config(RemoteConfig {
                enabled: true,
                port: second_port,
                ..RemoteConfig::default()
            })
            .await
            .unwrap();
        assert!(
            tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, first_port))
                .await
                .is_err()
        );
        assert_eq!(service.tracked_listener_count().await, 1);

        let first = {
            let service = Arc::clone(&service);
            tokio::spawn(async move {
                service
                    .set_config(RemoteConfig {
                        enabled: true,
                        port: first_port,
                        ..RemoteConfig::default()
                    })
                    .await
            })
        };
        let second = {
            let service = Arc::clone(&service);
            tokio::spawn(async move {
                service
                    .set_config(RemoteConfig {
                        enabled: true,
                        port: third_port,
                        ..RemoteConfig::default()
                    })
                    .await
            })
        };
        let third = {
            let service = Arc::clone(&service);
            tokio::spawn(async move { service.start().await })
        };
        let disable = {
            let service = Arc::clone(&service);
            tokio::spawn(async move {
                service
                    .set_config(RemoteConfig {
                        enabled: false,
                        port: third_port,
                        ..RemoteConfig::default()
                    })
                    .await
            })
        };
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
        third.await.unwrap().unwrap();
        disable.await.unwrap().unwrap();

        // Make the final operation deterministic after the deliberate race, then prove that every
        // port involved in the transition is closed and no `RunningServer` is left behind.
        service
            .set_config(RemoteConfig {
                enabled: false,
                port: third_port,
                ..RemoteConfig::default()
            })
            .await
            .unwrap();
        assert_eq!(service.tracked_listener_count().await, 0);
        for port in ports {
            assert!(
                tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
                    .await
                    .is_err(),
                "port {port} remained open after serialized disable"
            );
        }
    }

    #[tokio::test]
    async fn finished_listener_is_reaped_from_status_and_rejected_for_pairing() {
        let root = tempdir().unwrap();
        let service =
            RemoteService::load(root.path().to_path_buf(), Arc::new(PiManager::default())).unwrap();
        let (shutdown, _) = watch::channel(false);
        *service.running.lock().await = Some(RunningServer {
            local_addr: "127.0.0.1:9443".parse().unwrap(),
            shutdown,
            task: tokio::spawn(async { ListenerExit::AcceptError }),
        });
        tokio::task::yield_now().await;
        let status = service.status().await;
        assert!(!status.running);
        assert!(!status.pairing_active);
        assert_eq!(
            status.last_error.as_deref(),
            Some("The remote host stopped unexpectedly.")
        );
        assert!(service
            .start_pairing("host.tailnet.ts.net".into())
            .await
            .is_err());
        assert!(service.listening_addr().await.is_none());
    }

    #[tokio::test]
    async fn connection_budget_caps_eight_tasks_and_releases_permits() {
        let budget = connection_budget();
        let mut permits = (0..MAX_REMOTE_CONNECTIONS)
            .map(|_| budget.clone().try_acquire_owned().unwrap())
            .collect::<Vec<_>>();
        assert!(budget.clone().try_acquire_owned().is_err());
        drop(permits.pop());
        let replacement = budget.clone().try_acquire_owned().unwrap();
        drop(replacement);
        drop(permits);
        assert_eq!(budget.available_permits(), MAX_REMOTE_CONNECTIONS);
    }

    #[test]
    fn pairing_host_validation_accepts_lan_tailnet_and_raw_ipv6_without_urls() {
        for valid in [
            "192.168.1.2",
            "100.64.0.5",
            "host.tailnet.ts.net",
            "fd7a:115c:a1e0::1",
        ] {
            assert!(valid_pairing_host(valid), "{valid}");
        }
        for invalid in ["https://host", "host:8787", " host", "host/path", "[::1]"] {
            assert!(!valid_pairing_host(invalid), "{invalid}");
        }
    }
}
