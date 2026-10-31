//! Port of `src/server/channels/messages/service/commands/personaCommand.ts` (S8), together with
//! the channel-binding helpers of `src/server/channels/messages/channelBindingPersona.ts` that the
//! command uses.
//!
//! The persona catalogue (`server/personas/personaRepository.ts`, S2) is reached through
//! [`PersonaPort`]. `None` stands for the TS `getPersonaRepository()` failure, which the command
//! answers with the "nicht verfügbar" reply.

use crate::channels::messages::service::commands::types::reply;
use crate::channels::messages::service::conversation::ports::MessageRepositoryPort;
use crate::channels::messages::service::execution::ports::PortError;
use crate::channels::messages::service::ports::{PersonaPort, SendResponse};
use crate::messages_store::types::{ChannelType, Conversation, StoredMessage};

/// `getChannelBindingPersonaId`: `None` when there is no binding or the binding has no persona.
pub fn channel_binding_persona_id(
    repo: &dyn MessageRepositoryPort,
    user_id: &str,
    platform: ChannelType,
) -> Result<Option<String>, PortError> {
    Ok(repo
        .get_channel_binding(user_id, platform)?
        .and_then(|binding| binding.persona_id))
}

/// `setChannelBindingPersona`.
pub fn set_channel_binding_persona(
    repo: &dyn MessageRepositoryPort,
    user_id: &str,
    platform: ChannelType,
    persona_id: Option<&str>,
) -> Result<(), PortError> {
    repo.update_channel_binding_persona(user_id, platform, persona_id)
}

