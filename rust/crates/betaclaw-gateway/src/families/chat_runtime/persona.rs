//! The persona catalogue: the `PersonaPort`.
//!
//! Wraps `betaclaw_core::personas::repository::PersonaRepository`, which owns the personas
//! database and the workspace folders.

use std::sync::{Mutex, PoisonError};

use betaclaw_core::channels::messages::service::execution::ports::PortResult;
use betaclaw_core::channels::messages::service::ports::{PersonaPort, WorkspacePaths};
use betaclaw_core::gateway_config::paths::is_path_within_root;
use betaclaw_core::knowledge::retrieval::types::{
    PersonaMemoryTypeLookup, RetrievalError, RetrievalResult,
};
use betaclaw_core::personas::repository::{PersonaRepository, PersonaRepositoryError};
use betaclaw_core::personas::types::{MemoryPersonaType, PersonaProfile};
use betaclaw_core::personas::workspace::slugify_project_name;
use betaclaw_core::personas::PersonaWorkspace;

use super::failed;

pub struct PersonaStore {
    repository: Mutex<PersonaRepository>,
}

impl PersonaStore {
    pub fn open(db_path: &str, root: &str) -> Result<Self, PersonaRepositoryError> {
        let repository =
            PersonaRepository::open_with_workspace(db_path, PersonaWorkspace::new(root))?;
        Ok(Self {
            repository: Mutex::new(repository),
        })
    }

    /// Runs `operation` on the repository. Keep it synchronous: the lock is a std mutex.
    pub(crate) fn run<T>(
        &self,
        operation: impl FnOnce(&PersonaRepository) -> Result<T, PersonaRepositoryError>,
    ) -> PortResult<T> {
        let guard = self
            .repository
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        operation(&guard).map_err(failed)
    }

    fn persona(&self, id: &str) -> PortResult<Option<PersonaProfile>> {
        self.run(|repository| repository.get_persona(id))
    }
}

impl PersonaPort for PersonaStore {
    fn list_personas(&self, user_id: &str) -> PortResult<Vec<PersonaProfile>> {
        // The repository lists summaries, the port wants full profiles, so each one is read back.
        // ponytail: one extra query per persona. Batch it if the catalogue grows.
        let summaries = self.run(|repository| repository.list_personas(user_id))?;
        let mut profiles = Vec::with_capacity(summaries.len());
        for summary in summaries {
            if let Some(profile) = self.persona(&summary.id)? {
                profiles.push(profile);
            }
        }
        Ok(profiles)
    }

    fn get_persona(&self, id: &str) -> PortResult<Option<PersonaProfile>> {
        self.persona(id)
    }

    fn create_project_workspace(
        &self,
        persona_slug: &str,
        task: &str,
        requested_name: &str,
    ) -> PortResult<WorkspacePaths> {
        let persona_slug = persona_slug.trim();
        assert_safe_persona_slug(persona_slug)?;
        let workspace = self.run(|repo| Ok(repo.workspace().clone()))?;
        workspace.ensure_workspace(persona_slug).map_err(failed)?;
        let projects_dir = workspace
            .resolve(&[persona_slug, "projects"])
            .map_err(failed)?;
        std::fs::create_dir_all(&projects_dir).map_err(failed)?;

        let project_name = infer_project_name(requested_name, task);
        let slug = slugify_project_name(&project_name);
        let project_slug: String = slug.chars().take(48).collect();
        let project_slug = if project_slug.is_empty() {
            "task".to_string()
        } else {
            project_slug
        };
        let created_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let timestamp = created_at
            .split('.')
            .next()
            .unwrap_or(&created_at)
            .replace(['-', ':'], "")
            .replace('T', "-");
        let entropy = uuid::Uuid::new_v4().simple().to_string();
        let project_id = format!("{timestamp}-{project_slug}-{}", &entropy[..8]);
        let absolute_path = projects_dir.join(&project_id);
        std::fs::create_dir_all(&absolute_path).map_err(failed)?;
        for dir_name in ["app", "docs", "logs", "tmp"] {
            std::fs::create_dir_all(absolute_path.join(dir_name)).map_err(failed)?;
        }
        let task_line = if task.trim().is_empty() {
            "(empty task)"
        } else {
            task.trim()
        };
        let overview = [
            "# Project Workspace",
            "",
            &format!("- Persona: {persona_slug}"),
            &format!("- Project ID: {project_id}"),
            &format!("- Created At: {created_at}"),
            "",
            "## Task",
            task_line,
            "",
            "## Notes",
            "- This folder is auto-created for a delegated task.",
            "- Subagents can use this as their default working directory.",
        ]
        .join("\n");
        std::fs::write(absolute_path.join("PROJECT.md"), overview.as_bytes()).map_err(failed)?;

        Ok(WorkspacePaths {
            absolute_path: absolute_path.to_string_lossy().into_owned(),
            relative_path: format!("personas/{persona_slug}/projects/{project_id}"),
        })
    }

