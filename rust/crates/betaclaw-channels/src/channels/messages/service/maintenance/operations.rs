//! Port of `src/server/channels/messages/service/maintenance/operations.ts` (S8).
//!
//! The TS `activeRequests` map holds `AbortController`s. Here the shared `AbortSignal` from
//! `model_hub::http` (controller and flag in one type) takes that role. The event bus, the gateway
//! broadcast and the inbox emitter are reached through [`ChatEvents`], attachment files through
//! [`AttachmentStore`], and the summary and recall caches through [`SummaryPort`] and [`RecallPort`].

use crate::channels::messages::service::ports::{ChatEvents, RecallPort, SummaryPort};
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde_json::{Map, Value};

use crate::channels::messages::service::conversation::ports::{
    MessageRepositoryPort, NewMessage, SessionPort,
};
use crate::channels::messages::service::execution::ports::PortError;
use crate::messages_store::types::{ChannelType, StoredMessage};
use crate::model_hub::http::AbortSignal;

/// Running generations per conversation (`MaintenanceDeps.activeRequests`).
#[derive(Default)]
pub struct ActiveRequests(Mutex<HashMap<String, AbortSignal>>);

impl ActiveRequests {
    /// Registers the signal of a generation that has just started.
    pub fn register(&self, conversation_id: &str, signal: AbortSignal) {
        self.lock().insert(conversation_id.to_string(), signal);
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, AbortSignal>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// `abortGeneration` from `operations.ts:23-32`.
pub fn abort_generation(active: &ActiveRequests, conversation_id: &str) -> bool {
    let Some(signal) = active.lock().remove(conversation_id) else {
        return false;
    };
    signal.abort();
    true
}

/// `abortAllActiveRequests` from `operations.ts:34-39`.
pub fn abort_all_active_requests(active: &ActiveRequests) {
    let mut requests = active.lock();
    for signal in requests.values() {
        signal.abort();
    }
    requests.clear();
}

/// `StoredMessageAttachment`, reduced to the file it points at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredAttachment {
    pub storage_path: String,
}

pub trait AttachmentStore: Send + Sync {
    /// `extractStoredAttachmentsFromMetadata`: unparsable metadata yields no attachments.
    fn extract(&self, metadata: Option<&str>) -> Vec<StoredAttachment>;

    /// `deleteStoredAttachmentFile`: best effort, never fails.
    fn delete_file(&self, attachment: &StoredAttachment);
}

/// `MaintenanceDeps` from `operations.ts:15-21`, plus the attachment store. The event bus,
/// gateway broadcast and inbox emitter are [`ChatEvents`].
pub struct MaintenanceDeps<'a> {
    pub repo: &'a dyn MessageRepositoryPort,
    pub session: &'a dyn SessionPort,
    pub summary: &'a dyn SummaryPort,
    pub recall: &'a dyn RecallPort,
    pub attachments: &'a dyn AttachmentStore,
    pub events: &'a dyn ChatEvents,
    pub active_requests: &'a ActiveRequests,
}

/// `deleteConversation` from `operations.ts:41-51`.
pub fn delete_conversation(
    deps: &MaintenanceDeps<'_>,
    conversation_id: &str,
    user_id: &str,
) -> Result<bool, PortError> {
    abort_generation(deps.active_requests, conversation_id);
    deps.summary.clear_in_flight(conversation_id);
    deps.recall.clear_conversation_state(conversation_id);
    deps.repo.delete_conversation(conversation_id, user_id)
}

/// `deleteMessage` from `operations.ts:53-84`. A repository without `getMessage` or
/// `deleteMessage` yields `false` through the port defaults.
pub fn delete_message(
    deps: &MaintenanceDeps<'_>,
    message_id: &str,
    user_id: &str,
    conversation_id: Option<&str>,
) -> Result<bool, PortError> {
    let normalized = deps.session.resolve_user_id(Some(user_id));
    let Some(message) = deps.repo.get_message(message_id, Some(&normalized))? else {
        return Ok(false);
    };
    if conversation_id
        .filter(|id| !id.is_empty())
        .is_some_and(|expected| message.conversation_id != expected)
    {
        return Ok(false);
    }
    if !deps.repo.delete_message(message_id, &normalized)? {
        return Ok(false);
    }

    for attachment in deps.attachments.extract(message.metadata.as_deref()) {
        deps.attachments.delete_file(&attachment);
    }
    deps.summary.clear_in_flight(&message.conversation_id);
    deps.recall
        .clear_conversation_state(&message.conversation_id);
    Ok(true)
}

