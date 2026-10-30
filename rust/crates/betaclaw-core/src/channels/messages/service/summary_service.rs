//! Port of `src/server/channels/messages/service/summaryService.ts`.
//!
//! Rolls the conversation summary forward every 20 messages. The write to
//! `conversation_context` is awaited. The auto session memory and knowledge
//! ingestion are fire-and-forget, as in the source, and run as spawned tasks.
//!
//! The in-flight lock is released right after the summary write, so the background
//! work does not block the next refresh. A timed-out memory write opens a circuit
//! breaker for the rest of that batch. The 3-second timeout counts from each call.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::channels::messages::service::conversation::ports::MessageRepositoryPort;
use crate::channels::messages::service::core::types::lock;
use crate::channels::messages::service::execution::ports::PortResult;
use crate::channels::messages::service::ports::{
    AutoMemoryCandidate, ChatEvents, ConversationWindowInput, ModelGateway, StoreMemoryInput,
    SummaryPort, SummaryRefreshedEvent,
};
use crate::channels::messages::service::utils::js_regex::suffix_utf16;
use crate::messages_store::types::{now_iso, ChannelType, Conversation, StoredMessage};
use crate::model_hub::service::types::DispatchWithFallbackOptions;
use crate::model_hub::types::{
    GatewayAuditContext, GatewayAuditKind, GatewayMessage, GatewayRequest, GatewayRole,
};

/// Auto session memory gives up on one candidate after this long.
const AUTO_SESSION_MEMORY_TIMEOUT_MS: u64 = 3000;
/// Messages read per refresh check (`summaryService.ts:68`).
const RECENT_WINDOW: usize = 200;
/// A refresh starts after this many unsummarised sequence numbers.
const REFRESH_THRESHOLD: i64 = 20;
/// Messages folded into one summary pass.
const CHUNK_SIZE: usize = 40;
/// Length cap of the stored summary, in UTF-16 units (`slice(-5000)`).
const SUMMARY_MAX_UNITS: usize = 5000;

/// The service behind `MessageService.maybeRefreshConversationSummary`.
pub struct SummaryService {
    repo: Arc<dyn MessageRepositoryPort>,
    summary: Arc<dyn SummaryPort>,
    model: Arc<dyn ModelGateway>,
    events: Arc<dyn ChatEvents>,
    in_flight: Mutex<HashSet<String>>,
}

impl SummaryService {
    pub fn new(
        repo: Arc<dyn MessageRepositoryPort>,
        summary: Arc<dyn SummaryPort>,
        model: Arc<dyn ModelGateway>,
        events: Arc<dyn ChatEvents>,
    ) -> Self {
        Self {
            repo,
            summary,
            model,
            events,
            in_flight: Mutex::new(HashSet::new()),
        }
    }

    /// `isInFlight(conversationId)`.
    pub fn is_in_flight(&self, conversation_id: &str) -> bool {
        lock(&self.in_flight).contains(conversation_id)
    }

    /// `clearInFlight(conversationId)`.
    pub fn clear_in_flight(&self, conversation_id: &str) {
        lock(&self.in_flight).remove(conversation_id);
    }

    /// `maybeRefreshConversationSummary(conversation)` (`summaryService.ts:61-137`).
    /// Errors come back as `Err`. The caller of a fire-and-forget refresh drops them.
    pub async fn maybe_refresh_conversation_summary(
        self: &Arc<Self>,
        conversation: &Conversation,
    ) -> PortResult<()> {
        if !lock(&self.in_flight).insert(conversation.id.clone()) {
            return Ok(());
        }

        let outcome = self.refresh_once(conversation).await;
        // Idempotent safety net for early-return and error paths.
        self.clear_in_flight(&conversation.id);
        outcome
    }

