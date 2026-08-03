//! Persistent internal catalog for desktop-known projects and Pi session files.
//!
//! Canonical filesystem locations are deliberately confined to this module's persisted records
//! and resolver methods. The summaries returned to callers expose only opaque identifiers and
//! host-derived display metadata.

use super::{
    protocol::{ProjectSummary, TrustState},
    read_json, restrict_file_permissions, write_json_atomically, RemoteError, RemoteResult,
    CURRENT_REMOTE_STORAGE_VERSION,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

const PROJECT_STORE_FILE: &str = "projects.json";
pub(crate) const MAX_KNOWN_PROJECTS: usize = 100;

/// All in-process catalogue writers reload and mutate beneath this lock. Poisoning cannot leave
/// the privacy boundary permanently unavailable; the next transaction recovers the inner guard.
static PROJECT_CATALOG_TRANSACTION: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnownProjectInput {
    pub(crate) path: String,
    pub(crate) trusted: bool,
    pub(crate) last_opened: u64,
    pub(crate) pinned: Option<bool>,
}

#[derive(Clone, Debug)]
pub(crate) struct SessionSyncInput {
    pub(crate) path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteProjectSummary {
    project_id: String,
    display_name: String,
    trust_state: &'static str,
    is_active: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct InternalProjectBinding {
    pub(crate) id: String,
    pub(crate) path: PathBuf,
    pub(crate) trusted: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectStoreDocument {
    version: u32,
    projects: Vec<ProjectRecord>,
}

impl Default for ProjectStoreDocument {
    fn default() -> Self {
        Self {
            version: CURRENT_REMOTE_STORAGE_VERSION,
            projects: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct FilesystemIdentity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    device: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    inode: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fallback: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRecord {
    id: String,
    path: PathBuf,
    #[serde(default)]
    identity: Option<FilesystemIdentity>,
    trusted: bool,
    last_opened: u64,
    pinned: bool,
    #[serde(default)]
    session_directory: Option<PathBuf>,
    sessions: Vec<SessionRecord>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionRecord {
    id: String,
    path: PathBuf,
    #[serde(default)]
    identity: Option<FilesystemIdentity>,
}

/// Owner-only persistence for the desktop's recently known projects.
pub(crate) struct ProjectCatalog {
    path: PathBuf,
    document: ProjectStoreDocument,
}

impl ProjectCatalog {
    pub(crate) fn load_or_create(directory: impl AsRef<Path>) -> RemoteResult<Self> {
        let path = directory.as_ref().join(PROJECT_STORE_FILE);
        let document = match read_json::<ProjectStoreDocument>(&path) {
            Ok(document) => {
                validate_document(&document)?;
                restrict_file_permissions(&path)?;
                document
            }
            Err(RemoteError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                ProjectStoreDocument::default()
            }
            Err(error) => return Err(error),
        };
        Ok(Self { path, document })
    }

    /// Serializes a complete load-modify-persist transaction across all production writers. The
    /// closure always sees the latest durable document; mutation methods persist before returning.
    pub(crate) fn transaction<T>(
        directory: impl AsRef<Path>,
        operation: impl FnOnce(&mut Self) -> RemoteResult<T>,
    ) -> RemoteResult<T> {
        let _transaction = PROJECT_CATALOG_TRANSACTION
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut catalog = Self::load_or_create(directory)?;
        operation(&mut catalog)
    }

    /// Replaces the catalog with the valid canonical projects currently known by the desktop UI.
    /// Invalid or missing directories are ignored; entries beyond the first 100 valid distinct
    /// directories are ignored. Existing IDs stay associated with their canonical location.
    pub(crate) fn sync_projects(
        &mut self,
        inputs: &[KnownProjectInput],
        active: Option<&Path>,
    ) -> RemoteResult<Vec<RemoteProjectSummary>> {
        let mut accepted = Vec::new();
        let mut seen = HashSet::new();
        for input in inputs {
            if accepted.len() == MAX_KNOWN_PROJECTS {
                break;
            }
            let Some((path, identity)) = canonical_directory_identity(Path::new(&input.path))
            else {
                continue;
            };
            if !seen.insert(path.clone()) {
                continue;
            }
            accepted.push((
                path,
                identity,
                input.trusted,
                input.last_opened,
                input.pinned.unwrap_or(false),
            ));
        }

        let existing = std::mem::take(&mut self.document.projects)
            .into_iter()
            .map(|record| (record.path.clone(), record))
            .collect::<HashMap<_, _>>();
        self.document.projects = accepted
            .into_iter()
            .map(|(path, identity, trusted, last_opened, pinned)| {
                if let Some(mut record) = existing
                    .get(&path)
                    .filter(|record| record.identity.as_ref() == Some(&identity))
                    .cloned()
                {
                    record.trusted = trusted;
                    record.last_opened = last_opened;
                    record.pinned = pinned;
                    record
                } else {
                    ProjectRecord {
                        id: opaque_id("project"),
                        path,
                        identity: Some(identity),
                        trusted,
                        last_opened,
                        pinned,
                        session_directory: None,
                        sessions: Vec::new(),
                    }
                }
            })
            .collect();
        self.persist()?;
        Ok(self.safe_projects(active))
    }

    pub(crate) fn project_bindings(&self) -> Vec<InternalProjectBinding> {
        self.document
            .projects
            .iter()
            .filter_map(|project| self.resolve_project_binding(&project.id))
            .collect()
    }

    /// Resolves a project only while its current filesystem location still canonicalizes to the
    /// exact directory recorded at sync time. This prevents a later symlink or moved-target
    /// replacement from turning an opaque project ID into access to a new location.
    pub(crate) fn resolve_project_binding(
        &self,
        project_id: &str,
    ) -> Option<InternalProjectBinding> {
        let project = self
            .document
            .projects
            .iter()
            .find(|project| project.id == project_id)?;
        Some(InternalProjectBinding {
            id: project.id.clone(),
            path: revalidate_directory(&project.path, project.identity.as_ref()?)?,
            trusted: project.trusted,
        })
    }

    pub(crate) fn resolve_project_path(&self, project_id: &str) -> Option<PathBuf> {
        self.resolve_project_binding(project_id)
            .map(|binding| binding.path)
    }

    pub(crate) fn sync_sessions(
        &mut self,
        project_id: &str,
        session_directory: &Path,
        inputs: &[SessionSyncInput],
    ) -> RemoteResult<()> {
        let canonical_directory = canonical_directory(session_directory);
        let mut accepted = Vec::new();
        if let Some(directory) = canonical_directory.as_ref() {
            let mut seen = HashSet::new();
            for input in inputs {
                let Some((path, identity)) = canonical_file_identity(&input.path) else {
                    continue;
                };
                if !path.starts_with(directory) || !seen.insert(path.clone()) {
                    continue;
                }
                accepted.push((path, identity));
            }
        }

        let Some(project) = self
            .document
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
        else {
            return Err(RemoteError::InvalidConfiguration(
                "unknown project ID".into(),
            ));
        };
        let Some(canonical_directory) = canonical_directory else {
            project.session_directory = None;
            project.sessions.clear();
            self.persist()?;
            return Ok(());
        };
        project.session_directory = Some(canonical_directory);
        let existing = std::mem::take(&mut project.sessions)
            .into_iter()
            .map(|record| (record.path.clone(), record))
            .collect::<HashMap<_, _>>();
        project.sessions = accepted
            .into_iter()
            .map(|(path, identity)| {
                existing
                    .get(&path)
                    .filter(|record| record.identity.as_ref() == Some(&identity))
                    .cloned()
                    .unwrap_or_else(|| SessionRecord {
                        id: opaque_id("session"),
                        path,
                        identity: Some(identity),
                    })
            })
            .collect();
        self.persist()
    }

    /// Merges one already validated active session without scanning or parsing the full catalogue.
    /// Other mappings in the same current session directory are preserved.
    pub(crate) fn merge_active_session(
        &mut self,
        project_id: &str,
        expected_project: &Path,
        session_directory: &Path,
        session_path: &Path,
    ) -> RemoteResult<Option<String>> {
        let Some(binding) = self.resolve_project_binding(project_id) else {
            return Ok(None);
        };
        if !binding.trusted || binding.path != expected_project {
            return Ok(None);
        }
        let Some(directory) = canonical_directory(session_directory) else {
            return Ok(None);
        };
        let Some((path, identity)) = canonical_file_identity(session_path) else {
            return Ok(None);
        };
        if !path.starts_with(&directory) {
            return Ok(None);
        }
        let project = self
            .document
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
            .expect("resolved project remains present");
        if project.session_directory.as_ref() != Some(&directory) {
            project.sessions.clear();
            project.session_directory = Some(directory.clone());
        }
        let session_id = if let Some(existing) = project
            .sessions
            .iter_mut()
            .find(|session| session.path == path)
        {
            if existing.identity.as_ref() != Some(&identity) {
                *existing = SessionRecord {
                    id: opaque_id("session"),
                    path: path.clone(),
                    identity: Some(identity),
                };
            }
            existing.id.clone()
        } else {
            let session = SessionRecord {
                id: opaque_id("session"),
                path: path.clone(),
                identity: Some(identity),
            };
            let id = session.id.clone();
            project.sessions.push(session);
            id
        };
        self.persist()?;
        Ok((self
            .session_id_for_path(project_id, &directory, &path)
            .as_deref()
            == Some(&session_id))
        .then_some(session_id))
    }

    pub(crate) fn clear_sessions(&mut self, project_id: &str) -> RemoteResult<()> {
        let Some(project) = self
            .document
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
        else {
            return Err(RemoteError::InvalidConfiguration(
                "unknown project ID".into(),
            ));
        };
        if project.sessions.is_empty() && project.session_directory.is_none() {
            return Ok(());
        }
        project.session_directory = None;
        project.sessions.clear();
        self.persist()
    }

    /// Resolves a session only when both the current, caller-derived Pi session directory and the
    /// session file still match their synchronized canonical locations. Callers must pass the
    /// session directory freshly derived for this resolved project (for LemonPi, via
    /// `session_directory(project_path)`) rather than an untrusted request value.
    pub(crate) fn resolve_session_path(
        &self,
        project_id: &str,
        session_id: &str,
        current_session_directory: &Path,
    ) -> Option<PathBuf> {
        let project = self
            .document
            .projects
            .iter()
            .find(|project| project.id == project_id)?;
        revalidate_directory(&project.path, project.identity.as_ref()?)?;
        let current_directory =
            self.revalidated_session_directory(project, current_session_directory)?;
        let session = project
            .sessions
            .iter()
            .find(|session| session.id == session_id)?;
        let current_session = revalidated_session_file(session, &current_directory)?;
        Some(current_session)
    }

    /// Joins a freshly discovered canonical session path back to its opaque catalog ID. The path
    /// stays crate-private and every project, directory, and file location is revalidated before
    /// the ID can be returned.
    pub(crate) fn session_id_for_path(
        &self,
        project_id: &str,
        current_session_directory: &Path,
        current_session_path: &Path,
    ) -> Option<String> {
        let project = self
            .document
            .projects
            .iter()
            .find(|project| project.id == project_id)?;
        revalidate_directory(&project.path, project.identity.as_ref()?)?;
        let current_directory =
            self.revalidated_session_directory(project, current_session_directory)?;
        let canonical_path = current_session_path.canonicalize().ok()?;
        let session = project
            .sessions
            .iter()
            .find(|session| session.path == canonical_path)?;
        revalidated_session_file(session, &current_directory)?;
        Some(session.id.clone())
    }

    fn revalidated_session_directory(
        &self,
        project: &ProjectRecord,
        current_session_directory: &Path,
    ) -> Option<PathBuf> {
        let stored_directory = project.session_directory.as_deref()?;
        let current_directory = canonical_directory(current_session_directory)?;
        (current_directory == stored_directory).then_some(current_directory)
    }

    /// Resolves one revalidated project to the frozen protocol projection without exposing its
    /// internal binding or filesystem path.
    pub(crate) fn safe_project(
        &self,
        project_id: &str,
        active: Option<&Path>,
    ) -> Option<ProjectSummary> {
        let binding = self.resolve_project_binding(project_id)?;
        Some(ProjectSummary {
            project_id: binding.id,
            display_name: project_display_name(&binding.path),
            trust_state: if binding.trusted {
                TrustState::Trusted
            } else {
                TrustState::Untrusted
            },
            is_active: active.is_some_and(|path| path == binding.path),
        })
    }

    /// Safe wire-ready summaries; no filesystem locations are exposed.
    pub(crate) fn safe_projects(&self, active: Option<&Path>) -> Vec<RemoteProjectSummary> {
        self.document
            .projects
            .iter()
            .filter_map(|project| {
                let binding = self.resolve_project_binding(&project.id)?;
                Some(RemoteProjectSummary {
                    project_id: binding.id,
                    display_name: project_display_name(&binding.path),
                    trust_state: if binding.trusted {
                        "trusted"
                    } else {
                        "untrusted"
                    },
                    is_active: active.is_some_and(|path| path == binding.path),
                })
            })
            .collect()
    }

    fn persist(&self) -> RemoteResult<()> {
        write_json_atomically(&self.path, &self.document)
    }

    #[cfg(test)]
    fn path(&self) -> &Path {
        &self.path
    }
}

fn opaque_id(prefix: &str) -> String {
    format!("{prefix}_{}", Uuid::new_v4())
}

fn valid_opaque_id(value: &str, prefix: &str) -> bool {
    value
        .strip_prefix(&format!("{prefix}_"))
        .and_then(|uuid| Uuid::parse_str(uuid).ok())
        .is_some()
}

fn project_display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Project")
        .to_string()
}

fn canonical_directory(path: &Path) -> Option<PathBuf> {
    canonical_directory_identity(path).map(|(path, _)| path)
}

fn canonical_directory_identity(path: &Path) -> Option<(PathBuf, FilesystemIdentity)> {
    let link_metadata = fs::symlink_metadata(path).ok()?;
    if link_metadata.file_type().is_symlink() || !link_metadata.is_dir() {
        return None;
    }
    let canonical = path.canonicalize().ok()?;
    let metadata = fs::symlink_metadata(&canonical).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return None;
    }
    Some((canonical, filesystem_identity(&metadata)?))
}

fn canonical_file_identity(path: &Path) -> Option<(PathBuf, FilesystemIdentity)> {
    let link_metadata = fs::symlink_metadata(path).ok()?;
    if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
        return None;
    }
    let canonical = path.canonicalize().ok()?;
    let metadata = fs::symlink_metadata(&canonical).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return None;
    }
    Some((canonical, filesystem_identity(&metadata)?))
}

#[cfg(unix)]
fn filesystem_identity(metadata: &fs::Metadata) -> Option<FilesystemIdentity> {
    use std::os::unix::fs::MetadataExt;
    Some(FilesystemIdentity {
        device: Some(metadata.dev()),
        inode: Some(metadata.ino()),
        fallback: None,
    })
}

#[cfg(not(unix))]
fn filesystem_identity(metadata: &fs::Metadata) -> Option<FilesystemIdentity> {
    // Best-effort fallback: unlike Unix device/inode this cannot prove identity across every
    // replacement. Remote resolution still fails closed when any sampled property changes.
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    let created = metadata
        .created()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some(FilesystemIdentity {
        device: None,
        inode: None,
        fallback: Some(format!(
            "{}:{}:{}:{}:{}",
            metadata.len(),
            modified.as_secs(),
            modified.subsec_nanos(),
            created.as_secs(),
            created.subsec_nanos()
        )),
    })
}

/// Canonicalize at resolution time and require both the synchronized path and stable identity.
fn revalidate_directory(
    stored_directory: &Path,
    stored_identity: &FilesystemIdentity,
) -> Option<PathBuf> {
    let (current_directory, identity) = canonical_directory_identity(stored_directory)?;
    (current_directory == stored_directory && &identity == stored_identity)
        .then_some(current_directory)
}

fn revalidated_session_file(session: &SessionRecord, current_directory: &Path) -> Option<PathBuf> {
    let (current_session, identity) = canonical_file_identity(&session.path)?;
    (current_session.starts_with(current_directory) && session.identity.as_ref() == Some(&identity))
        .then_some(current_session)
}

fn validate_document(document: &ProjectStoreDocument) -> RemoteResult<()> {
    if document.version != CURRENT_REMOTE_STORAGE_VERSION {
        return Err(RemoteError::InvalidConfiguration(
            "unsupported project store version".into(),
        ));
    }
    if document.projects.len() > MAX_KNOWN_PROJECTS {
        return Err(RemoteError::InvalidConfiguration(
            "project store exceeds its project limit".into(),
        ));
    }
    let mut projects = HashSet::new();
    for project in &document.projects {
        if !valid_opaque_id(&project.id, "project") || !projects.insert(&project.path) {
            return Err(RemoteError::InvalidConfiguration(
                "project record is invalid".into(),
            ));
        }
        let mut sessions = HashSet::new();
        for session in &project.sessions {
            if !valid_opaque_id(&session.id, "session") || !sessions.insert(&session.path) {
                return Err(RemoteError::InvalidConfiguration(
                    "session record is invalid".into(),
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn input(path: &Path, trusted: bool) -> KnownProjectInput {
        KnownProjectInput {
            path: path.to_string_lossy().into_owned(),
            trusted,
            last_opened: 10,
            pinned: Some(false),
        }
    }

    #[test]
    fn projects_keep_stable_opaque_ids_across_sync_and_reload() {
        let root = tempdir().unwrap();
        let storage = tempdir().unwrap();
        let project = root.path().join("LemonPi");
        fs::create_dir(&project).unwrap();
        let mut catalog = ProjectCatalog::load_or_create(storage.path()).unwrap();
        let first = catalog
            .sync_projects(&[input(&project, true)], None)
            .unwrap();
        let first_id = serde_json::to_value(&first[0]).unwrap()["projectId"]
            .as_str()
            .unwrap()
            .to_string();
        let mut reloaded = ProjectCatalog::load_or_create(storage.path()).unwrap();
        let second = reloaded
            .sync_projects(&[input(&project, false)], None)
            .unwrap();
        assert_eq!(
            serde_json::to_value(&second[0]).unwrap()["projectId"],
            first_id
        );
        assert_eq!(
            serde_json::to_value(&second[0]).unwrap()["trustState"],
            "untrusted"
        );
        assert!(first_id.starts_with("project_"));
    }

    #[test]
    fn project_sync_canonicalizes_deduplicates_and_forgets_removed_projects() {
        let root = tempdir().unwrap();
        let storage = tempdir().unwrap();
        let project = root.path().join("project");
        let other = root.path().join("other");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&other).unwrap();
        let mut catalog = ProjectCatalog::load_or_create(storage.path()).unwrap();
        let canonical_project = project.canonicalize().unwrap();
        let summaries = catalog
            .sync_projects(
                &[
                    input(&project, true),
                    input(&project.join("."), true),
                    input(&root.path().join("missing"), true),
                ],
                Some(&canonical_project),
            )
            .unwrap();
        assert_eq!(summaries.len(), 1);
        assert!(serde_json::to_value(&summaries[0]).unwrap()["isActive"]
            .as_bool()
            .unwrap());
        let id = serde_json::to_value(&summaries[0]).unwrap()["projectId"]
            .as_str()
            .unwrap()
            .to_string();
        catalog
            .sync_projects(&[input(&other, false)], None)
            .unwrap();
        assert!(catalog.resolve_project_path(&id).is_none());
    }

    #[test]
    fn project_sync_has_a_hard_one_hundred_project_limit_and_safe_serialization() {
        let root = tempdir().unwrap();
        let storage = tempdir().unwrap();
        let mut inputs = Vec::new();
        for index in 0..101 {
            let path = root.path().join(format!("project-{index}"));
            fs::create_dir(&path).unwrap();
            inputs.push(input(&path, true));
        }
        let mut catalog = ProjectCatalog::load_or_create(storage.path()).unwrap();
        let summaries = catalog.sync_projects(&inputs, None).unwrap();
        assert_eq!(summaries.len(), MAX_KNOWN_PROJECTS);
        let serialized = serde_json::to_string(&summaries).unwrap();
        assert!(!serialized.contains(&root.path().to_string_lossy().to_string()));
        assert!(!serialized.contains("path"));
    }

    #[test]
    fn session_mapping_is_stable_and_removes_stale_paths() {
        let root = tempdir().unwrap();
        let storage = tempdir().unwrap();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let sessions = root.path().join("sessions");
        fs::create_dir(&sessions).unwrap();
        let session = sessions.join("one.jsonl");
        fs::write(&session, "{}\n").unwrap();
        let mut catalog = ProjectCatalog::load_or_create(storage.path()).unwrap();
        let project_id = serde_json::to_value(
            &catalog
                .sync_projects(&[input(&project, true)], None)
                .unwrap()[0],
        )
        .unwrap()["projectId"]
            .as_str()
            .unwrap()
            .to_string();
        catalog
            .sync_sessions(
                &project_id,
                &sessions,
                &[SessionSyncInput {
                    path: session.clone(),
                }],
            )
            .unwrap();
        let session_id = catalog.document.projects[0].sessions[0].id.clone();
        assert_eq!(
            catalog.resolve_session_path(&project_id, &session_id, &sessions),
            Some(session.canonicalize().unwrap())
        );
        catalog.sync_sessions(&project_id, &sessions, &[]).unwrap();
        assert!(catalog
            .resolve_session_path(&project_id, &session_id, &sessions)
            .is_none());
    }

    #[test]
    fn catalogue_transactions_do_not_restore_revoked_trust_after_a_stale_scan() {
        use std::sync::{Arc, Barrier};

        let root = tempdir().unwrap();
        let storage = tempdir().unwrap();
        let project = root.path().join("project");
        let sessions = root.path().join("sessions");
        let session = sessions.join("one.jsonl");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&sessions).unwrap();
        fs::write(&session, "{}\n").unwrap();
        let project_id = ProjectCatalog::transaction(storage.path(), |catalog| {
            let summaries = catalog.sync_projects(&[input(&project, true)], None)?;
            Ok(serde_json::to_value(&summaries[0]).unwrap()["projectId"]
                .as_str()
                .unwrap()
                .to_string())
        })
        .unwrap();
        ProjectCatalog::transaction(storage.path(), |catalog| {
            catalog.sync_sessions(
                &project_id,
                &sessions,
                &[SessionSyncInput {
                    path: session.clone(),
                }],
            )
        })
        .unwrap();

        let barrier = Arc::new(Barrier::new(2));
        let remote_barrier = Arc::clone(&barrier);
        let remote_storage = storage.path().to_path_buf();
        let remote_project_id = project_id.clone();
        let remote_sessions = sessions.clone();
        let remote_session = session.clone();
        let remote = std::thread::spawn(move || {
            // This is the intentionally stale catalogue observation made before an expensive
            // discovery scan. The merge itself must reload beneath `transaction`.
            let stale = ProjectCatalog::load_or_create(&remote_storage).unwrap();
            assert!(
                stale
                    .resolve_project_binding(&remote_project_id)
                    .unwrap()
                    .trusted
            );
            remote_barrier.wait();
            remote_barrier.wait();
            ProjectCatalog::transaction(&remote_storage, |catalog| {
                let binding = catalog.resolve_project_binding(&remote_project_id).unwrap();
                if !binding.trusted {
                    catalog.clear_sessions(&remote_project_id)?;
                    return Ok(false);
                }
                catalog.sync_sessions(
                    &remote_project_id,
                    &remote_sessions,
                    &[SessionSyncInput {
                        path: remote_session.clone(),
                    }],
                )?;
                Ok(true)
            })
            .unwrap()
        });
        barrier.wait();
        ProjectCatalog::transaction(storage.path(), |catalog| {
            catalog.sync_projects(&[input(&project, false)], None)?;
            catalog.clear_sessions(&project_id)
        })
        .unwrap();
        barrier.wait();
        assert!(!remote.join().unwrap());

        let catalog = ProjectCatalog::load_or_create(storage.path()).unwrap();
        assert!(
            !catalog
                .resolve_project_binding(&project_id)
                .expect("trusted project remains mapped")
                .trusted
        );
        assert!(catalog
            .resolve_session_path(&project_id, "session_stale", &sessions)
            .is_none());
    }

    #[test]
    fn concurrent_initial_session_merges_issue_one_stable_opaque_id() {
        use std::sync::{Arc, Barrier};

        let root = tempdir().unwrap();
        let storage = tempdir().unwrap();
        let project = root.path().join("project");
        let sessions = root.path().join("sessions");
        let session = sessions.join("one.jsonl");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&sessions).unwrap();
        fs::write(&session, "{}\n").unwrap();
        let project_id = ProjectCatalog::transaction(storage.path(), |catalog| {
            let summaries = catalog.sync_projects(&[input(&project, true)], None)?;
            Ok(serde_json::to_value(&summaries[0]).unwrap()["projectId"]
                .as_str()
                .unwrap()
                .to_string())
        })
        .unwrap();

        let barrier = Arc::new(Barrier::new(2));
        let merge = |barrier: Arc<Barrier>| {
            let storage = storage.path().to_path_buf();
            let project_id = project_id.clone();
            let sessions = sessions.clone();
            let session = session.clone();
            std::thread::spawn(move || {
                barrier.wait();
                ProjectCatalog::transaction(&storage, |catalog| {
                    catalog.sync_sessions(
                        &project_id,
                        &sessions,
                        &[SessionSyncInput {
                            path: session.clone(),
                        }],
                    )?;
                    catalog
                        .session_id_for_path(&project_id, &sessions, &session)
                        .ok_or_else(|| {
                            RemoteError::InvalidConfiguration("session was not merged".into())
                        })
                })
                .unwrap()
            })
        };
        let first = merge(Arc::clone(&barrier));
        let second = merge(barrier);
        let first_id = first.join().unwrap();
        let second_id = second.join().unwrap();
        assert_eq!(first_id, second_id);
        assert!(first_id.starts_with("session_"));
    }

    #[cfg(unix)]
    #[test]
    fn ordinary_same_path_replacements_revoke_old_ids_and_trust_bindings() {
        let root = tempdir().unwrap();
        let storage = tempdir().unwrap();
        let project = root.path().join("project");
        let sessions = root.path().join("sessions");
        let session = sessions.join("one.jsonl");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&sessions).unwrap();
        fs::write(&session, "original\n").unwrap();
        let mut catalog = ProjectCatalog::load_or_create(storage.path()).unwrap();
        let first_project_id = serde_json::to_value(
            &catalog
                .sync_projects(&[input(&project, true)], None)
                .unwrap()[0],
        )
        .unwrap()["projectId"]
            .as_str()
            .unwrap()
            .to_string();
        catalog
            .sync_sessions(
                &first_project_id,
                &sessions,
                &[SessionSyncInput {
                    path: session.clone(),
                }],
            )
            .unwrap();
        let first_session_id = catalog
            .session_id_for_path(&first_project_id, &sessions, &session)
            .unwrap();

        let moved_session = root.path().join("moved-session.jsonl");
        fs::rename(&session, &moved_session).unwrap();
        fs::write(&session, "replacement\n").unwrap();
        assert!(catalog
            .resolve_session_path(&first_project_id, &first_session_id, &sessions)
            .is_none());
        catalog
            .sync_sessions(
                &first_project_id,
                &sessions,
                &[SessionSyncInput {
                    path: session.clone(),
                }],
            )
            .unwrap();
        assert_ne!(
            catalog
                .session_id_for_path(&first_project_id, &sessions, &session)
                .unwrap(),
            first_session_id
        );

        let moved_project = root.path().join("moved-project");
        fs::rename(&project, &moved_project).unwrap();
        fs::create_dir(&project).unwrap();
        assert!(catalog.resolve_project_binding(&first_project_id).is_none());
        let replacement_project_id = serde_json::to_value(
            &catalog
                .sync_projects(&[input(&project, true)], None)
                .unwrap()[0],
        )
        .unwrap()["projectId"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(replacement_project_id, first_project_id);
    }

    #[cfg(unix)]
    #[test]
    fn resolution_revalidates_post_sync_project_and_session_replacements() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let storage = tempdir().unwrap();
        let project = root.path().join("project");
        let sessions = root.path().join("sessions");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&sessions).unwrap();
        let session = sessions.join("one.jsonl");
        fs::write(&session, "{}\\n").unwrap();

        let mut catalog = ProjectCatalog::load_or_create(storage.path()).unwrap();
        let project_id = serde_json::to_value(
            &catalog
                .sync_projects(&[input(&project, true)], None)
                .unwrap()[0],
        )
        .unwrap()["projectId"]
            .as_str()
            .unwrap()
            .to_string();
        catalog
            .sync_sessions(
                &project_id,
                &sessions,
                &[SessionSyncInput {
                    path: session.clone(),
                }],
            )
            .unwrap();
        let session_id = catalog.document.projects[0].sessions[0].id.clone();
        assert_eq!(
            catalog.resolve_project_path(&project_id),
            Some(project.canonicalize().unwrap())
        );
        assert_eq!(
            catalog.resolve_session_path(&project_id, &session_id, &sessions),
            Some(session.canonicalize().unwrap())
        );

        let moved_session = root.path().join("moved-session.jsonl");
        fs::rename(&session, &moved_session).unwrap();
        symlink(&moved_session, &session).unwrap();
        assert!(catalog
            .resolve_session_path(&project_id, &session_id, &sessions)
            .is_none());

        let moved_project = root.path().join("moved-project");
        fs::rename(&project, &moved_project).unwrap();
        symlink(&moved_project, &project).unwrap();
        assert!(catalog.resolve_project_path(&project_id).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn session_mapping_rejects_symlink_escapes_and_store_is_owner_only() {
        use std::os::unix::{fs::symlink, fs::PermissionsExt};
        let root = tempdir().unwrap();
        let storage = tempdir().unwrap();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let sessions = root.path().join("sessions");
        fs::create_dir(&sessions).unwrap();
        let outside = root.path().join("outside.jsonl");
        fs::write(&outside, "{}\n").unwrap();
        let escape = sessions.join("escape.jsonl");
        symlink(&outside, &escape).unwrap();
        let mut catalog = ProjectCatalog::load_or_create(storage.path()).unwrap();
        let project_id = serde_json::to_value(
            &catalog
                .sync_projects(&[input(&project, true)], None)
                .unwrap()[0],
        )
        .unwrap()["projectId"]
            .as_str()
            .unwrap()
            .to_string();
        catalog
            .sync_sessions(&project_id, &sessions, &[SessionSyncInput { path: escape }])
            .unwrap();
        assert!(catalog.document.projects[0].sessions.is_empty());
        assert_eq!(
            fs::metadata(catalog.path()).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
