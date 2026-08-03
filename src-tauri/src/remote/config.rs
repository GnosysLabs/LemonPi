use super::{
    read_json, restrict_file_permissions, write_json_atomically, RemoteError, RemoteResult,
    CURRENT_REMOTE_STORAGE_VERSION,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const REMOTE_CONFIG_FILE: &str = "remote-config.json";
const DEFAULT_REMOTE_PORT: u16 = 8787;

/// Networks a future remote bridge may accept after it is explicitly enabled.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AccessMode {
    LanAndTailscale,
    LanOnly,
    TailscaleOnly,
}

/// Versioned, opt-in configuration for the future remote bridge.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteConfig {
    pub(crate) version: u32,
    pub(crate) enabled: bool,
    pub(crate) port: u16,
    pub(crate) access_mode: AccessMode,
}

impl Default for RemoteConfig {
    fn default() -> Self {
        Self {
            version: CURRENT_REMOTE_STORAGE_VERSION,
            enabled: false,
            port: DEFAULT_REMOTE_PORT,
            access_mode: AccessMode::LanAndTailscale,
        }
    }
}

impl RemoteConfig {
    pub(crate) fn validate(&self) -> RemoteResult<()> {
        if self.version != CURRENT_REMOTE_STORAGE_VERSION {
            return Err(RemoteError::InvalidConfiguration(format!(
                "unsupported storage version {}",
                self.version
            )));
        }
        if self.port == 0 {
            return Err(RemoteError::InvalidConfiguration(
                "port must be between 1 and 65535".into(),
            ));
        }
        Ok(())
    }
}

/// Persists remote configuration below a caller-supplied remote configuration directory.
pub(crate) struct RemoteConfigStore {
    path: PathBuf,
}

impl RemoteConfigStore {
    pub(crate) fn new(directory: impl AsRef<Path>) -> Self {
        Self {
            path: directory.as_ref().join(REMOTE_CONFIG_FILE),
        }
    }

    pub(crate) fn load_or_default(&self) -> RemoteResult<RemoteConfig> {
        match read_json::<RemoteConfig>(&self.path) {
            Ok(config) => {
                config.validate()?;
                restrict_file_permissions(&self.path)?;
                Ok(config)
            }
            Err(RemoteError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(RemoteConfig::default())
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) fn save(&self, config: &RemoteConfig) -> RemoteResult<()> {
        config.validate()?;
        write_json_atomically(&self.path, config)
    }

    #[cfg(test)]
    fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn defaults_are_disabled_and_safe_for_lan_and_tailscale() {
        let config = RemoteConfig::default();

        assert_eq!(config.version, CURRENT_REMOTE_STORAGE_VERSION);
        assert!(!config.enabled);
        assert_eq!(config.port, DEFAULT_REMOTE_PORT);
        assert_eq!(config.access_mode, AccessMode::LanAndTailscale);
        assert!(config.validate().is_ok());
    }

    #[test]
    fn configuration_round_trips_through_its_caller_owned_directory() {
        let directory = tempdir().unwrap();
        let store = RemoteConfigStore::new(directory.path());
        let config = RemoteConfig {
            enabled: true,
            port: 9443,
            access_mode: AccessMode::TailscaleOnly,
            ..RemoteConfig::default()
        };

        store.save(&config).unwrap();

        assert_eq!(store.load_or_default().unwrap(), config);
        assert!(store.path().is_file());
    }

    #[test]
    fn configuration_rejects_unsupported_versions_and_port_zero() {
        let unsupported_version = RemoteConfig {
            version: CURRENT_REMOTE_STORAGE_VERSION + 1,
            ..RemoteConfig::default()
        };
        let no_port = RemoteConfig {
            port: 0,
            ..RemoteConfig::default()
        };

        assert!(matches!(
            unsupported_version.validate(),
            Err(RemoteError::InvalidConfiguration(_))
        ));
        assert!(matches!(
            no_port.validate(),
            Err(RemoteError::InvalidConfiguration(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn persisted_configuration_has_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().unwrap();
        let store = RemoteConfigStore::new(directory.path());
        store.save(&RemoteConfig::default()).unwrap();

        assert_eq!(
            std::fs::metadata(store.path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