    async fn refresh_once(self: &Arc<Self>, conversation: &Conversation) -> PortResult<()> {
        let user_id = conversation.user_id.as_str();
        let recent =
            self.repo
                .list_messages(&conversation.id, Some(RECENT_WINDOW), None, Some(user_id))?;
        if recent.is_empty() {
            return Ok(());
        }

        let existing = self
            .repo
            .get_conversation_context(&conversation.id, user_id)?;
        let summary_upto_seq = existing.as_ref().map_or(0, |c| c.summary_upto_seq);
        let last_seq = recent.last().and_then(|m| m.seq).unwrap_or(0);
        if last_seq - summary_upto_seq < REFRESH_THRESHOLD {
            return Ok(());
        }

        let unsummarized: Vec<StoredMessage> = recent
            .into_iter()
            .filter(|message| message.seq.is_some_and(|seq| seq > summary_upto_seq))
            .collect();
        if unsummarized.is_empty() {
            return Ok(());
        }
        let chunk: Vec<StoredMessage> = unsummarized.into_iter().take(CHUNK_SIZE).collect();

        let previous = existing.map(|c| c.summary_text).unwrap_or_default();
        let pairs: Vec<(String, String)> = chunk
            .iter()
            .map(|m| (m.role.clone(), m.content.clone()))
            .collect();
        let merged = self
            .build_conversation_summary(&previous, &pairs, &conversation.id)
            .await;
        if merged.is_empty() {
            return Ok(());
        }

        let Some(upto_seq) = chunk.last().and_then(|m| m.seq) else {
            return Ok(());
        };

        self.repo
            .upsert_conversation_context(&conversation.id, &merged, upto_seq, user_id)?;

        self.events.summary_refreshed(SummaryRefreshedEvent {
            conversation_id: conversation.id.clone(),
            user_id: conversation.user_id.clone(),
            persona_id: conversation.persona_id.clone(),
            summary_text: merged.clone(),
            summary_upto_seq: upto_seq,
            messages: chunk.clone(),
            created_at: now_iso(),
        });

        // The SQLite write is done. Release the lock before the background I/O.
        self.clear_in_flight(&conversation.id);

        let this = Arc::clone(self);
        let conversation_for_memory = conversation.clone();
        let chunk_for_memory = chunk.clone();
        tokio::spawn(async move {
            this.maybe_store_auto_session_memory(&conversation_for_memory, chunk_for_memory)
                .await;
        });

        let this = Arc::clone(self);
        let conversation_for_knowledge = conversation.clone();
        tokio::spawn(async move {
            this.maybe_store_knowledge_artifacts(&conversation_for_knowledge, &chunk, &merged)
                .await;
        });

        Ok(())
    }

    /// `isAgentRoomConversation(conversation)` (`summaryService.ts:45-51`).
    fn is_agent_room(&self, conversation: &Conversation) -> PortResult<bool> {
        if ChannelType::parse(&conversation.channel_type) == Some(ChannelType::AgentRoom) {
            return Ok(true);
        }
        self.repo
            .is_agent_room_conversation(&conversation.id, Some(&conversation.user_id))
    }

