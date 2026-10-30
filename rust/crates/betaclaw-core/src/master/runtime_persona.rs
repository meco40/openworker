//! Port of `src/server/master/runtimePersona.ts:1-49`.
//!
//! Resolves the persona a Master run executes as, in two modes: while the
//! system-persona rollout is disabled the caller must name one of their own
//! personas, and once it is enabled the request either keeps the named
//! `master` persona or provisions/returns the system one.
//!
//! # `repo.getPersona` becomes a `Result`
//!
//! `getPersonaRepository()` is the process-wide singleton again; the port takes
//! `repo: &PersonaRepository` for the same reason as
//! [`crate::master::system_persona`]. Every repository call can now fail, so the
//! two TypeScript `throw`s are joined by the wrapped repository error rather
//! than being the only outcomes.
//!
//! # `input.userId` is compared untrimmed
//!
//! `runtimePersona.ts:24` compares `persona.userId !== input.userId` with the
//! raw argument, while `ensureMasterPersona` trims it internally
//! (`systemPersona.ts:28`). The port keeps both behaviours: the comparison uses
//! the raw value, the provisioning path trims.

use crate::master::feature_flags::{is_master_system_persona_enabled, MasterEnv};
use crate::master::system_persona::{ensure_master_persona, MasterSystemPersonaError};
use crate::personas::repository::{PersonaRepository, PersonaRepositoryError};
use crate::personas::types::{PersonaProfile, SystemPersonaKey};

/// `MasterRuntimePersonaConfig` from `runtimePersona.ts:5-11`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MasterRuntimePersonaConfig {
    pub persona_id: String,
    pub model_hub_profile_id: String,
    pub preferred_model_id: Option<String>,
    pub system_instruction: Option<String>,
    pub allowed_tool_function_names: Vec<String>,
}

/// `input` of `getMasterRuntimePersonaConfig` — `runtimePersona.ts:13-16`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MasterRuntimePersonaInput {
    pub user_id: String,
    /// `personaId?: string | null` — absent and `null` are the same here.
    pub persona_id: Option<String>,
}

/// The two `throw`s of `runtimePersona.ts:21,25` plus the wrapped errors.
#[derive(Debug, thiserror::Error)]
pub enum MasterRuntimePersonaError {
    #[error("personaId is required while the Master system persona rollout is disabled.")]
    PersonaIdRequired,
    #[error("personaId is invalid for the current user.")]
    PersonaIdInvalidForUser,
    #[error(transparent)]
    SystemPersona(#[from] MasterSystemPersonaError),
    #[error(transparent)]
    Repository(#[from] PersonaRepositoryError),
}

/// `persona.modelHubProfileId || 'p1'` — an absent *and* an empty value both
/// fall back to `p1`.
fn model_hub_profile_id(persona: &PersonaProfile) -> String {
    match persona.model_hub_profile_id.as_deref() {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => "p1".to_string(),
    }
}

fn config_from(
    persona: &PersonaProfile,
    repo: &PersonaRepository,
) -> Result<MasterRuntimePersonaConfig, MasterRuntimePersonaError> {
    Ok(MasterRuntimePersonaConfig {
        persona_id: persona.id.clone(),
        model_hub_profile_id: model_hub_profile_id(persona),
        preferred_model_id: persona.preferred_model_id.clone(),
        system_instruction: repo.persona_system_instruction(&persona.id)?,
        allowed_tool_function_names: persona.allowed_tool_function_names.clone(),
    })
}

/// `getMasterRuntimePersonaConfig` — `runtimePersona.ts:13-49`.
pub fn get_master_runtime_persona_config(
    input: &MasterRuntimePersonaInput,
    repo: &PersonaRepository,
    env: &MasterEnv,
) -> Result<MasterRuntimePersonaConfig, MasterRuntimePersonaError> {
    if !is_master_system_persona_enabled(env) {
        let persona_id = input.persona_id.as_deref().unwrap_or("").trim();
        if persona_id.is_empty() {
            return Err(MasterRuntimePersonaError::PersonaIdRequired);
        }
        let persona = match repo.get_persona(persona_id)? {
            Some(persona) if persona.user_id == input.user_id => persona,
            _ => return Err(MasterRuntimePersonaError::PersonaIdInvalidForUser),
        };
        return config_from(&persona, repo);
    }

    // `input.personaId && repo.getPersona(input.personaId)?.systemPersonaKey === 'master'`
    let requested_master = match input.persona_id.as_deref() {
        Some(persona_id) if !persona_id.is_empty() => repo
            .get_persona(persona_id)?
            .map(|persona| persona.system_persona_key == Some(SystemPersonaKey::Master))
            .unwrap_or(false),
        _ => false,
    };

    let resolved = if requested_master {
        // The lookup above already proved the row is there; `??` in the source
        // is unreachable, so a re-read failure falls back the same way.
        repo.get_persona(input.persona_id.as_deref().unwrap_or(""))?
    } else {
        None
    };
    let persona = match resolved {
        Some(persona) => persona,
        None => ensure_master_persona(Some(&input.user_id), repo)?,
    };

    config_from(&persona, repo)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::personas::types::CreatePersonaInput;
    use crate::personas::workspace::PersonaWorkspace;

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new() -> Self {
            let unique = uuid::Uuid::new_v4().simple().to_string();
            let path =
                std::env::temp_dir().join(format!("betaclaw-master-runtime-persona-{unique}"));
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

    fn env(value: Option<&str>) -> MasterEnv {
        let mut map = MasterEnv::new();
        if let Some(value) = value {
            map.insert(
                "MASTER_SYSTEM_PERSONA_ENABLED".to_string(),
                value.to_string(),
            );
        }
        map
    }

    fn plain_persona(repo: &PersonaRepository, user_id: &str, name: &str) -> PersonaProfile {
        repo.create_persona(&CreatePersonaInput {
            name: name.to_string(),
            emoji: "🤖".to_string(),
            vibe: "plain".to_string(),
            user_id: user_id.to_string(),
            ..CreatePersonaInput::default()
        })
        .expect("create persona")
    }

    fn input(user_id: &str, persona_id: Option<&str>) -> MasterRuntimePersonaInput {
        MasterRuntimePersonaInput {
            user_id: user_id.to_string(),
            persona_id: persona_id.map(|value| value.to_string()),
        }
    }

    #[test]
    fn with_the_rollout_disabled_a_persona_id_is_required() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let error =
            get_master_runtime_persona_config(&input("user-1", None), &repo, &env(Some("false")))
                .unwrap_err();
        assert_eq!(
            error.to_string(),
            "personaId is required while the Master system persona rollout is disabled."
        );

        // A blank string is as absent as `null`.
        let error = get_master_runtime_persona_config(
            &input("user-1", Some("   ")),
            &repo,
            &env(Some("0")),
        )
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "personaId is required while the Master system persona rollout is disabled."
        );
    }

    #[test]
    fn with_the_rollout_disabled_the_persona_must_belong_to_the_user() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let own = plain_persona(&repo, "user-1", "Own");
        let foreign = plain_persona(&repo, "user-2", "Foreign");

        let error = get_master_runtime_persona_config(
            &input("user-2", Some(&own.id)),
            &repo,
            &env(Some("off")),
        )
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "personaId is invalid for the current user."
        );

