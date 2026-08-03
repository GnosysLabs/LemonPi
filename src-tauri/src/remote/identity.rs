use super::{
    read_json, restrict_file_permissions, write_json_if_absent, RemoteError, RemoteResult,
    CURRENT_REMOTE_STORAGE_VERSION,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rcgen::{CertificateParams, KeyPair, PKCS_ECDSA_P256_SHA256};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const HOST_IDENTITY_FILE: &str = "host-identity.json";

/// Persistent local identity for the future TLS endpoint.
///
/// The private key remains serialized only inside the owner-only identity file. It deliberately
/// has no public accessor and no `Debug` implementation, so it cannot be accidentally surfaced
/// by future UI or diagnostics code.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostIdentity {
    version: u32,
    host_id: String,
    hostname: String,
    certificate_der: String,
    private_key_der: String,
    certificate_fingerprint: String,
}

impl HostIdentity {
    pub(crate) fn host_id(&self) -> &str {
        &self.host_id
    }

    pub(crate) fn hostname(&self) -> &str {
        &self.hostname
    }

    /// SHA-256 of the certificate DER, represented as lowercase hexadecimal for local diagnostics.
    pub(crate) fn certificate_fingerprint(&self) -> &str {
        &self.certificate_fingerprint
    }

    /// The QR/manual protocol uses the same DER digest encoded as unpadded base64url.
    pub(crate) fn certificate_pin_base64url(&self) -> RemoteResult<String> {
        Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(self.certificate_der()?)))
    }

    pub(crate) fn certificate_der(&self) -> RemoteResult<Vec<u8>> {
        URL_SAFE_NO_PAD
            .decode(&self.certificate_der)
            .map_err(|_| RemoteError::InvalidIdentity("certificate encoding is invalid".into()))
    }

    /// Returns TLS-only DER material to the local server constructor. This is intentionally
    /// crate-private and never derives `Debug`, preventing private-key material from crossing UI,
    /// diagnostics, or wire boundaries.
    pub(crate) fn tls_der(&self) -> RemoteResult<(Vec<u8>, Vec<u8>)> {
        let certificate = self.certificate_der()?;
        let private_key = URL_SAFE_NO_PAD
            .decode(&self.private_key_der)
            .map_err(|_| RemoteError::InvalidIdentity("private key encoding is invalid".into()))?;
        if private_key.is_empty() {
            return Err(RemoteError::InvalidIdentity("private key is empty".into()));
        }
        Ok((certificate, private_key))
    }

    fn create() -> RemoteResult<Self> {
        let key_pair = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(|error| {
            RemoteError::InvalidIdentity(format!("could not generate P-256 key: {error}"))
        })?;
        let certificate = CertificateParams::new(Vec::<String>::new())
            .map_err(|error| {
                RemoteError::InvalidIdentity(format!("could not configure certificate: {error}"))
            })?
            .self_signed(&key_pair)
            .map_err(|error| {
                RemoteError::InvalidIdentity(format!("could not generate certificate: {error}"))
            })?;
        let certificate_der = certificate.der().to_vec();
        let hostname = hostname::get()
            .ok()
            .and_then(|name| name.into_string().ok())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "LemonPi Host".to_string());

        Ok(Self {
            version: CURRENT_REMOTE_STORAGE_VERSION,
            host_id: Uuid::new_v4().to_string(),
            hostname,
            certificate_der: URL_SAFE_NO_PAD.encode(&certificate_der),
            private_key_der: URL_SAFE_NO_PAD.encode(key_pair.serialize_der()),
            certificate_fingerprint: fingerprint(&certificate_der),
        })
    }

    fn validate(&self) -> RemoteResult<()> {
        if self.version != CURRENT_REMOTE_STORAGE_VERSION {
            return Err(RemoteError::InvalidIdentity(format!(
                "unsupported storage version {}",
                self.version
            )));
        }
        Uuid::parse_str(&self.host_id)
            .map_err(|_| RemoteError::InvalidIdentity("host ID is not a UUID".into()))?;
        if self.hostname.trim().is_empty() {
            return Err(RemoteError::InvalidIdentity("hostname is empty".into()));
        }
        let (certificate_der, _) = self.tls_der()?;
        if self.certificate_fingerprint != fingerprint(&certificate_der) {
            return Err(RemoteError::InvalidIdentity(
                "certificate fingerprint does not match the certificate".into(),
            ));
        }
        Ok(())
    }
}

/// Loads an existing host identity or atomically creates it exactly once.
pub(crate) struct HostIdentityStore {
    path: PathBuf,
}

impl HostIdentityStore {
    pub(crate) fn new(directory: impl AsRef<Path>) -> Self {
        Self {
            path: directory.as_ref().join(HOST_IDENTITY_FILE),
        }
    }

    pub(crate) fn load_or_create(&self) -> RemoteResult<HostIdentity> {
        match read_json::<HostIdentity>(&self.path) {
            Ok(identity) => {
                identity.validate()?;
                restrict_file_permissions(&self.path)?;
                Ok(identity)
            }
            Err(RemoteError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                let identity = HostIdentity::create()?;
                if write_json_if_absent(&self.path, &identity)? {
                    Ok(identity)
                } else {
                    let installed = read_json::<HostIdentity>(&self.path)?;
                    installed.validate()?;
                    restrict_file_permissions(&self.path)?;
                    Ok(installed)
                }
            }
            Err(error) => Err(error),
        }
    }

    #[cfg(test)]
    fn path(&self) -> &Path {
        &self.path
    }
}

fn fingerprint(certificate_der: &[u8]) -> String {
    let digest = Sha256::digest(certificate_der);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn identity_is_stable_and_has_a_der_fingerprint() {
        let directory = tempdir().unwrap();
        let store = HostIdentityStore::new(directory.path());

        let first = store.load_or_create().unwrap();
        let second = store.load_or_create().unwrap();
        let certificate = first.certificate_der().unwrap();

        assert_eq!(first.host_id(), second.host_id());
        assert_eq!(
            first.certificate_fingerprint(),
            second.certificate_fingerprint()
        );
        assert!(!first.hostname().is_empty());
        assert!(Uuid::parse_str(first.host_id()).is_ok());
        assert!(!certificate.is_empty());
        assert_eq!(first.certificate_fingerprint(), fingerprint(&certificate));
        assert_eq!(first.certificate_fingerprint().len(), 64);
    }

    #[cfg(unix)]
    #[test]
    fn identity_file_is_owner_only_because_it_contains_a_private_key() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().unwrap();
        let store = HostIdentityStore::new(directory.path());
        store.load_or_create().unwrap();

        assert_eq!(
            std::fs::metadata(store.path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn concurrent_first_run_callers_converge_on_one_identity() {
        use std::sync::Arc;

        let directory = tempdir().unwrap();
        let store = Arc::new(HostIdentityStore::new(directory.path()));
        let mut workers = Vec::new();
        for _ in 0..8 {
            let store = Arc::clone(&store);
            workers.push(std::thread::spawn(move || {
                let identity = store.load_or_create().unwrap();
                (
                    identity.host_id().to_string(),
                    identity.certificate_fingerprint().to_string(),
                )
            }));
        }

        let identities: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert!(identities.windows(2).all(|pair| pair[0] == pair[1]));
    }
}
