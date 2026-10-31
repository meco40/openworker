//! Port of `src/server/master/workspaceScope.ts:1-110`.
//!
//! Resolves the `MasterWorkspaceBinding` of one Master session: the scope key
//! (`persona:<personaId>:<workspaceId>`), the persona workspace root and the
//! working directory, creating both directories on the way.
//!
//! # The path guard is the security boundary
//!
//! `isWithinRoot` rejects any `workspaceCwd` that escapes the master workspace
//! root, and it runs *before* the directories are created. Only the two mirrors
//! of the source are used — `path.resolve` collapses `.`/`..` lexically, and the
//! comparison is case-insensitive on Windows — so [`resolve_like_node`] and
//! [`is_within_root`] reproduce both. This is the same boundary the S10 dispatch
//! consumes; it must not be weakened.
//!
//! # Global reads become parameters
//!
//! The source reads three process-wide things: `getPersonaRepository()`,
//! `getMasterRepository()` and `process.env`. The port takes the persona
//! repository, the concrete [`SqliteMasterRepository`] (the source calls
//! `migrateUserLegacyScopesToMasterPersona`, which is *not* part of the
//! `MasterRepository` interface) and a [`MasterEnv`]. The persona workspace root
//! comes from `repo.workspace()`, so the binding and the repository always agree
//! on the root.

use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;

use crate::master::feature_flags::{is_master_system_persona_enabled, MasterEnv};
use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;
use crate::master::system_persona::{ensure_master_persona, MasterSystemPersonaError};
use crate::personas::repository::{PersonaRepository, PersonaRepositoryError};
use crate::personas::workspace::PersonaWorkspaceError;

/// `MasterWorkspaceBinding` from `workspaceScope.ts:10-14`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MasterWorkspaceBinding {
    pub user_id: String,
    pub workspace_id: String,
    pub persona_id: String,
    pub persona_workspace_root: String,
    pub workspace_cwd: String,
}

/// `input` of `resolveMasterWorkspaceScope` — `workspaceScope.ts:16-21`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MasterWorkspaceScopeInput {
    pub user_id: String,
    pub persona_id: Option<String>,
    pub workspace_id: Option<String>,
    pub workspace_cwd: Option<String>,
}

