//! Port of `src/server/channels/messages/service/commands/projectCommand.ts` (S8).
//!
//! The project methods of the message repository (optional in TS) are on
//! [`MessageRepositoryPort`]. The TS `typeof` checks become `Option`: `None` yields the
//! "nicht verfügbar" reply. Workspace folders are created and removed through [`PersonaPort`].
//! TS throws that escape the command (persona lookup, workspace creation) become `Err`.

use crate::channels::messages::service::commands::types::reply;
use crate::channels::messages::service::conversation::ports::MessageRepositoryPort;
use crate::channels::messages::service::execution::ports::PortError;
use crate::channels::messages::service::ports::{
    NewProject, PersonaPort, ProjectRecord, SendResponse,
};
use crate::messages_store::types::{ChannelType, Conversation, StoredMessage};

/// The ports the project command needs. `projects` and `personas` are optional because the TS
/// runtime may lack them.
pub struct ProjectDeps<'a> {
    pub projects: Option<&'a dyn MessageRepositoryPort>,
    pub personas: Option<&'a dyn PersonaPort>,
}

/// `getPersonaRepository()`: without a persona port the TS call throws.
fn personas_of(personas: Option<&dyn PersonaPort>) -> Result<&dyn PersonaPort, PortError> {
    personas.ok_or_else(|| PortError::Failed("Persona-System nicht verfügbar".to_string()))
}

/// `resolveProjectByIdentifier`. Digits that parse to a positive number select by position.
/// `0` and values beyond the finite range fall through to the id or slug lookup.
fn resolve_project(
    projects: &dyn MessageRepositoryPort,
    persona_id: &str,
    user_id: &str,
    identifier: &str,
) -> Result<Option<ProjectRecord>, PortError> {
    let normalized = identifier.trim();
    if normalized.is_empty() {
        return Ok(None);
    }
    if normalized.bytes().all(|byte| byte.is_ascii_digit()) {
        let index: f64 = normalized.parse().unwrap_or(f64::INFINITY);
        if index.is_finite() && index > 0.0 {
            let list = projects.list_projects_by_persona(persona_id, user_id)?;
            return Ok((index as usize)
                .checked_sub(1)
                .and_then(|position| list.get(position))
                .cloned());
        }
    }
    projects.get_project_by_id_or_slug(persona_id, user_id, normalized)
}

