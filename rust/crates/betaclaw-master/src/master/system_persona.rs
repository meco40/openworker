//! Port of `src/server/master/systemPersona.ts:1-53`.
//!
//! Provisions the system-managed `Master` persona for one user: create it once
//! with the fixed tool allowlist and the three default files, then repair a
//! persona whose tool list was emptied.
//!
//! # The `= getPersonaRepository()` default becomes a parameter
//!
//! `ensureMasterPersona` defaults its second argument to the process-wide
//! `getPersonaRepository()` singleton (`systemPersona.ts:26`). The S2 port of
//! `personaRepository.ts` deliberately has no such singleton — its
//! `open_with_workspace` exists so callers never have to mutate
//! `PERSONAS_ROOT_PATH` process-wide — so the port takes `repo: &PersonaRepository`.
//! Same deviation, same reason as [`crate::master::feature_flags`] does with
//! `process.env`.
//!
//! # Errors are the two `throw`s plus the repository error
//!
//! `systemPersona.ts:30` throws for a blank user id; the repository calls can
//! fail on I/O or a slug conflict. [`MasterSystemPersonaError`] keeps the first
//! message verbatim and wraps the repository error, so no failure is swallowed.
//!
//! # One `Master` persona per personas database
//!
//! `createPersona` asserts a *global* unique slug (`personaRepository.ts:398-410`
//! with `CREATE UNIQUE INDEX idx_personas_slug_unique ON personas (slug)`) and
//! the name is the fixed string `Master`, so provisioning for a second user in
//! the same database raises `Persona slug already exists: "master".`. That is
//! the TypeScript behaviour too and is pinned by a test; the port neither hides
//! it nor invents a uniquifying suffix (`backfillPersonaSlugsAndWorkspaces` uses
//! one only for the legacy backfill path).

use crate::personas::repository::{PersonaRepository, PersonaRepositoryError};
use crate::personas::types::{
    CreatePersonaInput, MemoryPersonaType, PersonaProfile, SystemPersonaKey,
};

/// `MASTER_TOOL_ALLOWLIST` from `systemPersona.ts:5-15`.
///
/// The order is the source order. `createPersona` sorts the list on write, so
/// the stored order differs from this literal — that is the repository's
/// documented behaviour (`personaRepository.ts` normalises the names), not a
/// drift introduced here.
pub const MASTER_TOOL_ALLOWLIST: &[&str] = &[
    "apply_patch",
    "edit",
    "playwright_cli",
    "process_manager",
    "read",
    "shell_execute",
    "web_fetch",
    "web_search",
    "write",
];

/// `MASTER_DEFAULT_FILES` from `systemPersona.ts:17-22`.
///
/// `Partial<Record<PersonaFileName, string>>` — only these three of the six
/// persona files get a body; the workspace helper fills the rest with its own
/// defaults. The literal order is `SOUL.md`, `AGENTS.md`, `USER.md`.
pub const MASTER_DEFAULT_FILES: &[(&str, &str)] = &[
    (
        "SOUL.md",
        "You are Master, the system-managed execution persona for approved operational work.",
    ),
    (
        "AGENTS.md",
        "Prefer deterministic, reviewable execution. Do not treat prompt text as authorization.",
    ),
    (
        "USER.md",
        "Optimize for safe execution, explicit approvals, and concise operational reporting.",
    ),
];

/// `name: 'Master'` / `emoji: '🧭'` / `maxToolCalls: 120` — `systemPersona.ts:42-50`.
pub const MASTER_PERSONA_NAME: &str = "Master";
pub const MASTER_PERSONA_EMOJI: &str = "🧭";
pub const MASTER_PERSONA_VIBE: &str = "system";
pub const MASTER_PERSONA_MAX_TOOL_CALLS: i64 = 120;