    /// `maybeStoreAutoSessionMemory` (`summaryService.ts:139-323`).
    async fn maybe_store_auto_session_memory(
        &self,
        conversation: &Conversation,
        messages: Vec<StoredMessage>,
    ) {
        let mode = self.summary.auto_session_memory_mode();
        let conversation_id = conversation.id.as_str();
        let persona_id = conversation.persona_id.clone();
        let Ok(is_room) = self.is_agent_room(conversation) else {
            return;
        };
        if is_room {
            self.trace(
                "summary.skip",
                json!({"conversationId": conversation_id, "personaId": persona_id, "reason": "agent_room", "mode": mode}),
            );
            return;
        }
        let Some(persona_id) = persona_id else {
            self.trace(
                "summary.skip",
                json!({"conversationId": conversation_id, "personaId": Value::Null, "reason": "missing_persona", "mode": mode}),
            );
            return;
        };
        if !self.summary.is_auto_session_memory_enabled() {
            self.trace(
                "summary.skip",
                json!({"conversationId": conversation_id, "personaId": persona_id, "reason": "disabled", "mode": mode}),
            );
            return;
        }

        let candidates: Vec<AutoMemoryCandidate> =
            self.summary.build_auto_memory_candidates(&messages);
        if candidates.is_empty() {
            self.trace(
                "summary.skip",
                json!({"conversationId": conversation_id, "personaId": persona_id, "reason": "no_candidates", "mode": mode}),
            );
            return;
        }

        let memory_user_id = self.summary.resolve_memory_user_id(conversation);
        let batch_started = now_ms();
        let mut stored_count = 0usize;
        let mut failed_count = 0usize;
        let candidate_count = candidates.len();

        self.trace(
            "summary.batch.start",
            json!({
                "conversationId": conversation_id,
                "personaId": persona_id,
                "memoryUserId": memory_user_id,
                "candidateCount": candidate_count,
                "messageCount": messages.len(),
                "mode": mode,
                "timeoutMs": AUTO_SESSION_MEMORY_TIMEOUT_MS,
            }),
        );

        let mut circuit_open = false;
        for (index, candidate) in candidates.iter().enumerate() {
            if circuit_open {
                break;
            }
            let started_at = now_ms();
            let input = StoreMemoryInput {
                persona_id: persona_id.clone(),
                memory_type: candidate.memory_type.clone(),
                content: candidate.content.clone(),
                importance: candidate.importance,
                user_id: memory_user_id.clone(),
                metadata: json!({
                    "subject": "user",
                    "sourceRole": "user",
                    "sourceType": "auto_session",
                    "idempotencyKey": format!("auto-session:{conversation_id}:{}", candidate.content),
                }),
            };

            let attempt = tokio::time::timeout(
                Duration::from_millis(AUTO_SESSION_MEMORY_TIMEOUT_MS),
                self.summary.store_memory(input),
            )
            .await;
            let failure: Option<String> = match attempt {
                Ok(Ok(())) => None,
                Ok(Err(error)) => Some(error.to_string()),
                Err(_elapsed) => Some(format!(
                    "auto-session memory candidate timeout after {AUTO_SESSION_MEMORY_TIMEOUT_MS}ms"
                )),
            };

            match failure {
                None => {
                    stored_count += 1;
                    self.trace(
                        "summary.candidate.stored",
                        json!({
                            "conversationId": conversation_id,
                            "personaId": persona_id,
                            "memoryUserId": memory_user_id,
                            "candidateIndex": index + 1,
                            "candidateCount": candidate_count,
                            "candidateType": candidate.memory_type,
                            "importance": candidate.importance,
                            "durationMs": now_ms() - started_at,
                        }),
                    );
                }
                Some(message) => {
                    failed_count += 1;
                    // The source treats any message that contains "timeout" as a timeout.
                    let timed_out = message.contains("timeout");
                    self.trace(
                        "summary.candidate.failed",
                        json!({
                            "conversationId": conversation_id,
                            "personaId": persona_id,
                            "memoryUserId": memory_user_id,
                            "candidateIndex": index + 1,
                            "candidateCount": candidate_count,
                            "candidateType": candidate.memory_type,
                            "importance": candidate.importance,
                            "durationMs": now_ms() - started_at,
                            "timeoutMs": AUTO_SESSION_MEMORY_TIMEOUT_MS,
                            "error": message,
                            "level": if timed_out { "warn" } else { "error" },
                        }),
                    );
                    if timed_out {
                        circuit_open = true;
                        self.trace(
                            "summary.circuit_open",
                            json!({
                                "conversationId": conversation_id,
                                "personaId": persona_id,
                                "memoryUserId": memory_user_id,
                                "candidateIndex": index + 1,
                                "candidateCount": candidate_count,
                                "reason": "timeout",
                            }),
                        );
                    }
                }
            }
        }

        self.trace(
            "summary.batch.complete",
            json!({
                "conversationId": conversation_id,
                "personaId": persona_id,
                "memoryUserId": memory_user_id,
                "candidateCount": candidate_count,
                "storedCount": stored_count,
                "failedCount": failed_count,
                "circuitOpen": circuit_open,
                "durationMs": now_ms() - batch_started,
            }),
        );
    }

    /// `maybeStoreKnowledgeArtifacts` (`summaryService.ts:325-356`). Errors are logged.
    async fn maybe_store_knowledge_artifacts(
        &self,
        conversation: &Conversation,
        messages: &[StoredMessage],
        merged_summary: &str,
    ) {
        let Ok(is_room) = self.is_agent_room(conversation) else {
            return;
        };
        if is_room {
            return;
        }
        let Some(persona_id) = conversation.persona_id.clone() else {
            return;
        };
        if messages.is_empty() || !self.summary.is_inline_knowledge_ingestion_enabled() {
            return;
        }
        let flags = self.summary.knowledge_layer_flags();
        if !flags.layer_enabled || (!flags.episode_enabled && !flags.ledger_enabled) {
            return;
        }

        let input = ConversationWindowInput {
            conversation_id: conversation.id.clone(),
            user_id: self.summary.resolve_memory_user_id(conversation),
            persona_id,
            messages: messages.to_vec(),
            summary_text: merged_summary.to_string(),
        };
        if let Err(error) = self.summary.ingest_conversation_window(input).await {
            eprintln!("Knowledge ingestion failed: {error}");
        }
    }