/// The five `throw`s of `workspaceScope.ts:27-51` plus the wrapped errors.
#[derive(Debug, thiserror::Error)]
pub enum MasterWorkspaceScopeError {
    #[error("userId is required for master workspace scope.")]
    UserIdRequired,
    #[error("workspaceId is required for master workspace scope.")]
    WorkspaceIdRequired,
    #[error("personaId is required while the Master system persona rollout is disabled.")]
    PersonaIdRequired,
    #[error("personaId is invalid for the current user.")]
    PersonaIdInvalidForUser,
    #[error("workspaceCwd must resolve inside master workspace root.")]
    WorkspaceCwdOutsideRoot,
    #[error(transparent)]
    SystemPersona(#[from] MasterSystemPersonaError),
    #[error(transparent)]
    Repository(#[from] PersonaRepositoryError),
    #[error(transparent)]
    Workspace(#[from] PersonaWorkspaceError),
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// `toSafeWorkspaceSegment` — `workspaceScope.ts:103-110`.
///
/// `[^\w.-]+` is spelled out as an ASCII class: JavaScript's `\w` is
/// `[A-Za-z0-9_]` while Rust's `\w` is Unicode-aware, and the segment is a
/// directory name, so no non-ASCII character may survive.
pub fn to_safe_workspace_segment(value: Option<&str>) -> String {
    static INVALID: OnceLock<Regex> = OnceLock::new();
    static REPEATED: OnceLock<Regex> = OnceLock::new();
    let invalid = INVALID.get_or_init(|| Regex::new(r"[^A-Za-z0-9_.-]+").expect("static regex"));
    let repeated = REPEATED.get_or_init(|| Regex::new(r"_+").expect("static regex"));

    let trimmed = value.unwrap_or("").trim();
    let replaced = invalid.replace_all(trimmed, "_");
    let collapsed = repeated.replace_all(&replaced, "_");
    let stripped = collapsed.trim_matches('_');
    if stripped.is_empty() {
        "main".to_string()
    } else {
        stripped.to_string()
    }
}

/// `path.resolve(value)` for one segment list — lexical `.`/`..` collapsing
/// against the process working directory, exactly like Node's `path.resolve`.
pub fn resolve_like_node(value: &str) -> PathBuf {
    let path = Path::new(value);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !resolved.pop() {
                    resolved.push(component);
                }
            }
            other => resolved.push(other),
        }
    }
    resolved
}

/// `normalizePath` — `workspaceScope.ts:98-101`.
fn normalize_path(value: &Path) -> String {
    let text = value.to_string_lossy().into_owned();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

/// `isWithinRoot` — `workspaceScope.ts:91-96`.
pub fn is_within_root(candidate: &Path, root: &Path) -> bool {
    let candidate = normalize_path(candidate);
    let root = normalize_path(root);
    if candidate == root {
        return true;
    }
    candidate.starts_with(&format!("{}{}", root, std::path::MAIN_SEPARATOR))
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn master_workspace_root(persona_workspace_root: &Path, workspace_id: &str) -> PathBuf {
    persona_workspace_root
        .join("projects")
        .join("workspaces")
        .join(to_safe_workspace_segment(Some(workspace_id)))
}

/// `resolveMasterWorkspaceScope` — `workspaceScope.ts:16-89`.
///
/// The trimmed `userId`/`workspaceId` are the guard *and* the returned fields;
/// `workspaceCwd` defaults to the root, and an explicit one must still resolve
/// inside it or nothing is created.
pub fn resolve_master_workspace_scope(
    input: &MasterWorkspaceScopeInput,
    master_repo: &SqliteMasterRepository,
    repo: &PersonaRepository,
    env: &MasterEnv,
) -> Result<MasterWorkspaceBinding, MasterWorkspaceScopeError> {
    let user_id = input.user_id.trim();
    let workspace_id = input.workspace_id.as_deref().unwrap_or("").trim();
    let requested_cwd = input.workspace_cwd.as_deref().unwrap_or("").trim();

    if user_id.is_empty() {
        return Err(MasterWorkspaceScopeError::UserIdRequired);
    }
    if workspace_id.is_empty() {
        return Err(MasterWorkspaceScopeError::WorkspaceIdRequired);
    }

    if !is_master_system_persona_enabled(env) {
        let persona_id = input.persona_id.as_deref().unwrap_or("").trim();
        if persona_id.is_empty() {
            return Err(MasterWorkspaceScopeError::PersonaIdRequired);
        }
        let legacy_persona = match repo.get_persona(persona_id)? {
            Some(persona) if persona.user_id == user_id => persona,
            _ => return Err(MasterWorkspaceScopeError::PersonaIdInvalidForUser),
        };
        let persona_workspace_root = repo.workspace().persona_dir(&legacy_persona.slug)?;
        let legacy_workspace_root = master_workspace_root(&persona_workspace_root, workspace_id);
        let workspace_cwd = if requested_cwd.is_empty() {
            legacy_workspace_root.clone()
        } else {
            resolve_like_node(requested_cwd)
        };
        if !is_within_root(&workspace_cwd, &legacy_workspace_root) {
            return Err(MasterWorkspaceScopeError::WorkspaceCwdOutsideRoot);
        }
        std::fs::create_dir_all(&legacy_workspace_root)?;
        std::fs::create_dir_all(&workspace_cwd)?;

        return Ok(MasterWorkspaceBinding {
            user_id: user_id.to_string(),
            workspace_id: format!("persona:{}:{}", legacy_persona.id, workspace_id),
            persona_id: legacy_persona.id,
            persona_workspace_root: path_text(&persona_workspace_root),
            workspace_cwd: path_text(&workspace_cwd),
        });
    }

    let master_persona = ensure_master_persona(Some(user_id), repo)?;
    master_repo.migrate_user_legacy_scopes_to_master_persona(user_id, &master_persona.id)?;

    let persona_workspace_root = repo.workspace().persona_dir(&master_persona.slug)?;
    let root = master_workspace_root(&persona_workspace_root, workspace_id);
    let workspace_cwd = if requested_cwd.is_empty() {
        root.clone()
    } else {
        resolve_like_node(requested_cwd)
    };
    if !is_within_root(&workspace_cwd, &root) {
        return Err(MasterWorkspaceScopeError::WorkspaceCwdOutsideRoot);
    }
    std::fs::create_dir_all(&root)?;
    std::fs::create_dir_all(&workspace_cwd)?;

    Ok(MasterWorkspaceBinding {
        user_id: user_id.to_string(),
        workspace_id: format!("persona:{}:{}", master_persona.id, workspace_id),
        persona_id: master_persona.id,
        persona_workspace_root: path_text(&persona_workspace_root),
        workspace_cwd: path_text(&workspace_cwd),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::personas::types::CreatePersonaInput;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let unique = uuid::Uuid::new_v4().simple().to_string();
            let path = std::env::temp_dir().join(format!("betaclaw-master-scope-{unique}"));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn db_path(&self) -> String {
            self.0.join("personas.db").to_string_lossy().into_owned()
        }

        fn workspace(&self) -> crate::personas::workspace::PersonaWorkspace {
            crate::personas::workspace::PersonaWorkspace::new(self.0.join("personas"))
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn open_repo(dir: &TempDir) -> PersonaRepository {
        PersonaRepository::open_with_workspace(&dir.db_path(), dir.workspace())
            .expect("open persona repository")
    }

    fn env(disabled: bool) -> MasterEnv {
        let mut map = MasterEnv::new();
        if disabled {
            map.insert(
                "MASTER_SYSTEM_PERSONA_ENABLED".to_string(),
                "false".to_string(),
            );
        }
        map
    }

    fn input(user_id: &str, workspace_id: &str) -> MasterWorkspaceScopeInput {
        MasterWorkspaceScopeInput {
            user_id: user_id.to_string(),
            workspace_id: Some(workspace_id.to_string()),
            ..MasterWorkspaceScopeInput::default()
        }
    }

    fn plain_persona(repo: &PersonaRepository, user_id: &str, name: &str) -> String {
        repo.create_persona(&CreatePersonaInput {
            name: name.to_string(),
            emoji: "🤖".to_string(),
            vibe: "plain".to_string(),
            user_id: user_id.to_string(),
            ..CreatePersonaInput::default()
        })
        .expect("create persona")
        .id
    }

    #[test]
    fn the_workspace_segment_mirrors_the_javascript_regex() {
        assert_eq!(
            to_safe_workspace_segment(Some("my workspace")),
            "my_workspace"
        );
        assert_eq!(to_safe_workspace_segment(Some("  a__b  ")), "a_b");
        assert_eq!(to_safe_workspace_segment(Some("___x___")), "x");
        assert_eq!(to_safe_workspace_segment(Some("a.b-c_d")), "a.b-c_d");
        // A non-ASCII letter is not `\w` in JavaScript.
        assert_eq!(to_safe_workspace_segment(Some("würzburg")), "w_rzburg");
        for empty in [None, Some(""), Some("   "), Some("///")] {
            assert_eq!(to_safe_workspace_segment(empty), "main");
        }
    }

    #[test]
    fn resolve_like_node_collapses_dot_segments() {
        let base = std::env::current_dir().unwrap();
        assert_eq!(resolve_like_node("a/./b/../c"), base.join("a/c"));
        assert_eq!(resolve_like_node("/absolute/../x"), PathBuf::from("/x"));
    }

    #[test]
    fn is_within_root_accepts_the_root_and_rejects_siblings() {
        let root = std::env::temp_dir().join("betaclaw-scope-root");
        assert!(is_within_root(&root, &root));
        assert!(is_within_root(&root.join("child"), &root));
        assert!(!is_within_root(
            &std::env::temp_dir().join("betaclaw-scope-root2"),
            &root
        ));
        assert!(!is_within_root(&std::env::temp_dir(), &root));
    }

    #[test]
    fn the_user_and_workspace_ids_are_required() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let master = SqliteMasterRepository::open(":memory:").unwrap();
        let env = env(false);

        let error = resolve_master_workspace_scope(
            &MasterWorkspaceScopeInput {
                user_id: "   ".to_string(),
                workspace_id: Some("w1".to_string()),
                ..MasterWorkspaceScopeInput::default()
            },
            &master,
            &repo,
            &env,
        )
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "userId is required for master workspace scope."
        );

        let error = resolve_master_workspace_scope(
            &MasterWorkspaceScopeInput {
                user_id: "u1".to_string(),
                workspace_id: Some("  ".to_string()),
                ..MasterWorkspaceScopeInput::default()
            },
            &master,
            &repo,
            &env,
        )
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "workspaceId is required for master workspace scope."
        );
    }

    #[test]
    fn with_the_rollout_disabled_the_persona_must_be_owned_and_named() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let master = SqliteMasterRepository::open(":memory:").unwrap();
        let disabled = env(true);
        let own = plain_persona(&repo, "u1", "Own");
        let foreign = plain_persona(&repo, "u2", "Foreign");

        let error = resolve_master_workspace_scope(&input("u1", "w1"), &master, &repo, &disabled)
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "personaId is required while the Master system persona rollout is disabled."
        );

        let mut requested = input("u1", "w1");
        requested.persona_id = Some(foreign);
        let error =
            resolve_master_workspace_scope(&requested, &master, &repo, &disabled).unwrap_err();
        assert_eq!(
            error.to_string(),
            "personaId is invalid for the current user."
        );

        let mut requested = input("u1", "w1");
        requested.persona_id = Some(own.clone());
        let binding =
            resolve_master_workspace_scope(&requested, &master, &repo, &disabled).unwrap();
        assert_eq!(binding.user_id, "u1");
        assert_eq!(binding.persona_id, own);
        assert_eq!(
            binding.workspace_id,
            format!("persona:{}:w1", binding.persona_id)
        );
        assert!(Path::new(&binding.workspace_cwd).is_dir());
        assert!(Path::new(&binding.persona_workspace_root).is_dir());
    }

    #[test]
    fn with_the_rollout_disabled_a_cwd_outside_the_root_is_rejected() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let master = SqliteMasterRepository::open(":memory:").unwrap();
        let disabled = env(true);
        let persona_id = plain_persona(&repo, "u1", "Own");

        let mut requested = input("u1", "w1");
        requested.persona_id = Some(persona_id);
        requested.workspace_cwd = Some(dir.0.join("elsewhere").to_string_lossy().into_owned());
        let error =
            resolve_master_workspace_scope(&requested, &master, &repo, &disabled).unwrap_err();
        assert_eq!(
            error.to_string(),
            "workspaceCwd must resolve inside master workspace root."
        );
        // Nothing was created outside the root.
        assert!(!dir.0.join("elsewhere").exists());
    }

