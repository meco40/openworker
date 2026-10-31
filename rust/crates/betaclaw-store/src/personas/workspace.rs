//! Port of `src/server/personas/personaWorkspace.ts`.
//!
//! A persona owns a directory below `.local/personas/<slug>` that holds the six
//! markdown files plus a fixed set of working directories. Every path is
//! resolved through [`PersonaWorkspace::resolve`], which reproduces the
//! `isPathWithinRoot` boundary check from
//! `src/server/security/pathBoundary.ts` — a raw prefix check would accept
//! `/personas-evil` as a child of `/personas`.
//!
//! The TypeScript module reads `PERSONAS_ROOT_PATH` at call time. The Rust port
//! binds the root once into a [`PersonaWorkspace`] value so repositories and
//! tests never mutate process-wide environment state.

use std::path::{Path, PathBuf};

use super::types::PersonaFileName;
use crate::gateway_config::paths::{is_path_within_root, personas_root_dir};

/// `WORKSPACE_SUBDIRECTORIES` from `personaWorkspace.ts:7-18`.
pub const WORKSPACE_SUBDIRECTORIES: &[&str] = &[
    "uploads",
    "uploads/images",
    "uploads/docs",
    "projects",
    "knowledge",
    "memory",
    "logs",
    "exports",
    "tmp",
    "config",
];

/// `slugifyPersonaName` from `personaWorkspace.ts:28-36`.
///
/// Lower-cases, collapses every run of non-`[a-z0-9]` into a single `_`, then
/// trims leading and trailing `_`. An empty result falls back to `persona`.
pub fn slugify_persona_name(name: &str) -> String {
    let mut normalized = String::with_capacity(name.len());
    for character in name.trim().to_lowercase().chars() {
        let is_slug_char = character.is_ascii_lowercase() || character.is_ascii_digit();
        if !is_slug_char && !normalized.ends_with('_') {
            normalized.push('_');
        } else if is_slug_char {
            normalized.push(character);
        }
    }
    let trimmed = normalized.trim_matches('_');
    if trimmed.is_empty() {
        "persona".to_string()
    } else {
        trimmed.to_string()
    }
}

/// `slugifyProjectName` from `personaProjectWorkspace.ts:26-34`. Identical to
/// [`slugify_persona_name`] except for the `task` fallback.
pub fn slugify_project_name(name: &str) -> String {
    let slug = slugify_persona_name(name);
    if slug == "persona" && !name.trim().is_empty() {
        slug
    } else if name.trim().is_empty() {
        "task".to_string()
    } else {
        slug
    }
}

/// A persona workspace root, resolved once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonaWorkspace {
    root: PathBuf,
}

impl PersonaWorkspace {
    /// `resolvePersonasRootDir` from `personaWorkspace.ts:161-167`.
    pub fn from_env() -> Self {
        Self::new(personas_root_dir())
    }

    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// `getPersonasRootDir` from `personaWorkspace.ts:20-22`.
    pub fn root_dir(&self) -> &Path {
        &self.root
    }

    /// `getMigrationMarkerPath` from `personaWorkspace.ts:24-26`.
    pub fn migration_marker_path(&self) -> PathBuf {
        self.root.join(".migration-v1.done")
    }

    /// `resolvePersonaPath` from `personaWorkspace.ts:151-159`.
    ///
    /// Creates the personas root first, exactly like the TypeScript helper does
    /// on every call, then rejects any segment combination that escapes it.
    pub fn resolve(&self, segments: &[&str]) -> Result<PathBuf, PersonaWorkspaceError> {
        std::fs::create_dir_all(&self.root).map_err(|source| PersonaWorkspaceError::Io {
            path: self.root.clone(),
            source,
        })?;

        let mut resolved = self.root.clone();
        for segment in segments {
            resolved.push(segment);
        }

        let root_text = path_text(&self.root);
        let resolved_text = path_text(&resolved);
        if !is_path_within_root(&resolved_text, &root_text) {
            return Err(PersonaWorkspaceError::OutsideRoot {
                path: resolved_text,
            });
        }
        Ok(resolved)
    }

    /// `getPersonaWorkspaceDir` from `personaWorkspace.ts:38-40`.
    pub fn persona_dir(&self, slug: &str) -> Result<PathBuf, PersonaWorkspaceError> {
        self.resolve(&[slug])
    }

    /// `getPersonaUploadsDir` from `personaWorkspace.ts:42-44`.
    pub fn uploads_dir(&self, slug: &str) -> Result<PathBuf, PersonaWorkspaceError> {
        self.resolve(&[slug, "uploads"])
    }