    /// `buildConversationSummary` (`summaryService.ts:358-408`). Every failure returns
    /// the fallback summary.
    async fn build_conversation_summary(
        &self,
        previous_summary: &str,
        messages: &[(String, String)],
        conversation_id: &str,
    ) -> String {
        let fallback = self
            .summary
            .build_fallback_summary(previous_summary, messages);
        if !self.summary.is_ai_summary_enabled() {
            return fallback;
        }

        let Ok(encryption_key) = self.model.encryption_key() else {
            return fallback;
        };

        let mut user_lines = vec![
            "Previous summary:".to_string(),
            if previous_summary.is_empty() {
                "(none)".to_string()
            } else {
                previous_summary.to_string()
            },
            String::new(),
            "New messages:".to_string(),
        ];
        user_lines.extend(
            messages
                .iter()
                .map(|(role, content)| format!("[{role}] {content}")),
        );
        user_lines.push(String::new());
        user_lines.push("Task: Write an updated conversation summary in <= 400 words.".to_string());

        let mut request = GatewayRequest::new(
            String::new(),
            vec![
                GatewayMessage::new(
                    GatewayRole::System,
                    "You summarize a conversation for long-term continuity. Return concise plain text summary only.",
                ),
                GatewayMessage::new(GatewayRole::User, user_lines.join("\n")),
            ],
        );
        request.audit_context = Some(GatewayAuditContext {
            kind: GatewayAuditKind::Summary,
            conversation_id: Some(conversation_id.to_string()),
            turn_seq: None,
            memory_context: None,
            task_id: None,
            step_id: None,
            node_id: None,
        });

        match self
            .model
            .dispatch_with_fallback(
                "p1".to_string(),
                encryption_key,
                request,
                DispatchWithFallbackOptions::default(),
            )
            .await
        {
            Ok(result) if result.ok && !result.text.trim().is_empty() => {
                suffix_utf16(result.text.trim(), SUMMARY_MAX_UNITS).to_string()
            }
            _ => fallback,
        }
    }

    fn trace(&self, name: &str, fields: Value) {
        self.summary.trace_auto_session_memory(name, fields);
    }
}