pub async fn handle_project_command(
    conversation: &Conversation,
    payload: &str,
    platform: ChannelType,
    external_chat_id: &str,
    deps: &ProjectDeps<'_>,
    sender: &dyn SendResponse,
) -> Result<StoredMessage, PortError> {
    let Some(persona_id) = conversation
        .persona_id
        .as_deref()
        .filter(|id| !id.is_empty())
    else {
        return reply(
            sender,
            conversation,
            "⚠️ Kein Persona-Kontext aktiv. Bitte zuerst `/persona <name>` setzen.",
            platform,
            external_chat_id,
        )
        .await;
    };
    let Some(projects) = deps.projects else {
        return reply(
            sender,
            conversation,
            "⚠️ Projektverwaltung ist in diesem Runtime-Modus nicht verfügbar.",
            platform,
            external_chat_id,
        )
        .await;
    };

    let user_id = conversation.user_id.as_str();
    let mut tokens = payload.split_whitespace();
    let action = tokens.next().unwrap_or("status").to_lowercase();
    let rest = tokens.collect::<Vec<_>>().join(" ");

    match action.as_str() {
        "new" => {
            if rest.is_empty() {
                return reply(
                    sender,
                    conversation,
                    "Usage: /project new <name>",
                    platform,
                    external_chat_id,
                )
                .await;
            }
            let personas = personas_of(deps.personas)?;
            let slug = personas
                .get_persona(persona_id)?
                .map(|persona| persona.slug)
                .filter(|slug| !slug.is_empty());
            let Some(slug) = slug else {
                return reply(
                    sender,
                    conversation,
                    "⚠️ Aktive Persona nicht gefunden.",
                    platform,
                    external_chat_id,
                )
                .await;
            };

            let workspace = personas.create_project_workspace(&slug, &rest, &rest)?;
            let project = projects.create_project(&NewProject {
                user_id: user_id.to_string(),
                persona_id: persona_id.to_string(),
                name: rest,
                workspace_path: workspace.absolute_path,
                workspace_relative_path: Some(workspace.relative_path),
            })?;
            projects.set_active_project_for_conversation(
                &conversation.id,
                user_id,
                Some(project.id.as_str()),
            )?;
            let text = format!(
                "✅ Projekt erstellt und aktiv: {}\nID: {}\nSlug: {}",
                project.name, project.id, project.slug
            );
            reply(sender, conversation, &text, platform, external_chat_id).await
        }

        "list" => {
            let list = projects.list_projects_by_persona(persona_id, user_id)?;
            if list.is_empty() {
                return reply(
                    sender,
                    conversation,
                    "Keine Projekte vorhanden. Erzeuge eines mit `/project new <name>`.",
                    platform,
                    external_chat_id,
                )
                .await;
            }
            let mut lines = vec!["📁 Projekte:".to_string(), String::new()];
            lines.extend(list.iter().enumerate().map(|(index, project)| {
                format!("{}. {} ({})", index + 1, project.name, project.slug)
            }));
            reply(
                sender,
                conversation,
                &lines.join("\n"),
                platform,
                external_chat_id,
            )
            .await
        }

        "use" => {
            if rest.is_empty() {
                return reply(
                    sender,
                    conversation,
                    "Usage: /project use <id|slug|index>",
                    platform,
                    external_chat_id,
                )
                .await;
            }
            let Some(project) = resolve_project(projects, persona_id, user_id, &rest)? else {
                let text = format!("⚠️ Projekt nicht gefunden: {rest}");
                return reply(sender, conversation, &text, platform, external_chat_id).await;
            };
            projects.set_active_project_for_conversation(
                &conversation.id,
                user_id,
                Some(project.id.as_str()),
            )?;
            let text = format!("✅ Aktives Projekt: {} ({})", project.name, project.slug);
            reply(sender, conversation, &text, platform, external_chat_id).await
        }

        "delete" | "remove" => {
            if rest.is_empty() {
                return reply(
                    sender,
                    conversation,
                    "Usage: /project delete <id|slug|index>",
                    platform,
                    external_chat_id,
                )
                .await;
            }
            let personas = personas_of(deps.personas)?;
            let persona = personas
                .get_persona(persona_id)?
                .filter(|persona| !persona.slug.is_empty());
            let Some(persona) = persona else {
                return reply(
                    sender,
                    conversation,
                    "⚠️ Aktive Persona nicht gefunden.",
                    platform,
                    external_chat_id,
                )
                .await;
            };
            let Some(project) = resolve_project(projects, persona_id, user_id, &rest)? else {
                let text = format!("⚠️ Projekt nicht gefunden: {rest}");
                return reply(sender, conversation, &text, platform, external_chat_id).await;
            };

            let was_active = projects
                .get_conversation_project_state(&conversation.id, user_id)?
                .active_project_id
                .as_deref()
                == Some(project.id.as_str());
            if let Err(error) =
                personas.remove_project_workspace(&persona.slug, &project.workspace_path)
            {
                let text = format!(
                    "⚠️ Projekt-Workspace konnte nicht gelöscht werden: {}",
                    error
                );
                return reply(sender, conversation, &text, platform, external_chat_id).await;
            }

            let Some(deleted) =
                projects.delete_project_by_id_or_slug(persona_id, user_id, &project.id)?
            else {
                return reply(
                    sender,
                    conversation,
                    "⚠️ Projekt konnte nicht gelöscht werden.",
                    platform,
                    external_chat_id,
                )
                .await;
            };
            let text = if was_active {
                format!(
                    "🗑️ Projekt gelöscht: {} ({})\nAktives Projekt wurde entfernt.",
                    deleted.name, deleted.slug
                )
            } else {
                format!("🗑️ Projekt gelöscht: {} ({})", deleted.name, deleted.slug)
            };
            reply(sender, conversation, &text, platform, external_chat_id).await
        }

        "clear" => {
            projects.set_active_project_for_conversation(&conversation.id, user_id, None)?;
            reply(
                sender,
                conversation,
                "Aktives Projekt wurde entfernt.",
                platform,
                external_chat_id,
            )
            .await
        }

        // `status`, and any unknown action.
        _ => {
            let active = projects
                .get_conversation_project_state(&conversation.id, user_id)?
                .active_project_id
                .filter(|id| !id.is_empty());
            let Some(active) = active else {
                return reply(
                    sender,
                    conversation,
                    "Kein aktives Projekt gesetzt. Nutze `/project new <name>` oder `/project use <id|slug|index>`.",
                    platform,
                    external_chat_id,
                )
                .await;
            };
            let Some(project) = projects.get_project_by_id_or_slug(persona_id, user_id, &active)?
            else {
                return reply(
                    sender,
                    conversation,
                    "Aktives Projekt nicht mehr verfügbar.",
                    platform,
                    external_chat_id,
                )
                .await;
            };
            let text = format!(
                "Aktives Projekt: {}\nID: {}\nSlug: {}",
                project.name, project.id, project.slug
            );
            reply(sender, conversation, &text, platform, external_chat_id).await
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::channels::messages::service::commands::fakes::{persona_profile, RecordingSender};
    use crate::channels::messages::service::conversation::fakes::{conversation, FakeRepo};
    use crate::channels::messages::service::ports::WorkspacePaths;
    use crate::personas::types::PersonaProfile;

    /// Persona port for the project tests: every persona exists and workspace folders are
    /// recorded in memory.
    struct FakeWorkspaces {
        fail_remove: bool,
        removed: Mutex<Vec<String>>,
    }

    impl PersonaPort for FakeWorkspaces {
        fn list_personas(&self, _user_id: &str) -> Result<Vec<PersonaProfile>, PortError> {
            Ok(Vec::new())
        }

        fn get_persona(&self, persona_id: &str) -> Result<Option<PersonaProfile>, PortError> {
            Ok(Some(persona_profile(persona_id, "Ada", "ada", "🤖", "")))
        }

        fn create_project_workspace(
            &self,
            persona_slug: &str,
            _task: &str,
            requested_name: &str,
        ) -> Result<WorkspacePaths, PortError> {
            let relative = format!("{persona_slug}/{}", requested_name.to_lowercase());
            Ok(WorkspacePaths {
                absolute_path: format!("/data/{relative}"),
                relative_path: relative,
            })
        }

        fn remove_project_workspace(
            &self,
            _persona_slug: &str,
            workspace_path: &str,
        ) -> Result<(), PortError> {
            if self.fail_remove {
                return Err(PortError::Failed("disk busy".to_string()));
            }
            self.removed
                .lock()
                .unwrap()
                .push(workspace_path.to_string());
            Ok(())
        }

        fn memory_persona_type(&self, _persona_id: &str) -> Result<Option<String>, PortError> {
            unreachable!("not used by the project command")
        }
    }

    async fn run(
        text: &str,
        persona: Option<&str>,
        projects: &FakeRepo,
        workspaces: &FakeWorkspaces,
        sender: &RecordingSender,
    ) -> Result<StoredMessage, PortError> {
        let conv = conversation("c1", "user-1", persona, "WebChat");
        let deps = ProjectDeps {
            projects: Some(projects as &dyn MessageRepositoryPort),
            personas: Some(workspaces as &dyn PersonaPort),
        };
        handle_project_command(&conv, text, ChannelType::WebChat, "chat", &deps, sender).await
    }

    fn workspaces(fail_remove: bool) -> FakeWorkspaces {
        FakeWorkspaces {
            fail_remove,
            removed: Mutex::new(Vec::new()),
        }
    }

    #[tokio::test]
    async fn commands_need_an_active_persona() {
        let projects = FakeRepo::default();
        let sender = RecordingSender::default();

        run("list", None, &projects, &workspaces(false), &sender)
            .await
            .unwrap();

        assert!(sender
            .last()
            .content
            .starts_with("⚠️ Kein Persona-Kontext aktiv."));
    }

    #[tokio::test]
    async fn new_creates_the_workspace_and_activates_the_project() {
        let projects = FakeRepo::default();
        let sender = RecordingSender::default();

        run(
            "new Website",
            Some("p1"),
            &projects,
            &workspaces(false),
            &sender,
        )
        .await
        .unwrap();

        assert_eq!(
            sender.last().content,
            "✅ Projekt erstellt und aktiv: Website\nID: proj-1\nSlug: website"
        );
        assert_eq!(
            *projects.active_project.lock().unwrap(),
            Some("proj-1".to_string())
        );
    }

    #[tokio::test]
    async fn use_selects_by_one_based_index_and_treats_zero_as_a_slug() {
        let projects = FakeRepo::default();
        let sender = RecordingSender::default();
        let ws = workspaces(false);
        run("new Alpha", Some("p1"), &projects, &ws, &sender)
            .await
            .unwrap();
        run("new Beta", Some("p1"), &projects, &ws, &sender)
            .await
            .unwrap();

        run("use 2", Some("p1"), &projects, &ws, &sender)
            .await
            .unwrap();
        assert_eq!(sender.last().content, "✅ Aktives Projekt: Beta (beta)");

        run("use 0", Some("p1"), &projects, &ws, &sender)
            .await
            .unwrap();
        assert_eq!(sender.last().content, "⚠️ Projekt nicht gefunden: 0");
    }

    #[tokio::test]
    async fn deleting_the_active_project_removes_its_workspace() {
        let projects = FakeRepo::default();
        let sender = RecordingSender::default();
        let ws = workspaces(false);
        run("new Alpha", Some("p1"), &projects, &ws, &sender)
            .await
            .unwrap();

        run("delete 1", Some("p1"), &projects, &ws, &sender)
            .await
            .unwrap();

        assert_eq!(
            sender.last().content,
            "🗑️ Projekt gelöscht: Alpha (alpha)\nAktives Projekt wurde entfernt."
        );
        assert_eq!(ws.removed.lock().unwrap().len(), 1);
        assert!(projects.projects.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_failing_workspace_removal_keeps_the_project() {
        let projects = FakeRepo::default();
        let sender = RecordingSender::default();
        run(
            "new Alpha",
            Some("p1"),
            &projects,
            &workspaces(false),
            &sender,
        )
        .await
        .unwrap();

        run(
            "delete alpha",
            Some("p1"),
            &projects,
            &workspaces(true),
            &sender,
        )
        .await
        .unwrap();

        assert_eq!(
            sender.last().content,
            "⚠️ Projekt-Workspace konnte nicht gelöscht werden: disk busy"
        );
        assert_eq!(projects.projects.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn status_without_an_active_project_points_to_new_and_use() {
        let projects = FakeRepo::default();
        let sender = RecordingSender::default();

        run("", Some("p1"), &projects, &workspaces(false), &sender)
            .await
            .unwrap();

        assert_eq!(
            sender.last().content,
            "Kein aktives Projekt gesetzt. Nutze `/project new <name>` oder `/project use <id|slug|index>`."
        );
    }
}
