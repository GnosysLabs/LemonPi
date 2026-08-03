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
    sync::{watch, Mutex},
    task::JoinHandle,
};
use tokio_rustls::TlsAcceptor;

struct RunningServer {
    local_addr: SocketAddr,
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
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
        if self.config.lock().await.enabled {
            self.start().await
        } else {
            Ok(())
        }
    }

    /// Persists the setting before enabling. Disabling tears down the listener even if persistence
    /// fails, so a local user's immediate security action is never delayed by a disk error.
    pub(crate) async fn set_config(&self, config: RemoteConfig) -> RemoteResult<()> {
        config.validate()?;
        let save_result = RemoteConfigStore::new(&self.storage).save(&config);
        if let Err(error) = save_result {
            if !config.enabled {
                self.stop().await;
            }
            return Err(error);
        }
        *self.config.lock().await = config.clone();
        if config.enabled {
            self.start().await
        } else {
            self.stop().await;
            Ok(())
        }
    }

    /// Starts a fresh listener after stopping an existing one. The listener is IPv4-only in v1;
    /// see the user-facing residual risk in the implementation report for IPv6 tailnets.
    pub(crate) async fn start(&self) -> RemoteResult<()> {
        let config = self.config.lock().await.clone();
        if !config.enabled {
            return Ok(());
        }
        self.stop().await;
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
        let app = router(state);
        let acceptor = TlsAcceptor::from(tls);
        let (shutdown, shutdown_rx) = watch::channel(false);
        let task = tokio::spawn(run_listener(
            listener,
            acceptor,
            app,
            config.access_mode,
            shutdown_rx,
        ));
        *self.running.lock().await = Some(RunningServer {
            local_addr,
            shutdown,
            task,
        });
        *self.last_error.lock().await = None;
        Ok(())
    }

    pub(crate) async fn stop(&self) {
        let running = self.running.lock().await.take();
        if let Some(running) = running {
            let _ = running.shutdown.send(true);
            let _ = tokio::time::timeout(Duration::from_secs(2), running.task).await;
        }
        *self.pairing.lock().await = None;
    }

    pub(crate) async fn status(&self) -> RemoteStatus {
        let config = self.config.lock().await.clone();
        let running = self.running.lock().await.is_some();
        let now = unix_seconds();
        let pairing_active = self
            .pairing
            .lock()
            .await
            .as_mut()
            .and_then(|window| window.display_code_at(now))
            .is_some();
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
        if !self.running.lock().await.is_some() {
            return Err(RemoteError::InvalidConfiguration(
                "remote access is not running".into(),
            ));
        }
        let now = unix_seconds();
        let mut pairing = self.pairing.lock().await;
        *pairing = Some(PairingWindow::open_at(now));
        let window = pairing.as_mut().expect("pairing window was inserted");
        let code = window
            .display_code_at(now)
            .expect("fresh pairing window is immediately readable")
            .to_string();
        Ok(PairingMaterial {
            version: super::protocol::PROTOCOL_VERSION,
            host,
            port: self.config.lock().await.port,
            host_id: self.identity.host_id().to_string(),
            code,
            certificate_pin: self.identity.certificate_pin_base64url()?,
            expires_at: rfc3339(window.expires_at()),
        })
    }

    pub(crate) async fn cancel_pairing(&self) {
        *self.pairing.lock().await = None;
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
        self.running
            .lock()
            .await
            .as_ref()
            .map(|running| running.local_addr)
    }
}

async fn run_listener(
    listener: TcpListener,
    acceptor: TlsAcceptor,
    app: axum::Router,
    access_mode: AccessMode,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        let accepted = tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
                continue;
            }
            accepted = listener.accept() => accepted,
        };
        let Ok((stream, peer)) = accepted else {
            continue;
        };
        // This happens before TLS and before route handling. A denied TCP peer gets no protocol
        // information or error body to probe.
        if !allows_peer(access_mode, peer.ip()) {
            continue;
        }
        tokio::spawn(serve_tls_connection(
            acceptor.clone(),
            stream,
            peer,
            app.clone(),
            shutdown.clone(),
        ));
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
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.local_addr().unwrap().port()
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