    fn remove_project_workspace(&self, persona_slug: &str, workspace_path: &str) -> PortResult<()> {
        let persona_slug = persona_slug.trim();
        assert_safe_persona_slug(persona_slug)?;
        let target = workspace_path.trim();
        if target.is_empty() {
            return Err(failed("workspacePath is required"));
        }
        let workspace = self.run(|repo| Ok(repo.workspace().clone()))?;
        workspace.ensure_workspace(persona_slug).map_err(failed)?;
        let projects_dir = workspace
            .resolve(&[persona_slug, "projects"])
            .map_err(failed)?;
        std::fs::create_dir_all(&projects_dir).map_err(failed)?;
        let projects_text = projects_dir.to_string_lossy().replace('\\', "/");
        let target_text = target.replace('\\', "/");
        if target_text.trim_end_matches('/') == projects_text.trim_end_matches('/')
            || !is_path_within_root(&target_text, &projects_text)
        {
            return Err(failed(
                "Project workspace path is outside the persona projects directory.",
            ));
        }
        match std::fs::remove_dir_all(target) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(failed(error)),
        }
    }

    fn memory_persona_type(&self, persona_id: &str) -> PortResult<Option<String>> {
        Ok(self
            .persona(persona_id)?
            .map(|persona| persona.memory_persona_type.as_str().to_string()))
    }
}

impl PersonaMemoryTypeLookup for PersonaStore {
    fn get_persona_memory_type(
        &self,
        persona_id: &str,
    ) -> RetrievalResult<Option<MemoryPersonaType>> {
        self.persona(persona_id)
            .map(|persona| persona.map(|persona| persona.memory_persona_type))
            .map_err(|error| RetrievalError::new(error.to_string()))
    }
}

fn assert_safe_persona_slug(value: &str) -> PortResult<()> {
    if value.is_empty() || value.contains('/') || value.contains('\\') {
        return Err(failed("Invalid persona slug for project workspace."));
    }
    Ok(())
}

fn infer_project_name(requested_name: &str, task: &str) -> String {
    let explicit = requested_name.trim();
    if !explicit.is_empty() {
        return explicit.to_string();
    }
    let normalized = task.trim();
    if normalized.is_empty() {
        return "task".to_string();
    }
    let cleaned: String = normalized
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c.is_whitespace() {
                c
            } else {
                ' '
            }
        })
        .collect();
    let words: Vec<&str> = cleaned.split_whitespace().take(8).collect();
    if words.is_empty() {
        "task".to_string()
    } else {
        words.join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::Scratch;
    use super::*;

    #[test]
    fn an_empty_catalogue_lists_nothing_and_finds_no_persona() {
        let scratch = Scratch::new();
        let store = PersonaStore::open(&scratch.path("personas.db"), &scratch.dir("personas"))
            .expect("open");
        assert!(store.list_personas("user-1").expect("list").is_empty());
        assert_eq!(store.get_persona("missing").expect("get"), None);
        assert_eq!(store.memory_persona_type("missing").expect("type"), None);
    }

    #[test]
    fn create_and_remove_project_workspace_round_trip() {
        let scratch = Scratch::new();
        let store = PersonaStore::open(&scratch.path("personas.db"), &scratch.dir("personas"))
            .expect("open");
        let paths = store
            .create_project_workspace("ada", "Build parser", "parser-v1")
            .expect("create project workspace");
        assert!(paths.relative_path.starts_with("personas/ada/projects/"));
        assert!(std::path::Path::new(&paths.absolute_path)
            .join("PROJECT.md")
            .is_file());
        store
            .remove_project_workspace("ada", &paths.absolute_path)
            .expect("remove project workspace");
        assert!(!std::path::Path::new(&paths.absolute_path).exists());
    }
}
