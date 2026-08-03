//! Private, persistence-only foundations for a future LemonPi remote bridge.
//!
//! This module intentionally owns no listener, socket, Tauri command, or runtime state.
//! Its types are exercised only by unit tests until a later opt-in service layer is added.

mod auth;
mod config;
mod identity;
mod policy;

use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::Path,
};
use uuid::Uuid;

pub(crate) const CURRENT_REMOTE_STORAGE_VERSION: u32 = 1;

#[derive(Debug)]
pub(crate) enum RemoteError {
    Io(std::io::Error),
    Json(serde_json::Error),
    InvalidConfiguration(String),
    InvalidIdentity(String),
    InvalidToken,
    DeviceLimitReached,
}

impl std::fmt::Display for RemoteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "Remote storage error: {error}"),
            Self::Json(error) => write!(formatter, "Remote storage format error: {error}"),
            Self::InvalidConfiguration(message) => {
                write!(formatter, "Invalid remote configuration: {message}")
            }
            Self::InvalidIdentity(message) => {
                write!(formatter, "Invalid remote identity: {message}")
            }
            Self::InvalidToken => write!(formatter, "Invalid device token"),
            Self::DeviceLimitReached => write!(
                formatter,
                "The maximum number of paired devices has been reached"
            ),
        }
    }
}

impl std::error::Error for RemoteError {}

impl From<std::io::Error> for RemoteError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for RemoteError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

pub(crate) type RemoteResult<T> = Result<T, RemoteError>;

/// Writes a JSON document through a same-directory temporary file, then atomically replaces its
/// destination. Remote credentials and identity material always use restrictive file permissions.
fn write_json_atomically<T: Serialize>(path: &Path, value: &T) -> RemoteResult<()> {
    let temporary_path = write_json_temporary(path, value)?;
    let write_result = (|| -> RemoteResult<()> {
        fs::rename(&temporary_path, path)?;
        restrict_file_permissions(path)?;
        sync_parent_directory(path)
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    write_result
}

/// Atomically creates a JSON document only if no document exists yet. The hard-link operation is
/// a no-replace filesystem primitive: competing first-run callers either install their complete,
/// synced temporary file or load the identity installed by the winner.
fn write_json_if_absent<T: Serialize>(path: &Path, value: &T) -> RemoteResult<bool> {
    let temporary_path = write_json_temporary(path, value)?;
    let write_result = match fs::hard_link(&temporary_path, path) {
        Ok(()) => {
            restrict_file_permissions(path)?;
            sync_parent_directory(path)?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(RemoteError::Io(error)),
    };
    let _ = fs::remove_file(&temporary_path);
    write_result
}

fn write_json_temporary<T: Serialize>(path: &Path, value: &T) -> RemoteResult<std::path::PathBuf> {
    let parent = path.parent().ok_or_else(|| {
        RemoteError::InvalidConfiguration(
            "remote storage paths must have a parent directory".into(),
        )
    })?;
    fs::create_dir_all(parent)?;

    let bytes = serde_json::to_vec_pretty(value)?;
    let temporary_path = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| RemoteError::InvalidConfiguration(
                "remote storage file name is invalid".into()
            ))?,
        Uuid::new_v4()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut temporary = options.open(&temporary_path)?;
    let write_result = (|| -> RemoteResult<()> {
        temporary.write_all(&bytes)?;
        temporary.write_all(b"\n")?;
        temporary.sync_all()?;
        Ok(())
    })();
    drop(temporary);

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    Ok(temporary_path)
}

fn sync_parent_directory(path: &Path) -> RemoteResult<()> {
    #[cfg(unix)]
    {
        let parent = path.parent().ok_or_else(|| {
            RemoteError::InvalidConfiguration(
                "remote storage paths must have a parent directory".into(),
            )
        })?;
        // Persist the replacement directory entry as well as the file contents on platforms
        // where opening and syncing directories is supported.
        File::open(parent)?.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

fn read_json<T: DeserializeOwned>(path: &Path) -> RemoteResult<T> {
    let file = File::open(path)?;
    Ok(serde_json::from_reader(file)?)
}

fn restrict_file_permissions(path: &Path) -> RemoteResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}
