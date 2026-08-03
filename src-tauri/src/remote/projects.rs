//! Persistent internal catalog for desktop-known projects and Pi session files.
//!
//! Canonical filesystem locations are deliberately confined to this module's persisted records
//! and resolver methods. The summaries returned to callers expose only opaque identifiers and
//! host-derived display metadata.

use super::{
    read_json, restrict_file_permissions, write_json_atomically, RemoteError, RemoteResult,
    CURRENT_REMOTE_STORAGE_VERSION,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

const PROJECT_STORE_FILE: &str = "projects.json";
pub(crate) const MAX_KNOWN_PROJECTS: usize = 100;

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

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRecord {
    id: String,
    path: PathBuf,
    trusted: bool,
    last_opened: u64,
    pinned: bool,
    sessions: Vec<SessionRecord>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionRecord {
    id: String,
    path: PathBuf,
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
            let Ok(path) = PathBuf::from(&input.path).canonicalize() else {
                continue;
            };
            if !path.is_dir() || !seen.insert(path.clone()) {
                continue;
            }
            accepted.push((
                path,
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
            .map(|(path, trusted, last_opened, pinned)| {
                if let Some(mut record) = existing.get(&path).cloned() {
                    record.trusted = trusted;
                    record.last_opened = last_opened;
                    record.pinned = pinned;
                    record
                } else {
                    ProjectRecord {
                        id: opaque_id("project"),
                        path,
                        trusted,
                        last_opened,
                        pinned,
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
            .map(|project| InternalProjectBinding {
                id: project.id.clone(),
                path: project.path.clone(),
                trusted: project.trusted,
            })
            .collect()
    }

    pub(crate) fn resolve_project_path(&self, project_id: &str) -> Option<PathBuf> {
        self.document
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .map(|project| project.path.clone())
    }

    pub(crate) fn sync_sessions(
        &mut self,
        project_id: &str,
        session_directory: &Path,
        inputs: &[SessionSyncInput],
    ) -> RemoteResult<()> {
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
        let canonical_directory = match session_directory.canonicalize() {
            Ok(directory) if directory.is_dir() => directory,
            _ => {
                project.sessions.clear();
                self.persist()?;
                return Ok(());
            }
        };
        let mut accepted = Vec::new();
        let mut seen = HashSet::new();
        for input in inputs {
            let Ok(path) = input.path.canonicalize() else {
                continue;
            };
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            if !metadata.is_file()
                || !path.starts_with(&canonical_directory)
                || !seen.insert(path.clone())
            {
                continue;
            }
            accepted.push(path);
        }
        let existing = std::mem::take(&mut project.sessions)
            .into_iter()
            .map(|record| (record.path.clone(), record))
            .collect::<HashMap<_, _>>();
        project.sessions = accepted
            .into_iter()
            .map(|path| {
                existing
                    .get(&path)
                    .cloned()
                    .unwrap_or_else(|| SessionRecord {
                        id: opaque_id("session"),
                        path,
                    })
            })
            .collect();
        self.persist()
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
        if project.sessions.is_empty() {
            return Ok(());
        }
        project.sessions.clear();
        self.persist()
    }

    pub(crate) fn resolve_session_path(
        &self,
        project_id: &str,
        session_id: &str,
    ) -> Option<PathBuf> {
        self.document
            .projects
            .iter()
            .find(|project| project.id == project_id)?
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .map(|session| session.path.clone())
    }

    fn safe_projects(&self, active: Option<&Path>) -> Vec<RemoteProjectSummary> {
        self.document
            .projects
            .iter()
            .map(|project| RemoteProjectSummary {
                project_id: project.id.clone(),
                display_name: project_display_name(&project.path),
                trust_state: if project.trusted {
                    "trusted"
                } else {
                    "untrusted"
                },
                is_active: active.is_some_and(|path| path == project.path),
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
            catalog.resolve_session_path(&project_id, &session_id),
            Some(session.canonicalize().unwrap())
        );
        catalog.sync_sessions(&project_id, &sessions, &[]).unwrap();
        assert!(catalog
            .resolve_session_path(&project_id, &session_id)
            .is_none());
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