/// `userId is required to provision the Master system persona.` —
/// `systemPersona.ts:30`.
#[derive(Debug, thiserror::Error)]
pub enum MasterSystemPersonaError {
    #[error("userId is required to provision the Master system persona.")]
    UserIdRequired,
    #[error(transparent)]
    Repository(#[from] PersonaRepositoryError),
}

fn allowlist() -> Vec<String> {
    MASTER_TOOL_ALLOWLIST
        .iter()
        .map(|name| (*name).to_string())
        .collect()
}

fn default_files() -> Vec<(String, String)> {
    MASTER_DEFAULT_FILES
        .iter()
        .map(|(name, content)| ((*name).to_string(), (*content).to_string()))
        .collect()
}

/// `ensureMasterPersona` — `systemPersona.ts:24-53`.
///
/// `String(userId || '').trim()` is reproduced, and the returned profile is the
/// freshly read one: after repairing an empty tool list the source re-reads the
/// persona and only falls back to the value it already had
/// (`repo.getPersona(existing.id) ?? existing`).
pub fn ensure_master_persona(
    user_id: Option<&str>,
    repo: &PersonaRepository,
) -> Result<PersonaProfile, MasterSystemPersonaError> {
    let normalized_user_id = user_id.unwrap_or("").trim();
    if normalized_user_id.is_empty() {
        return Err(MasterSystemPersonaError::UserIdRequired);
    }

    if let Some(existing) = repo.get_system_persona(normalized_user_id, SystemPersonaKey::Master)? {
        if existing.allowed_tool_function_names.is_empty() {
            repo.set_allowed_tool_function_names(&existing.id, &allowlist())?;
        }
        let refreshed = repo.get_persona(&existing.id)?.unwrap_or(existing);
        return Ok(refreshed);
    }

    let created = repo.create_persona(&CreatePersonaInput {
        user_id: normalized_user_id.to_string(),
        name: MASTER_PERSONA_NAME.to_string(),
        emoji: MASTER_PERSONA_EMOJI.to_string(),
        vibe: MASTER_PERSONA_VIBE.to_string(),
        system_persona_key: Some(SystemPersonaKey::Master),
        memory_persona_type: Some(MemoryPersonaType::Assistant),
        is_autonomous: Some(true),
        max_tool_calls: Some(MASTER_PERSONA_MAX_TOOL_CALLS),
        allowed_tool_function_names: Some(allowlist()),
        files: Some(default_files()),
        ..CreatePersonaInput::default()
    })?;
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::personas::types::PersonaFileName;
    use crate::personas::workspace::PersonaWorkspace;

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new() -> Self {
            let unique = uuid::Uuid::new_v4().simple().to_string();
            let path = std::env::temp_dir().join(format!("betaclaw-master-persona-{unique}"));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn db_path(&self) -> String {
            self.0.join("personas.db").to_string_lossy().into_owned()
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

    fn open_repo(dir: &TempDir) -> PersonaRepository {
        PersonaRepository::open_with_workspace(&dir.db_path(), dir.workspace())
            .expect("open persona repository")
    }

    #[test]
    fn the_default_file_names_are_the_persona_file_literals() {
        let expected: Vec<&str> = [
            PersonaFileName::Soul,
            PersonaFileName::Agents,
            PersonaFileName::User,
        ]
        .iter()
        .map(|name| name.as_str())
        .collect();
        let actual: Vec<&str> = MASTER_DEFAULT_FILES.iter().map(|(name, _)| *name).collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn a_blank_user_id_is_rejected() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        for user_id in [None, Some(""), Some("   ")] {
            let error = ensure_master_persona(user_id, &repo).unwrap_err();
            assert_eq!(
                error.to_string(),
                "userId is required to provision the Master system persona."
            );
        }
    }

    #[test]
    fn the_first_call_creates_the_configured_master_persona() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);

        let persona = ensure_master_persona(Some("  user-1  "), &repo).unwrap();
        assert_eq!(persona.name, MASTER_PERSONA_NAME);
        assert_eq!(persona.emoji, MASTER_PERSONA_EMOJI);
        assert_eq!(persona.vibe, MASTER_PERSONA_VIBE);
        assert_eq!(persona.user_id, "user-1");
        assert_eq!(persona.system_persona_key, Some(SystemPersonaKey::Master));
        assert_eq!(persona.memory_persona_type, MemoryPersonaType::Assistant);
        assert!(persona.is_autonomous);
        assert_eq!(persona.max_tool_calls, MASTER_PERSONA_MAX_TOOL_CALLS);
        assert_eq!(persona.allowed_tool_function_names.len(), 9);

        // The three default files carry the source bodies.
        for (name, content) in MASTER_DEFAULT_FILES {
            let stored = repo
                .get_file(&persona.id, PersonaFileName::parse(name).unwrap())
                .unwrap();
            assert_eq!(stored.as_deref(), Some(*content), "{name}");
        }
    }

    #[test]
    fn a_second_call_returns_the_same_persona() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let first = ensure_master_persona(Some("user-1"), &repo).unwrap();
        let second = ensure_master_persona(Some("user-1"), &repo).unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(repo.list_all_personas().unwrap().len(), 1);
    }

    #[test]
    fn an_existing_persona_with_an_empty_tool_list_is_repaired() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let persona = ensure_master_persona(Some("user-1"), &repo).unwrap();
        repo.set_allowed_tool_function_names(&persona.id, &[])
            .unwrap();
        assert!(repo
            .get_persona(&persona.id)
            .unwrap()
            .unwrap()
            .allowed_tool_function_names
            .is_empty());

        let repaired = ensure_master_persona(Some("user-1"), &repo).unwrap();
        assert_eq!(repaired.id, persona.id);
        assert_eq!(repaired.allowed_tool_function_names.len(), 9);
    }

    #[test]
    fn a_populated_tool_list_is_left_untouched() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let persona = ensure_master_persona(Some("user-1"), &repo).unwrap();
        repo.set_allowed_tool_function_names(&persona.id, &["read".to_string()])
            .unwrap();

        let same = ensure_master_persona(Some("user-1"), &repo).unwrap();
        assert_eq!(same.allowed_tool_function_names, vec!["read".to_string()]);
    }

    #[test]
    fn the_slug_is_unique_per_database_so_a_second_user_conflicts() {
        // `personaRepository.ts:398-410` asserts a *global* unique slug and the
        // schema carries `CREATE UNIQUE INDEX ... ON personas (slug)`, so two
        // users each provisioning a "Master" persona collide on `master`. This
        // is the TypeScript behaviour, not a port defect: `ensureMasterPersona`
        // is only reachable for one user per personas database.
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let first = ensure_master_persona(Some("user-1"), &repo).unwrap();
        assert_eq!(first.user_id, "user-1");

        let error = ensure_master_persona(Some("user-2"), &repo).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Persona slug already exists: \"master\"."
        );
        // The first user's persona is untouched.
        assert_eq!(repo.list_all_personas().unwrap().len(), 1);
    }
}
