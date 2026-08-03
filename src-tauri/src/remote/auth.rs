use super::{
    read_json, restrict_file_permissions, write_json_atomically, RemoteError, RemoteResult,
    CURRENT_REMOTE_STORAGE_VERSION,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use subtle::{Choice, ConstantTimeEq};
use uuid::Uuid;

const DEVICE_STORE_FILE: &str = "devices.json";
const MAX_DEVICES: usize = 16;
const PAIRING_CODE_LENGTH: usize = 8;
const PAIRING_LIFETIME_SECONDS: u64 = 5 * 60;
const MAX_PAIRING_FAILURES: u8 = 5;
const CROCKFORD_SYMBOLS: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceStoreDocument {
    version: u32,
    devices: Vec<DeviceRecord>,
}

impl Default for DeviceStoreDocument {
    fn default() -> Self {
        Self {
            version: CURRENT_REMOTE_STORAGE_VERSION,
            devices: Vec::new(),
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceRecord {
    id: String,
    label: String,
    paired_at: u64,
    token_digest: String,
}

/// Non-secret device metadata that may be displayed by the local remote settings surface or
/// returned to an already-authorized caller. It deliberately contains no token material.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceSummary {
    pub(crate) id: String,
    pub(crate) display_name: String,
    pub(crate) paired_at: u64,
}

impl From<&DeviceRecord> for DeviceSummary {
    fn from(record: &DeviceRecord) -> Self {
        Self {
            id: record.id.clone(),
            display_name: record.label.clone(),
            paired_at: record.paired_at,
        }
    }
}

/// Owner-only persistence for paired device token digests.
pub(crate) struct DeviceStore {
    path: PathBuf,
    document: DeviceStoreDocument,
}

impl DeviceStore {
    pub(crate) fn load_or_create(directory: impl AsRef<Path>) -> RemoteResult<Self> {
        let path = directory.as_ref().join(DEVICE_STORE_FILE);
        let document = match read_json(&path) {
            Ok(document) => {
                validate_document(&document)?;
                restrict_file_permissions(&path)?;
                document
            }
            Err(RemoteError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                DeviceStoreDocument::default()
            }
            Err(error) => return Err(error),
        };

        Ok(Self { path, document })
    }

    pub(crate) fn list(&self) -> Vec<DeviceSummary> {
        self.document
            .devices
            .iter()
            .map(DeviceSummary::from)
            .collect()
    }

    /// Verifies every persisted digest and combines matches without early exit.
    pub(crate) fn verifies(&self, plaintext_token: &str) -> bool {
        let (candidate, valid_token) = token_digest_for_verification(plaintext_token);
        let mut any_match = Choice::from(0_u8);

        for record in &self.document.devices {
            // Corrupt persisted input is treated as a non-match; it does not make verification
            // exit early or reveal which record caused the problem.
            let stored = decode_digest(&record.token_digest).unwrap_or([0_u8; 32]);
            any_match |= stored.ct_eq(&candidate);
        }

        bool::from(valid_token & any_match)
    }

    pub(crate) fn revoke(&mut self, device_id: &str) -> RemoteResult<bool> {
        let Some(index) = self
            .document
            .devices
            .iter()
            .position(|record| record.id == device_id)
        else {
            return Ok(false);
        };
        let removed = self.document.devices.remove(index);
        if let Err(error) = self.persist() {
            self.document.devices.insert(index, removed);
            return Err(error);
        }
        Ok(true)
    }

    /// Persists exactly the client-generated canonical UUID after first proving it is not paired.
    /// The caller owns plaintext-token lifetime; only its digest reaches the document.
    pub(crate) fn add_device(
        &mut self,
        device_id: String,
        display_name: String,
        plaintext_token: &str,
        paired_at: u64,
    ) -> RemoteResult<DeviceSummary> {
        let device_id = Uuid::parse_str(&device_id)
            .map_err(|_| RemoteError::InvalidConfiguration("device ID is not a UUID".into()))?
            .to_string();
        if self
            .document
            .devices
            .iter()
            .any(|device| device.id == device_id)
        {
            return Err(RemoteError::DeviceAlreadyPaired);
        }
        if self.document.devices.len() >= MAX_DEVICES {
            return Err(RemoteError::DeviceLimitReached);
        }
        let digest = token_digest(plaintext_token)?;
        let record = DeviceRecord {
            id: device_id,
            label: display_name,
            paired_at,
            token_digest: URL_SAFE_NO_PAD.encode(digest),
        };
        let summary = DeviceSummary::from(&record);
        self.document.devices.push(record);
        if let Err(error) = self.persist() {
            self.document.devices.pop();
            return Err(error);
        }
        Ok(summary)
    }

    fn persist(&self) -> RemoteResult<()> {
        write_json_atomically(&self.path, &self.document)
    }

    #[cfg(test)]
    fn path(&self) -> &Path {
        &self.path
    }
}

fn validate_document(document: &DeviceStoreDocument) -> RemoteResult<()> {
    if document.version != CURRENT_REMOTE_STORAGE_VERSION {
        return Err(RemoteError::InvalidConfiguration(format!(
            "unsupported device store version {}",
            document.version
        )));
    }
    if document.devices.len() > MAX_DEVICES {
        return Err(RemoteError::InvalidConfiguration(format!(
            "device store has more than {MAX_DEVICES} devices"
        )));
    }
    for record in &document.devices {
        Uuid::parse_str(&record.id)
            .map_err(|_| RemoteError::InvalidConfiguration("device ID is not a UUID".into()))?;
        if decode_digest(&record.token_digest).is_none() {
            return Err(RemoteError::InvalidConfiguration(
                "device token digest is invalid".into(),
            ));
        }
    }
    Ok(())
}

/// Mints a 32-byte opaque bearer token encoded as unpadded URL-safe Base64.
fn mint_device_token() -> String {
    let mut token = [0_u8; 32];
    OsRng.fill_bytes(&mut token);
    URL_SAFE_NO_PAD.encode(token)
}

fn token_digest(plaintext_token: &str) -> RemoteResult<[u8; 32]> {
    let token = URL_SAFE_NO_PAD
        .decode(plaintext_token)
        .map_err(|_| RemoteError::InvalidToken)?;
    let token: [u8; 32] = token.try_into().map_err(|_| RemoteError::InvalidToken)?;
    Ok(Sha256::digest(token).into())
}

fn token_digest_for_verification(plaintext_token: &str) -> ([u8; 32], Choice) {
    match token_digest(plaintext_token) {
        Ok(digest) => (digest, Choice::from(1_u8)),
        Err(_) => ([0_u8; 32], Choice::from(0_u8)),
    }
}

fn decode_digest(encoded_digest: &str) -> Option<[u8; 32]> {
    URL_SAFE_NO_PAD.decode(encoded_digest).ok()?.try_into().ok()
}

/// A single-use, in-memory pairing code. Time is supplied by the caller so callers and tests do
/// not need to sleep to exercise expiry behavior.
pub(crate) struct PairingWindow {
    code: String,
    expires_at: u64,
    failed_attempts: u8,
    closed: bool,
}

pub(crate) enum PairingAttempt {
    Success {
        device: DeviceSummary,
        /// The one and only plaintext exposure of the token. It is never retained by this type.
        device_token: String,
    },
    InvalidCode {
        attempts_remaining: u8,
    },
    Expired,
    AttemptsExceeded,
    Closed,
    DeviceLimitReached,
    DeviceAlreadyPaired,
    StorageFailure,
}

impl PairingWindow {
    pub(crate) fn open_at(now: u64) -> Self {
        let mut code = String::with_capacity(PAIRING_CODE_LENGTH);
        for _ in 0..PAIRING_CODE_LENGTH {
            // 32 symbols makes bit masking unbiased while retaining the Crockford alphabet.
            code.push(CROCKFORD_SYMBOLS[(OsRng.next_u32() & 31) as usize] as char);
        }
        Self {
            code,
            expires_at: now.saturating_add(PAIRING_LIFETIME_SECONDS),
            failed_attempts: 0,
            closed: false,
        }
    }

    /// Code intended solely for the local host UI to display during this short pairing window.
    /// Expiry is checked when the code is read as well as when a pairing attempt arrives.
    pub(crate) fn display_code_at(&mut self, now: u64) -> Option<&str> {
        if !self.closed && now >= self.expires_at {
            self.closed = true;
        }
        (!self.closed).then_some(self.code.as_str())
    }

    pub(crate) fn expires_at(&self) -> u64 {
        self.expires_at
    }

    pub(crate) fn attempt(
        &mut self,
        supplied_code: &str,
        device_id: String,
        display_name: String,
        now: u64,
        devices: &mut DeviceStore,
    ) -> PairingAttempt {
        if self.closed {
            return PairingAttempt::Closed;
        }
        if now >= self.expires_at {
            self.closed = true;
            return PairingAttempt::Expired;
        }
        if !bool::from(self.code.as_bytes().ct_eq(supplied_code.as_bytes())) {
            self.failed_attempts += 1;
            if self.failed_attempts >= MAX_PAIRING_FAILURES {
                self.closed = true;
                PairingAttempt::AttemptsExceeded
            } else {
                PairingAttempt::InvalidCode {
                    attempts_remaining: MAX_PAIRING_FAILURES - self.failed_attempts,
                }
            }
        } else {
            let token = mint_device_token();
            match devices.add_device(device_id, display_name, &token, now) {
                Ok(device) => {
                    self.closed = true;
                    PairingAttempt::Success {
                        device,
                        device_token: token,
                    }
                }
                Err(RemoteError::DeviceLimitReached) => PairingAttempt::DeviceLimitReached,
                Err(RemoteError::DeviceAlreadyPaired) => PairingAttempt::DeviceAlreadyPaired,
                // Do not claim that the window closed when persistence failed: the host can
                // surface a generic retry action while the pairing window remains valid.
                Err(_) => PairingAttempt::StorageFailure,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn device_id(value: u128) -> String {
        Uuid::from_u128(value).to_string()
    }

    #[test]
    fn minted_tokens_are_32_random_bytes_in_unpadded_base64url() {
        let token = mint_device_token();

        assert_eq!(URL_SAFE_NO_PAD.decode(&token).unwrap().len(), 32);
        assert!(!token.contains('='));
        assert_ne!(token, mint_device_token());
    }

    #[test]
    fn token_is_hashed_at_rest_and_verification_checks_all_digests() {
        let directory = tempdir().unwrap();
        let mut devices = DeviceStore::load_or_create(directory.path()).unwrap();
        let token = mint_device_token();
        devices
            .add_device(device_id(1), "My iPhone".into(), &token, 12)
            .unwrap();

        let stored = std::fs::read_to_string(devices.path()).unwrap();
        assert!(!stored.contains(&token));
        assert!(devices.verifies(&token));
        assert!(!devices.verifies(&mint_device_token()));
        assert!(!devices.verifies("not-a-valid-device-token"));
    }

    #[test]
    fn revocation_and_device_limit_are_persisted() {
        let directory = tempdir().unwrap();
        let mut devices = DeviceStore::load_or_create(directory.path()).unwrap();
        let first_token = mint_device_token();
        let first = devices
            .add_device(device_id(1), "First".into(), &first_token, 1)
            .unwrap();

        for index in 1..MAX_DEVICES {
            devices
                .add_device(
                    device_id(index as u128 + 1),
                    format!("Device {index}"),
                    &mint_device_token(),
                    index as u64,
                )
                .unwrap();
        }
        assert_eq!(devices.list().len(), MAX_DEVICES);
        assert!(matches!(
            devices.add_device(device_id(99), "Too many".into(), &mint_device_token(), 99),
            Err(RemoteError::DeviceLimitReached)
        ));

        assert!(devices.revoke(&first.id).unwrap());
        assert!(!devices.verifies(&first_token));
        assert!(!devices.revoke(&first.id).unwrap());
        assert_eq!(
            DeviceStore::load_or_create(directory.path())
                .unwrap()
                .list()
                .len(),
            MAX_DEVICES - 1
        );
    }

    #[cfg(unix)]
    #[test]
    fn device_store_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().unwrap();
        let mut devices = DeviceStore::load_or_create(directory.path()).unwrap();
        devices
            .add_device(device_id(1), "Phone".into(), &mint_device_token(), 1)
            .unwrap();

        assert_eq!(
            std::fs::metadata(devices.path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn pairing_returns_the_plaintext_token_once_after_a_correct_code() {
        let directory = tempdir().unwrap();
        let mut devices = DeviceStore::load_or_create(directory.path()).unwrap();
        let mut window = PairingWindow::open_at(1_000);
        let code = window.display_code_at(1_000).unwrap().to_string();

        let token =
            match window.attempt(&code, device_id(1), "My iPhone".into(), 1_001, &mut devices) {
                PairingAttempt::Success {
                    device,
                    device_token,
                } => {
                    assert_eq!(device.display_name, "My iPhone");
                    device_token
                }
                _ => panic!("the correct pairing code must succeed"),
            };

        assert!(devices.verifies(&token));
        assert!(window.display_code_at(1_002).is_none());
        assert!(matches!(
            window.attempt(&code, device_id(1), "My iPhone".into(), 1_002, &mut devices),
            PairingAttempt::Closed
        ));
    }

    #[test]
    fn pairing_expires_and_closes_after_five_bad_attempts_without_sleeping() {
        let directory = tempdir().unwrap();
        let mut devices = DeviceStore::load_or_create(directory.path()).unwrap();
        let mut expired = PairingWindow::open_at(0);
        let valid_code = expired.display_code_at(0).unwrap().to_string();

        assert!(matches!(
            expired.attempt(
                &valid_code,
                device_id(1),
                "Phone".into(),
                PAIRING_LIFETIME_SECONDS,
                &mut devices
            ),
            PairingAttempt::Expired
        ));

        let mut capped = PairingWindow::open_at(0);
        for _ in 0..(MAX_PAIRING_FAILURES - 1) {
            assert!(matches!(
                capped.attempt("INVALID!", device_id(1), "Phone".into(), 1, &mut devices),
                PairingAttempt::InvalidCode { .. }
            ));
        }
        assert!(matches!(
            capped.attempt("INVALID!", device_id(1), "Phone".into(), 1, &mut devices),
            PairingAttempt::AttemptsExceeded
        ));
        assert!(matches!(
            capped.attempt("INVALID!", device_id(1), "Phone".into(), 1, &mut devices),
            PairingAttempt::Closed
        ));
    }
}
