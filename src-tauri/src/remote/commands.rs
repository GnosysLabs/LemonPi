//! Local Tauri commands for explicit remote-access consent and device administration.
//!
//! These commands are deliberately local-only. They return safe configuration, status, pairing
//! material, and device labels but never remote storage paths, TLS private key material, pairing
//! token digests, or issued bearer tokens.

use super::{
    config::RemoteConfig,
    service::{PairingMaterial, RemoteDevice, RemoteService, RemoteStatus},
};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub(crate) async fn get_remote_config(
    service: State<'_, Arc<RemoteService>>,
) -> Result<RemoteConfig, String> {
    Ok(service.config().await)
}

#[tauri::command]
pub(crate) async fn set_remote_config(
    config: RemoteConfig,
    service: State<'_, Arc<RemoteService>>,
) -> Result<RemoteStatus, String> {
    service
        .set_config(config)
        .await
        .map_err(|error| error.to_string())?;
    Ok(service.status().await)
}

#[tauri::command]
pub(crate) async fn start_remote_pairing(
    host: String,
    service: State<'_, Arc<RemoteService>>,
) -> Result<PairingMaterial, String> {
    service
        .start_pairing(host)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn cancel_remote_pairing(
    service: State<'_, Arc<RemoteService>>,
) -> Result<(), String> {
    service.cancel_pairing().await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn list_remote_devices(
    service: State<'_, Arc<RemoteService>>,
) -> Result<Vec<RemoteDevice>, String> {
    Ok(service.list_devices().await)
}

#[tauri::command]
pub(crate) async fn revoke_remote_device(
    device_id: String,
    service: State<'_, Arc<RemoteService>>,
) -> Result<bool, String> {
    service
        .revoke_device(&device_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn get_remote_status(
    service: State<'_, Arc<RemoteService>>,
) -> Result<RemoteStatus, String> {
    Ok(service.status().await)
}