/// `params` of `saveDirectMessage` (`operations.ts:86-96`).
#[derive(Debug, Clone, PartialEq)]
pub struct DirectMessage {
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub platform: ChannelType,
    pub user_id: Option<String>,
    pub metadata: Option<Map<String, Value>>,
}

/// `saveDirectMessage` from `operations.ts:86-128`: persist, then publish, broadcast and emit
/// the inbox update, in that order.
pub fn save_direct_message(
    deps: &MaintenanceDeps<'_>,
    params: DirectMessage,
) -> Result<StoredMessage, PortError> {
    let user = params
        .user_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .map(|id| deps.session.resolve_user_id(Some(id)));
    let conversation = deps
        .repo
        .get_conversation(&params.conversation_id, user.as_deref())?
        .ok_or_else(|| PortError::Failed("Conversation not found for current user.".to_string()))?;

    let message = deps.repo.save_message(NewMessage {
        conversation_id: params.conversation_id,
        role: params.role,
        content: params.content,
        platform: params.platform,
        metadata: params.metadata,
    })?;

    deps.events.message_persisted(&conversation, &message);
    deps.events
        .broadcast_chat_message(&conversation.user_id, &message);
    deps.events.inbox_upserted(&conversation, &message);
    Ok(message)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::channels::messages::service::conversation::fakes::{
        conversation, stored_message, FakeRepo, FakeSession,
    };
    use crate::channels::messages::service::execution::ports::PortResult;
    use crate::channels::messages::service::ports::{
        AutoMemoryCandidate, ConversationWindowInput, KnowledgeLayerFlags, StoreMemoryInput,
        StrictRecallReply, SummaryRefreshedEvent,
    };
    use crate::messages_store::types::Conversation;
    use crate::model_hub::http::BoxFuture;

    /// One double for all four side-effect ports; it records every call in order.
    #[derive(Default)]
    struct Fixture {
        recorded: Mutex<Vec<String>>,
        attachments: Vec<StoredAttachment>,
    }

    impl Fixture {
        fn record(&self, entry: String) {
            self.recorded.lock().unwrap().push(entry);
        }

        fn calls(&self) -> Vec<String> {
            self.recorded.lock().unwrap().clone()
        }
    }

    impl SummaryPort for Fixture {
        fn clear_in_flight(&self, conversation_id: &str) {
            self.record(format!("summary:{conversation_id}"));
        }

        fn schedule_summary_refresh(&self, _conversation: Conversation) {
            unreachable!("not used by the maintenance tests")
        }

        fn is_ai_summary_enabled(&self) -> bool {
            unreachable!("not used by the maintenance tests")
        }

        fn build_fallback_summary(
            &self,
            _previous: &str,
            _messages: &[(String, String)],
        ) -> String {
            unreachable!("not used by the maintenance tests")
        }

        fn is_auto_session_memory_enabled(&self) -> bool {
            unreachable!("not used by the maintenance tests")
        }

        fn auto_session_memory_mode(&self) -> String {
            unreachable!("not used by the maintenance tests")
        }

        fn build_auto_memory_candidates(
            &self,
            _messages: &[StoredMessage],
        ) -> Vec<AutoMemoryCandidate> {
            unreachable!("not used by the maintenance tests")
        }

        fn resolve_memory_user_id(&self, _conversation: &Conversation) -> String {
            unreachable!("not used by the maintenance tests")
        }

        fn store_memory(&self, _input: StoreMemoryInput) -> BoxFuture<'_, PortResult<()>> {
            unreachable!("not used by the maintenance tests")
        }

        fn is_inline_knowledge_ingestion_enabled(&self) -> bool {
            unreachable!("not used by the maintenance tests")
        }

        fn knowledge_layer_flags(&self) -> KnowledgeLayerFlags {
            unreachable!("not used by the maintenance tests")
        }

        fn ingest_conversation_window(
            &self,
            _input: ConversationWindowInput,
        ) -> BoxFuture<'_, PortResult<()>> {
            unreachable!("not used by the maintenance tests")
        }

        fn trace_auto_session_memory(&self, _name: &str, _fields: Value) {
            unreachable!("not used by the maintenance tests")
        }
    }

    impl RecallPort for Fixture {
        fn clear_conversation_state(&self, conversation_id: &str) {
            self.record(format!("recall:{conversation_id}"));
        }

        fn build_recall_context(
            &self,
            _conversation: Conversation,
            _user_input: String,
        ) -> BoxFuture<'_, PortResult<Option<String>>> {
            unreachable!("not used by the maintenance tests")
        }

        fn maybe_learn_from_feedback(&self, _conversation: Conversation, _content: String) {
            unreachable!("not used by the maintenance tests")
        }

        fn build_strict_evidence_reply(
            &self,
            _conversation: Conversation,
            _user_input: String,
        ) -> BoxFuture<'_, PortResult<Option<StrictRecallReply>>> {
            unreachable!("not used by the maintenance tests")
        }
    }

    impl AttachmentStore for Fixture {
        fn extract(&self, _metadata: Option<&str>) -> Vec<StoredAttachment> {
            self.attachments.clone()
        }

        fn delete_file(&self, attachment: &StoredAttachment) {
            self.record(format!("file:{}", attachment.storage_path));
        }
    }

    impl ChatEvents for Fixture {
        fn message_persisted(&self, _conversation: &Conversation, message: &StoredMessage) {
            self.record(format!("publish:{}", message.id));
        }

        fn broadcast_chat_message(&self, user_id: &str, _message: &StoredMessage) {
            self.record(format!("broadcast:{user_id}"));
        }

        fn build_inbox_item(&self, conversation: &Conversation, _message: &StoredMessage) -> Value {
            json!({ "conversationId": conversation.id })
        }

        fn emit_inbox_updated(
            &self,
            user_id: &str,
            action: &str,
            conversation_id: &str,
            _item: Value,
        ) {
            self.record(format!("inbox:{user_id}:{action}:{conversation_id}"));
        }

        fn bridge_stored_message(
            &self,
            _conversation: Conversation,
            _message: StoredMessage,
        ) -> BoxFuture<'_, PortResult<()>> {
            unreachable!("not used by the maintenance tests")
        }

        fn deliver_outbound(
            &self,
            _platform: ChannelType,
            _external_chat_id: String,
            _content: String,
            _persona_id: Option<String>,
        ) -> BoxFuture<'_, PortResult<()>> {
            unreachable!("not used by the maintenance tests")
        }

        fn summary_refreshed(&self, _event: SummaryRefreshedEvent) {
            unreachable!("not used by the maintenance tests")
        }
    }

    fn make_deps<'a>(
        repo: &'a FakeRepo,
        session: &'a FakeSession,
        fixture: &'a Fixture,
        active: &'a ActiveRequests,
    ) -> MaintenanceDeps<'a> {
        MaintenanceDeps {
            repo,
            session,
            summary: fixture,
            recall: fixture,
            attachments: fixture,
            events: fixture,
            active_requests: active,
        }
    }

    fn direct(conversation_id: &str, user_id: Option<&str>) -> DirectMessage {
        DirectMessage {
            conversation_id: conversation_id.to_string(),
            role: "agent".to_string(),
            content: "Hallo".to_string(),
            platform: ChannelType::WebChat,
            user_id: user_id.map(str::to_string),
            metadata: None,
        }
    }

    #[test]
    fn abort_generation_fires_the_registered_signal_only_once() {
        let active = ActiveRequests::default();
        let signal = AbortSignal::new();
        active.register("c1", signal.clone());

        assert!(abort_generation(&active, "c1"));
        assert!(signal.is_aborted());
        assert!(!abort_generation(&active, "c1"));
    }

    #[test]
    fn delete_conversation_aborts_the_run_and_clears_both_caches() {
        let repo = FakeRepo::default();
        let session = FakeSession;
        let fixture = Fixture::default();
        let active = ActiveRequests::default();
        let signal = AbortSignal::new();
        active.register("c1", signal.clone());
        let deps = make_deps(&repo, &session, &fixture, &active);

        assert!(delete_conversation(&deps, "c1", "user-1").unwrap());

        assert!(signal.is_aborted());
        assert_eq!(
            fixture.calls(),
            vec!["summary:c1".to_string(), "recall:c1".to_string()]
        );
        assert_eq!(
            *repo.deleted_conversations.lock().unwrap(),
            vec!["c1".to_string()]
        );
    }

    #[test]
    fn delete_message_rejects_a_foreign_conversation_before_deleting() {
        let repo = FakeRepo {
            messages: vec![stored_message("m1", "c1", "user", "hi")],
            ..FakeRepo::default()
        };
        let session = FakeSession;
        let fixture = Fixture {
            attachments: vec![StoredAttachment {
                storage_path: "/data/a.png".to_string(),
            }],
            ..Fixture::default()
        };
        let active = ActiveRequests::default();
        let deps = make_deps(&repo, &session, &fixture, &active);

        assert!(!delete_message(&deps, "m1", "user-1", Some("other")).unwrap());
        assert!(repo.deleted_messages.lock().unwrap().is_empty());
        assert!(fixture.calls().is_empty());
    }

    #[test]
    fn delete_message_removes_attachment_files_and_clears_caches() {
        let repo = FakeRepo {
            messages: vec![stored_message("m1", "c1", "user", "hi")],
            ..FakeRepo::default()
        };
        let session = FakeSession;
        let fixture = Fixture {
            attachments: vec![StoredAttachment {
                storage_path: "/data/a.png".to_string(),
            }],
            ..Fixture::default()
        };
        let active = ActiveRequests::default();
        let deps = make_deps(&repo, &session, &fixture, &active);

        assert!(delete_message(&deps, "m1", "user-1", Some("c1")).unwrap());

        assert_eq!(
            *repo.deleted_messages.lock().unwrap(),
            vec!["m1".to_string()]
        );
        assert_eq!(
            fixture.calls(),
            vec![
                "file:/data/a.png".to_string(),
                "summary:c1".to_string(),
                "recall:c1".to_string(),
            ]
        );
    }

    #[test]
    fn save_direct_message_fails_for_an_unknown_conversation() {
        let repo = FakeRepo::default();
        let session = FakeSession;
        let fixture = Fixture::default();
        let active = ActiveRequests::default();
        let deps = make_deps(&repo, &session, &fixture, &active);

        let error = save_direct_message(&deps, direct("missing", None)).unwrap_err();

        assert_eq!(
            error.to_string(),
            "Conversation not found for current user."
        );
        assert!(repo.saved.lock().unwrap().is_empty());
        assert!(fixture.calls().is_empty());
    }

    #[test]
    fn save_direct_message_persists_then_publishes_in_order() {
        let repo = FakeRepo {
            conversations: vec![conversation("c1", "user-1", None, "WebChat")],
            ..FakeRepo::default()
        };
        let session = FakeSession;
        let fixture = Fixture::default();
        let active = ActiveRequests::default();
        let deps = make_deps(&repo, &session, &fixture, &active);

        let message = save_direct_message(&deps, direct("c1", Some("user-1"))).unwrap();

        assert_eq!(message.role, "agent");
        assert_eq!(repo.saved.lock().unwrap().len(), 1);
        assert_eq!(
            fixture.calls(),
            vec![
                "publish:saved-1".to_string(),
                "broadcast:user-1".to_string(),
                "inbox:user-1:upsert:c1".to_string(),
            ]
        );
    }
}