    /// `getPersonaFilePath` from `personaWorkspace.ts:52-54`.
    pub fn file_path(
        &self,
        slug: &str,
        filename: PersonaFileName,
    ) -> Result<PathBuf, PersonaWorkspaceError> {
        self.resolve(&[slug, filename.as_str()])
    }

    /// `ensurePersonaWorkspace` from `personaWorkspace.ts:46-50`.
    pub fn ensure_workspace(&self, slug: &str) -> Result<(), PersonaWorkspaceError> {
        for subdir in WORKSPACE_SUBDIRECTORIES {
            let dir = self.resolve(&[slug, subdir])?;
            std::fs::create_dir_all(&dir).map_err(|source| PersonaWorkspaceError::Io {
                path: dir.clone(),
                source,
            })?;
        }
        Ok(())
    }

    /// `readPersonaFile` from `personaWorkspace.ts:56-62`.
    pub fn read_file(
        &self,
        slug: &str,
        filename: PersonaFileName,
    ) -> Result<Option<String>, PersonaWorkspaceError> {
        let path = self.file_path(slug, filename)?;
        match std::fs::read_to_string(&path) {
            Ok(content) => Ok(Some(content)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(PersonaWorkspaceError::Io { path, source }),
        }
    }

    /// `writePersonaFile` from `personaWorkspace.ts:64-67`.
    pub fn write_file(
        &self,
        slug: &str,
        filename: PersonaFileName,
        content: &str,
    ) -> Result<(), PersonaWorkspaceError> {
        self.ensure_workspace(slug)?;
        let path = self.file_path(slug, filename)?;
        std::fs::write(&path, content.as_bytes())
            .map_err(|source| PersonaWorkspaceError::Io { path, source })
    }

    /// `ensurePersonaFiles` from `personaWorkspace.ts:69-81`.
    ///
    /// Existing files are never overwritten; missing ones are created from
    /// `files` or as empty strings.
    pub fn ensure_files(
        &self,
        slug: &str,
        files: Option<&[(String, String)]>,
    ) -> Result<(), PersonaWorkspaceError> {
        self.ensure_workspace(slug)?;
        for filename in super::types::PERSONA_FILE_NAMES {
            let path = self.file_path(slug, *filename)?;
            if path.exists() {
                continue;
            }
            let initial = files
                .and_then(|entries| entries.iter().find(|(name, _)| name == filename.as_str()))
                .map(|(_, content)| content.as_str())
                .unwrap_or_default();
            std::fs::write(&path, initial.as_bytes())
                .map_err(|source| PersonaWorkspaceError::Io { path, source })?;
        }
        Ok(())
    }

    /// `removePersonaWorkspace` from `personaWorkspace.ts:83-85`.
    pub fn remove_workspace(&self, slug: &str) -> Result<(), PersonaWorkspaceError> {
        let dir = self.persona_dir(slug)?;
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(PersonaWorkspaceError::Io { path: dir, source }),
        }
    }

    /// `renamePersonaWorkspace` from `personaWorkspace.ts:87-103`.
    pub fn rename_workspace(
        &self,
        old_slug: &str,
        new_slug: &str,
    ) -> Result<(), PersonaWorkspaceError> {
        let from = self.persona_dir(old_slug)?;
        let to = self.persona_dir(new_slug)?;
        if from == to {
            return Ok(());
        }

        if !from.exists() {
            return self.ensure_workspace(new_slug);
        }
        if to.exists() {
            return Err(PersonaWorkspaceError::WorkspaceExists {
                slug: new_slug.to_string(),
            });
        }

        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|source| PersonaWorkspaceError::Io {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        std::fs::rename(&from, &to).map_err(|source| PersonaWorkspaceError::Io {
            path: to.clone(),
            source,
        })?;
        self.ensure_workspace(new_slug)
    }
}

/// `resolvePersonaAttachmentBucketByMime` from `personaWorkspace.ts:105-110`.
pub fn resolve_attachment_bucket_by_mime(mime_type: &str) -> &'static str {
    let trimmed = mime_type.trim().to_ascii_lowercase();
    if trimmed.starts_with("image/") {
        "images"
    } else {
        "docs"
    }
}

/// `toBase64Url` from `personaWorkspace.ts:169-173`.
fn to_base64_url(value: &str) -> String {
    let normalized = value.trim();
    if normalized.is_empty() {
        return "default".to_string();
    }
    base64_url_encode(normalized.as_bytes())
}

