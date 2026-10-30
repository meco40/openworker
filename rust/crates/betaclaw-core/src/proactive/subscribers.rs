//! Port of the handler bodies in `src/server/proactive/subscribers.ts`.
//!
//! `registerProactiveEventSubscribers` attaches these two handlers to the server
//! event bus. That wiring is not ported. It needs the bus and the
//! `chat.message.persisted` and `chat.summary.refreshed` events, which the chat
//! message service emits (S8 chat dispatch). The functions below hold what the
//! handlers do once they have their payload. Errors are logged and never returned,
//! as in the TypeScript `try`/`catch`.

use crate::messages_store::MessageRole;

use super::repository::ProactiveRepository;
use super::service::ProactiveGateService;
use super::types::ProactiveMessageInput;

/// Handler of `chat.message.persisted` (`subscribers.ts:8-24`).
pub fn on_chat_message_persisted<R: ProactiveRepository>(
    service: &ProactiveGateService<R>,
    user_id: &str,
    persona_id: Option<&str>,
    role: MessageRole,
    content: &str,
    created_at: &str,
) {
    let Some(persona_id) = persona_id.filter(|value| !value.is_empty()) else {
        return;
    };
    if role != MessageRole::User {
        return;
    }
    let message = ProactiveMessageInput {
        role,
        content: content.to_string(),
        created_at: Some(created_at.to_string()),
    };
    if let Err(error) = service.ingest_messages(user_id, persona_id, &[message], None) {
        tracing::error!(
            error = %crate::safe_error_message(&error),
            "Proactive ingest on chat.message.persisted failed"
        );
    }
}

/// Handler of `chat.summary.refreshed` (`subscribers.ts:26-34`).
pub fn on_chat_summary_refreshed<R: ProactiveRepository>(
    service: &ProactiveGateService<R>,
    user_id: &str,
    persona_id: Option<&str>,
) {
    let Some(persona_id) = persona_id.filter(|value| !value.is_empty()) else {
        return;
    };
    if let Err(error) = service.evaluate(user_id, persona_id, None) {
        tracing::error!(
            error = %crate::safe_error_message(&error),
            "Proactive evaluate on chat.summary.refreshed failed"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proactive::sqlite_repository::SqliteProactiveRepository;

    #[test]
    fn only_a_user_message_with_a_persona_is_ingested() {
        let service =
            ProactiveGateService::new(SqliteProactiveRepository::open(":memory:").expect("open"));
        let now = crate::messages_store::now_iso();
        let text = "bitcoin investieren, Kurs, Nachrichten verfolgen";

        on_chat_message_persisted(&service, "u-1", Some("p-1"), MessageRole::Agent, text, &now);
        on_chat_message_persisted(&service, "u-1", None, MessageRole::User, text, &now);
        assert!(service
            .evaluate("u-1", "p-1", None)
            .expect("evaluate")
            .is_empty());

        on_chat_message_persisted(&service, "u-1", Some("p-1"), MessageRole::User, text, &now);
        let decisions = service.evaluate("u-1", "p-1", None).expect("evaluate");
        assert!(decisions
            .iter()
            .any(|decision| decision.candidate_key == "topic_watcher:bitcoin"));
    }
}