pub async fn handle_persona_command(
    conversation: &Conversation,
    payload: &str,
    platform: ChannelType,
    external_chat_id: &str,
    repo: &dyn MessageRepositoryPort,
    personas: Option<&dyn PersonaPort>,
    sender: &dyn SendResponse,
) -> Result<StoredMessage, PortError> {
    let lowered = payload.to_lowercase();
    let lower = lowered.trim();
    let user_id = conversation.user_id.as_str();

    let Some(catalog) = personas else {
        return reply(
            sender,
            conversation,
            "⚠️ Persona-System nicht verfügbar.",
            platform,
            external_chat_id,
        )
        .await;
    };
    let all = catalog.list_personas(user_id)?;

    // `/persona` without arguments: current persona and help.
    if lower.is_empty() {
        let current = match channel_binding_persona_id(repo, user_id, platform)? {
            Some(id) => catalog.get_persona(&id)?,
            None => None,
        };
        let status = match &current {
            Some(persona) => format!("Aktive Persona: {} **{}**", persona.emoji, persona.name),
            None => "Keine Persona aktiv (Default-Modus)".to_string(),
        };
        let text = [
            "🎭 **Persona-System**",
            "",
            status.as_str(),
            "",
            "**Befehle:**",
            "`/persona list` — Alle Personas anzeigen",
            "`/persona <Name>` — Persona wechseln",
            "`/persona off` — Persona deaktivieren",
        ]
        .join("\n");
        return reply(sender, conversation, &text, platform, external_chat_id).await;
    }

    if lower == "list" {
        if all.is_empty() {
            return reply(
                sender,
                conversation,
                "🎭 Keine Personas erstellt.\nErstelle Personas in der WebApp unter \"Agent Personas\".",
                platform,
                external_chat_id,
            )
            .await;
        }
        let current_id = channel_binding_persona_id(repo, user_id, platform)?;
        let mut lines = vec!["🎭 **Verfügbare Personas:**".to_string(), String::new()];
        for persona in &all {
            let active = if current_id.as_deref() == Some(persona.id.as_str()) {
                " ✓"
            } else {
                ""
            };
            let vibe = if persona.vibe.is_empty() {
                String::new()
            } else {
                format!(" — _{}_", persona.vibe)
            };
            lines.push(format!(
                "{} **{}**{vibe}{active}",
                persona.emoji, persona.name
            ));
        }
        lines.push(String::new());
        lines.push("Wechseln: `/persona <Name>`".to_string());
        return reply(
            sender,
            conversation,
            &lines.join("\n"),
            platform,
            external_chat_id,
        )
        .await;
    }

    if matches!(lower, "off" | "clear" | "default") {
        set_channel_binding_persona(repo, user_id, platform, None)?;
        repo.update_persona_id(&conversation.id, None, user_id)?;
        return reply(
            sender,
            conversation,
            "🎭 Persona deaktiviert. Du chattest jetzt im Default-Modus.",
            platform,
            external_chat_id,
        )
        .await;
    }

    // `/persona <name>`: exact or prefix match on the name, first hit wins.
    let Some(found) = all.iter().find(|persona| {
        let name = persona.name.to_lowercase();
        name == lower || name.starts_with(lower)
    }) else {
        let available = all
            .iter()
            .map(|persona| format!("{} {}", persona.emoji, persona.name))
            .collect::<Vec<_>>()
            .join(", ");
        let available = if available.is_empty() {
            "(keine)".to_string()
        } else {
            available
        };
        let text = format!("⚠️ Persona \"{payload}\" nicht gefunden.\nVerfügbar: {available}");
        return reply(sender, conversation, &text, platform, external_chat_id).await;
    };

    set_channel_binding_persona(repo, user_id, platform, Some(found.id.as_str()))?;
    repo.update_persona_id(&conversation.id, Some(found.id.as_str()), user_id)?;
    let text = format!(
        "🎭 Persona gewechselt: {} **{}**\nAlle neuen Nachrichten in {} nutzen jetzt diese Persona.",
        found.emoji,
        found.name,
        platform.as_str()
    );
    reply(sender, conversation, &text, platform, external_chat_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::messages::service::commands::fakes::{persona_profile, RecordingSender};
    use crate::channels::messages::service::conversation::fakes::{conversation, FakeRepo};
    use crate::channels::messages::service::ports::WorkspacePaths;
    use crate::personas::types::PersonaProfile;

    struct Catalog {
        personas: Vec<PersonaProfile>,
        unavailable: bool,
    }

    impl PersonaPort for Catalog {
        fn list_personas(&self, _user_id: &str) -> Result<Vec<PersonaProfile>, PortError> {
            Ok(self.personas.clone())
        }

        fn get_persona(&self, persona_id: &str) -> Result<Option<PersonaProfile>, PortError> {
            Ok(self.personas.iter().find(|p| p.id == persona_id).cloned())
        }

        fn create_project_workspace(
            &self,
            _persona_slug: &str,
            _task: &str,
            _requested_name: &str,
        ) -> Result<WorkspacePaths, PortError> {
            unreachable!("not used by the persona command")
        }

        fn remove_project_workspace(
            &self,
            _persona_slug: &str,
            _workspace_path: &str,
        ) -> Result<(), PortError> {
            unreachable!("not used by the persona command")
        }

        fn memory_persona_type(&self, _persona_id: &str) -> Result<Option<String>, PortError> {
            unreachable!("not used by the persona command")
        }
    }

    fn catalog() -> Catalog {
        Catalog {
            personas: vec![
                persona_profile("p-ada", "Ada", "ada", "🤖", "analytisch"),
                persona_profile("p-bob", "Bob", "bob", "🎨", ""),
            ],
            unavailable: false,
        }
    }

    async fn run(
        payload: &str,
        repo: &FakeRepo,
        catalog: &Catalog,
        sender: &RecordingSender,
    ) -> Result<StoredMessage, PortError> {
        let conv = conversation("c1", "user-1", None, "WebChat");
        let personas: Option<&dyn PersonaPort> = if catalog.unavailable {
            None
        } else {
            Some(catalog as &dyn PersonaPort)
        };
        handle_persona_command(
            &conv,
            payload,
            ChannelType::WebChat,
            "chat",
            repo,
            personas,
            sender,
        )
        .await
    }

    #[tokio::test]
    async fn help_without_a_binding_reports_default_mode() {
        let repo = FakeRepo::default();
        let sender = RecordingSender::default();

        run("", &repo, &catalog(), &sender).await.unwrap();

        assert!(sender
            .last()
            .content
            .contains("Keine Persona aktiv (Default-Modus)"));
    }

    #[tokio::test]
    async fn list_marks_the_bound_persona_and_shows_vibes() {
        let repo = FakeRepo::default();
        repo.bindings
            .lock()
            .unwrap()
            .insert("WebChat".to_string(), "p-ada".to_string());
        let sender = RecordingSender::default();

        run("list", &repo, &catalog(), &sender).await.unwrap();

        let text = sender.last().content;
        assert!(text.contains("🤖 **Ada** — _analytisch_ ✓"));
        assert!(text.contains("🎨 **Bob**\n"));
        assert!(!text.contains("Bob** ✓"));
    }

    #[tokio::test]
    async fn switching_by_name_prefix_updates_binding_and_conversation() {
        let repo = FakeRepo::default();
        let sender = RecordingSender::default();

        run("Ad", &repo, &catalog(), &sender).await.unwrap();

        assert_eq!(
            sender.last().content,
            "🎭 Persona gewechselt: 🤖 **Ada**\nAlle neuen Nachrichten in WebChat nutzen jetzt diese Persona."
        );
        assert_eq!(
            *repo.persona_updates.lock().unwrap(),
            vec![("c1".to_string(), Some("p-ada".to_string()))]
        );
        assert_eq!(
            repo.bindings
                .lock()
                .unwrap()
                .get("WebChat")
                .map(String::as_str),
            Some("p-ada")
        );
    }

    #[tokio::test]
    async fn unknown_name_lists_the_available_personas() {
        let repo = FakeRepo::default();
        let sender = RecordingSender::default();

        run("Zed", &repo, &catalog(), &sender).await.unwrap();

        assert_eq!(
            sender.last().content,
            "⚠️ Persona \"Zed\" nicht gefunden.\nVerfügbar: 🤖 Ada, 🎨 Bob"
        );
        assert!(repo.persona_updates.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn off_clears_both_the_binding_and_the_conversation() {
        let repo = FakeRepo::default();
        repo.bindings
            .lock()
            .unwrap()
            .insert("WebChat".to_string(), "p-ada".to_string());
        let sender = RecordingSender::default();

        run("off", &repo, &catalog(), &sender).await.unwrap();

        assert!(repo.bindings.lock().unwrap().is_empty());
        assert_eq!(
            *repo.persona_updates.lock().unwrap(),
            vec![("c1".to_string(), None)]
        );
        assert!(sender.last().content.starts_with("🎭 Persona deaktiviert."));
    }

    #[tokio::test]
    async fn missing_persona_system_is_reported_before_anything_else() {
        let repo = FakeRepo::default();
        let sender = RecordingSender::default();
        let unavailable = Catalog {
            personas: Vec::new(),
            unavailable: true,
        };

        run("list", &repo, &unavailable, &sender).await.unwrap();

        assert_eq!(sender.last().content, "⚠️ Persona-System nicht verfügbar.");
    }
}