/// `createPersonaAttachmentStoragePath` from `personaWorkspace.ts:114-131`.
///
/// Returns a `personas/...` storage path, not an absolute one; it is turned into
/// an absolute path by [`resolve_persona_scoped_storage_path`].
pub fn create_persona_attachment_storage_path(
    slug: &str,
    conversation_id: &str,
    mime_type: &str,
    safe_file_name: &str,
) -> String {
    let bucket = resolve_attachment_bucket_by_mime(mime_type);
    let conversation_segment = to_base64_url(conversation_id);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let entropy = uuid::Uuid::new_v4().simple().to_string();
    let unique_prefix = format!("{millis}-{}", &entropy[..8]);
    format!(
        "personas/{slug}/uploads/{bucket}/{conversation_segment}/{unique_prefix}-{safe_file_name}"
    )
}

/// `isPersonaScopedStoragePath` from `personaWorkspace.ts:143-145`.
pub fn is_persona_scoped_storage_path(storage_path: &str) -> bool {
    storage_path.replace('\\', "/").starts_with("personas/")
}

/// `resolvePersonaScopedStoragePath` from `personaWorkspace.ts:133-141`.
pub fn resolve_persona_scoped_storage_path(
    workspace: &PersonaWorkspace,
    storage_path: &str,
) -> Result<PathBuf, PersonaWorkspaceError> {
    let normalized = storage_path.replace('\\', "/");
    let Some(relative) = normalized.strip_prefix("personas/") else {
        return Err(PersonaWorkspaceError::NotPersonaScoped);
    };
    let segments: Vec<&str> = relative.split('/').filter(|s| !s.is_empty()).collect();
    workspace.resolve(&segments)
}