        // The user id is compared untrimmed, exactly like the source.
        let error = get_master_runtime_persona_config(
            &input(" user-2 ", Some(&foreign.id)),
            &repo,
            &env(Some("off")),
        )
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "personaId is invalid for the current user."
        );
    }

    #[test]
    fn with_the_rollout_disabled_the_config_comes_from_the_named_persona() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let persona = plain_persona(&repo, "user-1", "Own");

        let config = get_master_runtime_persona_config(
            &input("user-1", Some(&persona.id)),
            &repo,
            &env(Some("false")),
        )
        .unwrap();
        assert_eq!(config.persona_id, persona.id);
        // `modelHubProfileId || 'p1'` — the created persona has none.
        assert_eq!(config.model_hub_profile_id, "p1");
        assert_eq!(config.preferred_model_id, None);
        assert_eq!(config.system_instruction, None);
        assert!(config.allowed_tool_function_names.is_empty());
    }

    #[test]
    fn with_the_rollout_enabled_an_absent_persona_id_provisions_the_master_persona() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);

        let config =
            get_master_runtime_persona_config(&input("user-1", None), &repo, &env(None)).unwrap();
        let master = repo
            .get_system_persona("user-1", SystemPersonaKey::Master)
            .unwrap()
            .expect("master persona provisioned");
        assert_eq!(config.persona_id, master.id);
        assert_eq!(config.model_hub_profile_id, "p1");
        assert_eq!(config.allowed_tool_function_names.len(), 9);
        // The three default files are the system instruction.
        assert!(config
            .system_instruction
            .as_deref()
            .is_some_and(|text| text.contains("--- SOUL.md ---")));
    }

    #[test]
    fn with_the_rollout_enabled_a_master_persona_id_is_kept() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let first =
            get_master_runtime_persona_config(&input("user-1", None), &repo, &env(None)).unwrap();

        let config = get_master_runtime_persona_config(
            &input("user-1", Some(&first.persona_id)),
            &repo,
            &env(None),
        )
        .unwrap();
        assert_eq!(config.persona_id, first.persona_id);
        assert_eq!(repo.list_all_personas().unwrap().len(), 1);
    }

    #[test]
    fn with_the_rollout_enabled_a_non_master_persona_id_falls_back_to_master() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let plain = plain_persona(&repo, "user-1", "Plain");

        let config =
            get_master_runtime_persona_config(&input("user-1", Some(&plain.id)), &repo, &env(None))
                .unwrap();
        let master = repo
            .get_system_persona("user-1", SystemPersonaKey::Master)
            .unwrap()
            .expect("master persona provisioned");
        assert_eq!(config.persona_id, master.id);
        assert_ne!(config.persona_id, plain.id);
    }

    #[test]
    fn with_the_rollout_enabled_an_unknown_persona_id_falls_back_to_master() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let config = get_master_runtime_persona_config(
            &input("user-1", Some("does-not-exist")),
            &repo,
            &env(Some("true")),
        )
        .unwrap();
        assert_eq!(
            config.persona_id,
            repo.get_system_persona("user-1", SystemPersonaKey::Master)
                .unwrap()
                .unwrap()
                .id
        );
    }

    #[test]
    fn an_empty_model_hub_profile_id_falls_back_like_an_absent_one() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let persona = repo
            .create_persona(&CreatePersonaInput {
                name: "Empty".to_string(),
                emoji: "🤖".to_string(),
                vibe: "plain".to_string(),
                user_id: "user-1".to_string(),
                model_hub_profile_id: Some(String::new()),
                ..CreatePersonaInput::default()
            })
            .unwrap();

        let config = get_master_runtime_persona_config(
            &input("user-1", Some(&persona.id)),
            &repo,
            &env(Some("false")),
        )
        .unwrap();
        assert_eq!(config.model_hub_profile_id, "p1");
    }
}