    #[test]
    fn with_the_rollout_disabled_an_explicit_cwd_inside_the_root_is_kept() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let master = SqliteMasterRepository::open(":memory:").unwrap();
        let disabled = env(true);
        let persona_id = plain_persona(&repo, "u1", "Own");

        // The slug is derived from the name by the persona repository.
        let slug = repo.get_persona(&persona_id).unwrap().unwrap().slug;
        let inside = dir
            .0
            .join("personas")
            .join(&slug)
            .join("projects")
            .join("workspaces")
            .join("w1")
            .join("sub");

        let mut requested = input("u1", "w1");
        requested.persona_id = Some(persona_id);
        requested.workspace_cwd = Some(inside.to_string_lossy().into_owned());
        let binding =
            resolve_master_workspace_scope(&requested, &master, &repo, &disabled).unwrap();
        assert_eq!(binding.workspace_cwd, inside.to_string_lossy());
        assert!(inside.is_dir());
    }

    #[test]
    fn with_the_rollout_enabled_the_master_persona_is_provisioned_and_scopes_migrate() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let master = SqliteMasterRepository::open(":memory:").unwrap();
        let enabled = env(false);

        // A legacy scope that the migration moves to the master persona:
        // `migrateUserLegacyScopesToMasterPersona` only rewrites ids that are
        // already `persona:<otherPersonaId>:<inner>` (`migration.store.ts`), so a
        // bare `w1` is left alone — see the second assertion below.
        let legacy_workspace = "persona:old-persona:w1";
        master
            .create_run(&crate::master::types::MasterRunCreateInput {
                user_id: "u1".to_string(),
                workspace_id: legacy_workspace.to_string(),
                title: "T".to_string(),
                contract: "C".to_string(),
            })
            .unwrap();
        assert_eq!(master.list_known_scopes(100).unwrap().len(), 1);

        let binding =
            resolve_master_workspace_scope(&input("  u1  ", "w1"), &master, &repo, &enabled)
                .unwrap();
        let master_persona = repo
            .get_system_persona("u1", crate::personas::types::SystemPersonaKey::Master)
            .unwrap()
            .expect("master persona provisioned");
        assert_eq!(binding.persona_id, master_persona.id);
        assert_eq!(
            binding.workspace_id,
            format!("persona:{}:w1", master_persona.id)
        );
        assert_eq!(binding.user_id, "u1");
        assert!(Path::new(&binding.workspace_cwd).is_dir());

        // The legacy scope now points at the master persona.
        let scopes = master.list_known_scopes(100).unwrap();
        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes[0].workspace_id, binding.workspace_id);
    }

    #[test]
    fn the_migration_leaves_a_bare_workspace_id_alone() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let master = SqliteMasterRepository::open(":memory:").unwrap();
        let enabled = env(false);

        master
            .create_run(&crate::master::types::MasterRunCreateInput {
                user_id: "u1".to_string(),
                workspace_id: "w1".to_string(),
                title: "T".to_string(),
                contract: "C".to_string(),
            })
            .unwrap();

        let binding =
            resolve_master_workspace_scope(&input("u1", "w1"), &master, &repo, &enabled).unwrap();

        // `parse_persona_workspace_id` returns `None` for `w1`, so the only scope
        // in the database is still the untouched legacy one.
        let scopes = master.list_known_scopes(100).unwrap();
        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes[0].workspace_id, "w1");
        assert_ne!(scopes[0].workspace_id, binding.workspace_id);
        assert!(binding.workspace_id.ends_with(":w1"));
    }

    #[test]
    fn an_unsafe_workspace_id_becomes_a_safe_directory_name() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let master = SqliteMasterRepository::open(":memory:").unwrap();
        let enabled = env(false);

        let binding = resolve_master_workspace_scope(
            &input("u1", "my workspace/../x"),
            &master,
            &repo,
            &enabled,
        )
        .unwrap();
        // The raw id is what the scope key carries; the directory name is safe.
        assert!(binding.workspace_id.ends_with(":my workspace/../x"));
        assert!(binding.workspace_cwd.ends_with("my_workspace_.._x"));
        assert!(Path::new(&binding.workspace_cwd).is_dir());
    }
}