/// URL-safe base64 without padding, matching `Buffer.toString('base64url')`.
fn base64_url_encode(input: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(input)
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Failures of [`PersonaWorkspace`] and the free-standing path helpers.
#[derive(Debug, thiserror::Error)]
pub enum PersonaWorkspaceError {
    #[error("file error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("Resolved persona path is outside of persona root: {path}")]
    OutsideRoot { path: String },
    #[error("Target persona workspace already exists for slug \"{slug}\".")]
    WorkspaceExists { slug: String },
    #[error("Persona storage path must start with \"personas/\".")]
    NotPersonaScoped,
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let unique = uuid::Uuid::new_v4().simple().to_string();
            let path = std::env::temp_dir().join(format!("betaclaw-personas-{unique}"));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn workspace(&self) -> PersonaWorkspace {
            PersonaWorkspace::new(self.0.join("personas"))
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn slugify_matches_the_typescript_regex_pipeline() {
        assert_eq!(slugify_persona_name("Ada Lovelace"), "ada_lovelace");
        assert_eq!(
            slugify_persona_name("  Ada  --  Lovelace!! "),
            "ada_lovelace"
        );
        assert_eq!(slugify_persona_name("Agent 007"), "agent_007");
        assert_eq!(
            slugify_persona_name("__leading and trailing__"),
            "leading_and_trailing"
        );
        assert_eq!(slugify_persona_name("---"), "persona", "the empty fallback");
        assert_eq!(slugify_persona_name(""), "persona");
        assert_eq!(
            slugify_persona_name("ÄÖÜ"),
            "persona",
            "non-ascii is dropped"
        );
    }

    #[test]
    fn ensure_workspace_creates_every_subdirectory() {
        let dir = TempDir::new();
        let workspace = dir.workspace();
        workspace.ensure_workspace("ada").expect("create workspace");

        for subdir in WORKSPACE_SUBDIRECTORIES {
            let path = workspace.resolve(&["ada", subdir]).expect("resolve");
            assert!(path.is_dir(), "missing {subdir}");
        }
    }

    #[test]
    fn write_and_read_round_trip() {
        let dir = TempDir::new();
        let workspace = dir.workspace();
        workspace
            .write_file("ada", PersonaFileName::Soul, "I am Ada.")
            .expect("write");

        assert_eq!(
            workspace
                .read_file("ada", PersonaFileName::Soul)
                .expect("read")
                .as_deref(),
            Some("I am Ada.")
        );
        assert_eq!(
            workspace
                .read_file("ada", PersonaFileName::Agents)
                .expect("read"),
            None,
            "absent files report None, not an empty string"
        );
    }

    #[test]
    fn ensure_files_creates_all_six_and_never_overwrites() {
        let dir = TempDir::new();
        let workspace = dir.workspace();
        workspace
            .write_file("ada", PersonaFileName::Soul, "original")
            .expect("seed");

        workspace
            .ensure_files("ada", Some(&[("AGENTS.md".into(), "seeded".into())]))
            .expect("ensure");

        assert_eq!(
            workspace
                .read_file("ada", PersonaFileName::Soul)
                .expect("read")
                .as_deref(),
            Some("original")
        );
        assert_eq!(
            workspace
                .read_file("ada", PersonaFileName::Agents)
                .expect("read")
                .as_deref(),
            Some("seeded")
        );
        assert_eq!(
            workspace
                .read_file("ada", PersonaFileName::Heartbeat)
                .expect("read")
                .as_deref(),
            Some(""),
            "missing seeds become empty files"
        );
    }

    #[test]
    fn rename_moves_the_whole_workspace() {
        let dir = TempDir::new();
        let workspace = dir.workspace();
        workspace
            .write_file("ada", PersonaFileName::Soul, "soul")
            .expect("seed");

        workspace
            .rename_workspace("ada", "ada_lovelace")
            .expect("rename");
        assert_eq!(
            workspace
                .read_file("ada_lovelace", PersonaFileName::Soul)
                .expect("read")
                .as_deref(),
            Some("soul")
        );
        assert!(!workspace.resolve(&["ada"]).expect("resolve").exists());
    }

    #[test]
    fn rename_refuses_to_overwrite_an_existing_workspace() {
        let dir = TempDir::new();
        let workspace = dir.workspace();
        workspace.ensure_workspace("ada").expect("seed a");
        workspace.ensure_workspace("grace").expect("seed b");

        match workspace.rename_workspace("ada", "grace") {
            Err(PersonaWorkspaceError::WorkspaceExists { slug }) => assert_eq!(slug, "grace"),
            other => panic!("expected WorkspaceExists, got {other:?}"),
        }
    }

    #[test]
    fn rename_from_a_missing_source_only_creates_the_target() {
        let dir = TempDir::new();
        let workspace = dir.workspace();
        workspace.rename_workspace("ghost", "ada").expect("rename");
        assert!(workspace.resolve(&["ada"]).expect("resolve").is_dir());
    }

    #[test]
    fn remove_workspace_is_idempotent() {
        let dir = TempDir::new();
        let workspace = dir.workspace();
        workspace.ensure_workspace("ada").expect("seed");
        workspace.remove_workspace("ada").expect("remove");
        workspace
            .remove_workspace("ada")
            .expect("second remove is a no-op");
    }

    #[test]
    fn traversal_out_of_the_root_is_rejected() {
        let dir = TempDir::new();
        let workspace = dir.workspace();
        match workspace.resolve(&["..", "escaped"]) {
            Err(PersonaWorkspaceError::OutsideRoot { .. }) => {}
            other => panic!("expected OutsideRoot, got {other:?}"),
        }
    }

    #[test]
    fn sibling_directories_are_not_treated_as_children() {
        let dir = TempDir::new();
        let workspace = dir.workspace();
        let sibling = dir.0.join("personas-evil");
        std::fs::create_dir_all(&sibling).expect("create sibling");
        assert!(
            !is_path_within_root(&path_text(&sibling), &path_text(workspace.root_dir())),
            "/personas-evil must not pass the /personas boundary"
        );
    }

    #[test]
    fn attachment_buckets_follow_the_mime_prefix() {
        assert_eq!(resolve_attachment_bucket_by_mime("image/png"), "images");
        assert_eq!(resolve_attachment_bucket_by_mime("IMAGE/PNG"), "images");
        assert_eq!(resolve_attachment_bucket_by_mime("application/pdf"), "docs");
        assert_eq!(resolve_attachment_bucket_by_mime(""), "docs");
    }

    #[test]
    fn attachment_storage_paths_are_persona_scoped() {
        let storage =
            create_persona_attachment_storage_path("ada", "conv-1", "image/png", "photo.png");
        assert!(is_persona_scoped_storage_path(&storage));
        assert!(storage.starts_with("personas/ada/uploads/images/"));

        let dir = TempDir::new();
        let workspace = dir.workspace();
        let absolute = resolve_persona_scoped_storage_path(&workspace, &storage).expect("resolve");
        assert!(absolute.starts_with(workspace.root_dir()));
    }

    #[test]
    fn non_scoped_storage_paths_are_rejected() {
        let dir = TempDir::new();
        let workspace = dir.workspace();
        assert!(matches!(
            resolve_persona_scoped_storage_path(&workspace, "uploads/photo.png"),
            Err(PersonaWorkspaceError::NotPersonaScoped)
        ));
    }

    #[test]
    fn project_name_slugify_falls_back_to_task() {
        assert_eq!(slugify_project_name(""), "task");
        assert_eq!(
            slugify_project_name("Refactor the parser"),
            "refactor_the_parser"
        );
    }
}