/// `Date.now()` in milliseconds.
fn now_ms() -> i64 {
    crate::channels::messages::service::tool_manager::now_ms()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::messages::service::conversation::ports::NewMessage;
    use crate::channels::messages::service::ports::{
        BoxFuture, ConversationContext, KnowledgeLayerFlags, NewConversation, NewProject,
        ProjectRecord, ProjectState, SummaryRefreshedEvent,
    };
    use crate::messages_store::types::{InboxItemRecord, InboxListInput, InboxListResult};
    use crate::model_hub::service::types::DispatchWithFallbackOptions;
    use crate::model_hub::types::{GatewayRequest, GatewayResponse};

    /// Repository fake: a fixed message list, and a record of summary writes.
    struct FakeRepo {
        messages: Vec<StoredMessage>,
        upserts: Mutex<Vec<(String, i64)>>,
    }

    impl FakeRepo {
        fn with_seqs(seqs: std::ops::RangeInclusive<i64>) -> Self {
            let messages = seqs
                .map(|seq| StoredMessage {
                    id: format!("m-{seq}"),
                    conversation_id: "c-1".into(),
                    seq: Some(seq),
                    role: "user".into(),
                    content: format!("message {seq}"),
                    platform: "WebChat".into(),
                    external_msg_id: None,
                    sender_name: None,
                    metadata: None,
                    created_at: "t".into(),
                })
                .collect();
            Self {
                messages,
                upserts: Mutex::new(Vec::new()),
            }
        }
    }

    impl MessageRepositoryPort for FakeRepo {
        fn get_conversation(&self, _: &str, _: Option<&str>) -> PortResult<Option<Conversation>> {
            unimplemented!("not used by the summary service")
        }
        fn get_conversation_by_external_chat(
            &self,
            _: ChannelType,
            _: &str,
            _: Option<&str>,
        ) -> PortResult<Option<Conversation>> {
            unimplemented!("not used by the summary service")
        }
        fn get_or_create_conversation(
            &self,
            _: ChannelType,
            _: &str,
            _: Option<&str>,
            _: Option<&str>,
        ) -> PortResult<Conversation> {
            unimplemented!("not used by the summary service")
        }
        fn list_conversations(
            &self,
            _: Option<usize>,
            _: Option<&str>,
        ) -> PortResult<Vec<Conversation>> {
            unimplemented!("not used by the summary service")
        }
        fn get_default_web_chat_conversation(&self, _: Option<&str>) -> PortResult<Conversation> {
            unimplemented!("not used by the summary service")
        }
        fn save_message(&self, _: NewMessage) -> PortResult<StoredMessage> {
            unimplemented!("not used by the summary service")
        }
        fn delete_conversation(&self, _: &str, _: &str) -> PortResult<bool> {
            unimplemented!("not used by the summary service")
        }
        fn create_conversation(&self, _: &NewConversation) -> PortResult<Conversation> {
            unimplemented!("not used by the summary service")
        }
        fn is_agent_room_conversation(&self, _: &str, _: Option<&str>) -> PortResult<bool> {
            Ok(false)
        }
        fn update_model_override(&self, _: &str, _: Option<&str>, _: &str) -> PortResult<()> {
            unimplemented!("not used by the summary service")
        }
        fn update_persona_id(&self, _: &str, _: Option<&str>, _: &str) -> PortResult<()> {
            unimplemented!("not used by the summary service")
        }
        fn list_messages(
            &self,
            _: &str,
            _: Option<usize>,
            _: Option<&str>,
            _: Option<&str>,
        ) -> PortResult<Vec<StoredMessage>> {
            Ok(self.messages.clone())
        }
        fn get_conversation_context(
            &self,
            _: &str,
            _: &str,
        ) -> PortResult<Option<ConversationContext>> {
            Ok(None)
        }
        fn upsert_conversation_context(
            &self,
            id: &str,
            _: &str,
            upto: i64,
            _: &str,
        ) -> PortResult<()> {
            self.upserts.lock().unwrap().push((id.to_string(), upto));
            Ok(())
        }
        fn get_conversation_project_state(&self, _: &str, _: &str) -> PortResult<ProjectState> {
            unimplemented!("not used by the summary service")
        }
        fn get_project_by_id_or_slug(
            &self,
            _: &str,
            _: &str,
            _: &str,
        ) -> PortResult<Option<ProjectRecord>> {
            unimplemented!("not used by the summary service")
        }
        fn list_projects_by_persona(&self, _: &str, _: &str) -> PortResult<Vec<ProjectRecord>> {
            unimplemented!("not used by the summary service")
        }
        fn create_project(&self, _: &NewProject) -> PortResult<ProjectRecord> {
            unimplemented!("not used by the summary service")
        }
        fn set_active_project_for_conversation(
            &self,
            _: &str,
            _: &str,
            _: Option<&str>,
        ) -> PortResult<()> {
            unimplemented!("not used by the summary service")
        }
        fn set_conversation_project_guard_approved(
            &self,
            _: &str,
            _: &str,
            _: bool,
        ) -> PortResult<()> {
            unimplemented!("not used by the summary service")
        }
        fn list_inbox(&self, _: &InboxListInput<'_>) -> PortResult<InboxListResult> {
            unimplemented!("not used by the summary service")
        }
        fn delete_project_by_id_or_slug(
            &self,
            _: &str,
            _: &str,
            _: &str,
        ) -> PortResult<Option<ProjectRecord>> {
            unimplemented!("not used by the summary service")
        }
        fn get_inbox_item(&self, _: &str, _: &str) -> PortResult<Option<InboxItemRecord>> {
            unimplemented!("not used by the summary service")
        }
    }

    /// Event fake: records `chat.summary.refreshed`.
    #[derive(Default)]
    struct FakeEvents {
        refreshed: Mutex<Vec<SummaryRefreshedEvent>>,
    }

    impl ChatEvents for FakeEvents {
        fn message_persisted(&self, _: &Conversation, _: &StoredMessage) {}
        fn broadcast_chat_message(&self, _: &str, _: &StoredMessage) {}
        fn build_inbox_item(&self, _: &Conversation, _: &StoredMessage) -> Value {
            unreachable!("not used by the summary tests")
        }
        fn emit_inbox_updated(&self, _: &str, _: &str, _: &str, _: Value) {
            unreachable!("not used by the summary tests")
        }
        fn inbox_upserted(&self, _: &Conversation, _: &StoredMessage) {}
        fn bridge_stored_message(
            &self,
            _: Conversation,
            _: StoredMessage,
        ) -> BoxFuture<'_, PortResult<()>> {
            Box::pin(async { Ok(()) })
        }
        fn deliver_outbound(
            &self,
            _: ChannelType,
            _: String,
            _: String,
            _: Option<String>,
        ) -> BoxFuture<'_, PortResult<()>> {
            Box::pin(async { Ok(()) })
        }
        fn summary_refreshed(&self, event: SummaryRefreshedEvent) {
            self.refreshed.lock().unwrap().push(event);
        }
    }

    /// Summary policy fake: AI summary and memory features are off, so the fallback
    /// summary is what gets stored.
    struct FakeSummaryPolicy;

    impl SummaryPort for FakeSummaryPolicy {
        fn clear_in_flight(&self, _conversation_id: &str) {
            unreachable!("not used by the summary tests")
        }
        fn schedule_summary_refresh(&self, _conversation: Conversation) {
            unreachable!("not used by the summary tests")
        }
        fn is_ai_summary_enabled(&self) -> bool {
            false
        }
        fn build_fallback_summary(&self, _previous: &str, messages: &[(String, String)]) -> String {
            format!("fallback:{}", messages.len())
        }
        fn is_auto_session_memory_enabled(&self) -> bool {
            false
        }
        fn auto_session_memory_mode(&self) -> String {
            "off".into()
        }
        fn build_auto_memory_candidates(&self, _: &[StoredMessage]) -> Vec<AutoMemoryCandidate> {
            vec![]
        }
        fn resolve_memory_user_id(&self, conversation: &Conversation) -> String {
            conversation.user_id.clone()
        }
        fn store_memory(&self, _: StoreMemoryInput) -> BoxFuture<'_, PortResult<()>> {
            Box::pin(async { Ok(()) })
        }
        fn is_inline_knowledge_ingestion_enabled(&self) -> bool {
            false
        }
        fn knowledge_layer_flags(&self) -> KnowledgeLayerFlags {
            KnowledgeLayerFlags {
                layer_enabled: false,
                episode_enabled: false,
                ledger_enabled: false,
            }
        }
        fn ingest_conversation_window(
            &self,
            _: ConversationWindowInput,
        ) -> BoxFuture<'_, PortResult<()>> {
            Box::pin(async { Ok(()) })
        }
        fn trace_auto_session_memory(&self, _: &str, _: Value) {}
    }

    /// Model fake: never called while the AI summary is disabled.
    struct UnusedModel;

    impl ModelGateway for UnusedModel {
        fn encryption_key(&self) -> PortResult<String> {
            Ok("k".into())
        }
        fn dispatch_with_fallback(
            &self,
            _: String,
            _: String,
            _: GatewayRequest,
            _: DispatchWithFallbackOptions,
        ) -> BoxFuture<'_, PortResult<GatewayResponse>> {
            Box::pin(async { Err("unused".into()) })
        }
    }

    fn conversation() -> Conversation {
        Conversation {
            id: "c-1".into(),
            channel_type: "WebChat".into(),
            external_chat_id: None,
            user_id: "u-1".into(),
            workspace_id: None,
            title: "t".into(),
            model_override: None,
            persona_id: None,
            created_at: "t0".into(),
            updated_at: "t0".into(),
        }
    }

    fn service(repo: Arc<FakeRepo>, events: Arc<FakeEvents>) -> Arc<SummaryService> {
        Arc::new(SummaryService::new(
            repo,
            Arc::new(FakeSummaryPolicy),
            Arc::new(UnusedModel),
            events,
        ))
    }

    #[tokio::test]
    async fn below_twenty_unsummarised_messages_nothing_is_written() {
        let repo = Arc::new(FakeRepo::with_seqs(1..=5));
        let events = Arc::new(FakeEvents::default());
        let service = service(repo.clone(), events.clone());

        service
            .maybe_refresh_conversation_summary(&conversation())
            .await
            .expect("no error");

        assert!(repo.upserts.lock().unwrap().is_empty());
        assert!(events.refreshed.lock().unwrap().is_empty());
        assert!(
            !service.is_in_flight("c-1"),
            "the in-flight lock is released"
        );
    }

    #[tokio::test]
    async fn past_the_threshold_the_summary_is_stored_and_published() {
        let repo = Arc::new(FakeRepo::with_seqs(1..=25));
        let events = Arc::new(FakeEvents::default());
        let service = service(repo.clone(), events.clone());

        service
            .maybe_refresh_conversation_summary(&conversation())
            .await
            .expect("no error");

        assert_eq!(
            repo.upserts.lock().unwrap().as_slice(),
            &[("c-1".to_string(), 25)]
        );
        let refreshed = events.refreshed.lock().unwrap();
        assert_eq!(refreshed.len(), 1);
        assert_eq!(refreshed[0].summary_text, "fallback:25");
        assert_eq!(refreshed[0].summary_upto_seq, 25);
        assert_eq!(refreshed[0].messages.len(), 25);
    }
}
