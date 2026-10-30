//! Port of `src/server/channels/messages/service/recall/index.ts` (`RecallService`).
//!
//! `build_recall_context` runs the world-model, knowledge and memory recalls in
//! parallel, as the TypeScript `Promise.allSettled` does. Chat recall is
//! synchronous. A failed world-model read counts as an empty source. The
//! knowledge and memory recalls catch their own errors, as in TypeScript.
//!
//! Deviations:
//! - The optional `searchMessagesOverride` argument of `recallFromChat` is not
//!   ported. Nothing in the TypeScript tree passes it.
//! - The configuration comes from [`RecallSettings`], filled in by the caller,
//!   and not from process env inside this module.
//! - The trace log keeps the stage names and the slow and failure escalation.
//!   The full `chatRecallTrace` payload belongs to the diagnostics slice.

use std::time::Instant;

use futures_util::future::join3;

use crate::memory::service::{RecallMode, RecallRequest};
use crate::memory::types::{MemoryProviderKind, MemoryType};
use crate::messages_store::{ChannelType, Conversation, StoredMessage};
use crate::world_model::retrieval::index::{format_world_model_context, RetrieveContextInput};

use super::evidence::{build_strict_evidence_reply, EvidenceReply};
use super::fusion::{fuse_recall_sources, RecallSourcesInput};
use super::learning::learn_from_feedback;
use super::ports::{
    RecallChatSearch, RecallKnowledge, RecallMemory, RecallSourceError, RecallWorldModel,
};
use super::search::{recall_from_knowledge, KnowledgeRecallOptions};
use super::service_types::RecallSettings;
use super::state::RecallStateManager;
use super::utils::{memory_user_ids, now_ms};
use crate::channels::messages::service::types::{
    is_explicit_recall_command, normalize_memory_context, should_recall_memory_for_input,
    LastRecallState, MEMORY_FEEDBACK_WINDOW_MS, MEMORY_RECALL_LIMIT,
};

/// `preferenceMemoryTypes` (`index.ts:125-130`).
const PREFERENCE_MEMORY_TYPES: [MemoryType; 4] = [
    MemoryType::Preference,
    MemoryType::Avoidance,
    MemoryType::PersonalityTrait,
    MemoryType::WorkflowPattern,
];

/// The memory part of one recall call.
#[derive(Debug, Clone)]
struct MemoryRecallOptions {
    mode: RecallMode,
    memory_types: Option<Vec<MemoryType>>,
    /// `cacheEmptyScopes`: only the Mem0 provider uses the empty-scope cache and
    /// the last-recall state.
    cache_empty_scopes: bool,
}

/// Gate for "may memory be recalled in this conversation". The default is
/// `channelType !== AGENT_ROOM`.
type MemoryGate = Box<dyn Fn(&Conversation) -> bool + Send + Sync>;

/// `RecallService`. `chat` is `None` where the TypeScript constructor leaves
/// `searchMessages` undefined. The recall then returns no chat hits.
pub struct RecallService<W, K, M, C> {
    world_model: W,
    knowledge: K,
    memory: M,
    chat: Option<C>,
    settings: RecallSettings,
    memory_gate: Option<MemoryGate>,
    state: RecallStateManager,
}

impl<W, K, M, C> RecallService<W, K, M, C>
where
    W: RecallWorldModel,
    K: RecallKnowledge,
    M: RecallMemory,
    C: RecallChatSearch,
{
    pub fn new(
        world_model: W,
        knowledge: K,
        memory: M,
        chat: Option<C>,
        settings: RecallSettings,
    ) -> Self {
        Self {
            world_model,
            knowledge,
            memory,
            chat,
            settings,
            memory_gate: None,
            state: RecallStateManager::new(),
        }
    }

    /// Replaces the default gate, as the `isMemoryEnabledForConversation`
    /// constructor argument does.
    pub fn with_memory_gate(
        mut self,
        gate: impl Fn(&Conversation) -> bool + Send + Sync + 'static,
    ) -> Self {
        self.memory_gate = Some(Box::new(gate));
        self
    }

    fn is_memory_enabled(&self, conversation: &Conversation) -> bool {
        match &self.memory_gate {
            Some(gate) => gate(conversation),
            None => conversation.channel_type != ChannelType::AgentRoom.as_str(),
        }
    }

    /// `buildRecallContext`: the fused context for one user turn, or `None`.
    pub async fn build_recall_context(
        &self,
        conversation: &Conversation,
        user_input: &str,
    ) -> Option<String> {
        if !self.is_memory_enabled(conversation) {
            self.state.delete_state(&conversation.id);
            return None;
        }
        let Some(persona_id) = conversation.persona_id.as_deref() else {
            self.state.delete_state(&conversation.id);
            return None;
        };
        if !should_recall_memory_for_input(user_input) {
            return None;
        }

        let settings = self.settings;
        let user_ids = memory_user_ids(conversation);
        let explicit = is_explicit_recall_command(user_input);
        let cache_empty_scopes = settings.memory_provider == MemoryProviderKind::Mem0;
        // `isMem0PreferencesOnly() && memoryProvider === 'mem0'`.
        let prefers_only = settings.mem0_preferences_only && cache_empty_scopes;
        let knowledge_active = settings.knowledge_layer_enabled
            && settings.knowledge_retrieval_enabled
            && !settings.world_model_canonical;
        let knowledge = knowledge_active.then_some(&self.knowledge);

        let memory_options = MemoryRecallOptions {
            mode: if explicit {
                RecallMode::Lexical
            } else {
                RecallMode::Semantic
            },
            memory_types: prefers_only.then(|| PREFERENCE_MEMORY_TYPES.to_vec()),
            cache_empty_scopes,
        };
        let knowledge_options = KnowledgeRecallOptions {
            skip_pre_ingest: explicit,
            include_semantic: !explicit && !prefers_only,
            pre_ingest_on_recall: settings.knowledge_pre_ingest_on_recall,
        };

        let started = Instant::now();
        let (world_model_result, knowledge_context, memory_context) = join3(
            self.world_model_context(
                persona_id,
                conversation.workspace_id.as_deref(),
                &user_ids,
                user_input,
            ),
            recall_from_knowledge(
                knowledge,
                &user_ids,
                &conversation.id,
                persona_id,
                user_input,
                knowledge_options,
            ),
            self.recall_from_memory(
                conversation,
                persona_id,
                &user_ids,
                user_input,
                memory_options,
            ),
        )
        .await;
        let chat_hits = self.recall_from_chat(conversation, user_input);

        let (world_model_context, world_failed) = match world_model_result {
            Ok(context) => (context, false),
            Err(error) => {
                tracing::error!(
                    error = %crate::safe_error_message(&error),
                    "World model recall failed"
                );
                (None, true)
            }
        };

        let fused = fuse_recall_sources(&RecallSourcesInput {
            world_model: world_model_context.as_deref(),
            knowledge: knowledge_context.as_deref(),
            memory: memory_context.as_deref(),
            chat_hits: &chat_hits,
            computed_answer: None,
        });

        let duration_ms = started.elapsed().as_millis() as i64;
        let slow = duration_ms >= settings.slow_threshold_ms;
        if slow || world_failed {
            tracing::warn!(
                duration_ms,
                slow,
                world_failed,
                chat_hits = chat_hits.len(),
                fused = fused.is_some(),
                "chat recall context completed"
            );
        } else {
            tracing::debug!(
                duration_ms,
                chat_hits = chat_hits.len(),
                fused = fused.is_some(),
                "chat recall context completed"
            );
        }
        fused
    }

    /// `buildStrictEvidenceReply`. The chat search runs first, as in TypeScript,
    /// even when strict recall is off.
    pub async fn build_strict_evidence_reply(
        &self,
        conversation: &Conversation,
        user_input: &str,
    ) -> Option<EvidenceReply> {
        let memory_enabled = self.is_memory_enabled(conversation);
        let chat_hits = self.recall_from_chat(conversation, user_input);
        build_strict_evidence_reply(
            &self.memory,
            conversation,
            user_input,
            memory_enabled,
            &chat_hits,
            self.settings.strict_evidence_enabled,
        )
        .await
    }

    /// `recallFromChat`.
    pub fn recall_from_chat(
        &self,
        conversation: &Conversation,
        user_input: &str,
    ) -> Vec<StoredMessage> {
        super::search::recall_from_chat(self.chat.as_ref(), conversation, user_input)
    }

    /// `maybeLearnFromFeedback`. State older than the feedback window is
    /// dropped without learning. Any state is cleared after one feedback turn.
    pub async fn maybe_learn_from_feedback(&self, conversation: &Conversation, user_input: &str) {
        if !self.is_memory_enabled(conversation) {
            self.state.delete_state(&conversation.id);
            return;
        }
        let last = self.state.get_state(&conversation.id);
        if let Some(state) = &last {
            if now_ms() - state.queried_at > MEMORY_FEEDBACK_WINDOW_MS {
                self.state.delete_state(&conversation.id);
                return;
            }
        }
        learn_from_feedback(
            &self.memory,
            conversation,
            user_input,
            last.as_ref(),
            self.settings.mem0_factual_write_blocked,
        )
        .await;
        self.state.delete_state(&conversation.id);
    }

    /// `clearConversationState`.
    pub fn clear_conversation_state(&self, conversation_id: &str) {
        self.state.delete_state(conversation_id);
    }

    /// The world-model source. The first user id with a non-empty context
    /// wins. An error stops the source, which then counts as failed.
    async fn world_model_context(
        &self,
        persona_id: &str,
        workspace_id: Option<&str>,
        user_ids: &[String],
        user_input: &str,
    ) -> Result<Option<String>, RecallSourceError> {
        for user_id in user_ids {
            let input = RetrieveContextInput {
                user_id: user_id.clone(),
                persona_id: persona_id.to_string(),
                workspace_id: Some(workspace_id.unwrap_or("").to_string()),
                query: user_input.to_string(),
                ..Default::default()
            };
            let result = self.world_model.retrieve_context(&input).await?;
            if let Some(context) = format_world_model_context(&result) {
                return Ok(Some(context));
            }
        }
        Ok(None)
    }

    /// `recallFromMemory`. Skips scopes marked empty. Records the recalled node
    /// ids for feedback (Mem0 only). Errors are logged and the next user id is
    /// tried.
    async fn recall_from_memory(
        &self,
        conversation: &Conversation,
        persona_id: &str,
        user_ids: &[String],
        user_input: &str,
        options: MemoryRecallOptions,
    ) -> Option<String> {
        let workspace = conversation.workspace_id.as_deref();
        for user_id in user_ids {
            if options.cache_empty_scopes
                && self
                    .state
                    .is_mem0_scope_temporarily_empty(persona_id, user_id, workspace)
            {
                continue;
            }
            let started = Instant::now();
            let request = RecallRequest {
                mode: options.mode,
                memory_types: options.memory_types.clone(),
                workspace_id: conversation.workspace_id.clone(),
            };
            let recalled = match self
                .memory
                .recall_detailed(
                    persona_id,
                    user_input,
                    MEMORY_RECALL_LIMIT,
                    user_id,
                    &request,
                )
                .await
            {
                Ok(recalled) => recalled,
                Err(error) => {
                    tracing::error!(
                        error = %crate::safe_error_message(&error),
                        "Memory recall failed"
                    );
                    continue;
                }
            };

            let has_matches = !recalled.matches.is_empty();
            if options.cache_empty_scopes && has_matches {
                self.state
                    .clear_mem0_scope_empty_marker(persona_id, user_id, workspace);
                self.state.set_state(
                    &conversation.id,
                    LastRecallState {
                        persona_id: persona_id.to_string(),
                        user_id: user_id.clone(),
                        node_ids: recalled
                            .matches
                            .iter()
                            .map(|found| found.node.id.clone())
                            .collect(),
                        queried_at: now_ms(),
                    },
                );
            }
            let normalized = normalize_memory_context(&recalled.context);
            if options.cache_empty_scopes && normalized.is_some() {
                self.state
                    .clear_mem0_scope_empty_marker(persona_id, user_id, workspace);
            }
            if options.cache_empty_scopes && !has_matches {
                self.state
                    .mark_mem0_scope_temporarily_empty(persona_id, user_id, workspace);
            }

            tracing::debug!(
                duration_ms = started.elapsed().as_millis() as i64,
                matches = recalled.matches.len(),
                context_length = normalized.as_ref().map_or(0, String::len),
                "memory scope completed"
            );
            if let Some(normalized) = normalized {
                return Some(normalized);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::messages::service::recall::testing::{
        conversation, memory_match, memory_result, no_memory, settings, stored, FakeChat,
        FakeKnowledge, FakeMemory, FakeWorldModel,
    };
    use crate::memory::types::MemoryFeedbackSignal;

    type TestService = RecallService<FakeWorldModel, FakeKnowledge, FakeMemory, FakeChat>;

    fn service(
        world: FakeWorldModel,
        knowledge: FakeKnowledge,
        memory: FakeMemory,
        chat: FakeChat,
        settings: RecallSettings,
    ) -> TestService {
        RecallService::new(world, knowledge, memory, Some(chat), settings)
    }

    fn default_service(memory: FakeMemory, chat: FakeChat) -> TestService {
        service(
            FakeWorldModel::empty(),
            FakeKnowledge::with_context(""),
            memory,
            chat,
            settings(),
        )
    }

    #[tokio::test]
    async fn agent_room_has_no_recall_and_drops_state() {
        let svc = default_service(
            FakeMemory::answering(Ok(no_memory())),
            FakeChat::returning(vec![]),
        );
        svc.state.set_state(
            "conv-1",
            LastRecallState {
                persona_id: "p1".into(),
                user_id: "user-1".into(),
                node_ids: vec!["n1".into()],
                queried_at: now_ms(),
            },
        );
        let room = conversation("AgentRoom", Some("p1"));
        assert_eq!(
            svc.build_recall_context(&room, "Was haben wir gestern besprochen?")
                .await,
            None
        );
        assert_eq!(svc.state.get_state("conv-1"), None);
    }

    #[tokio::test]
    async fn memory_and_chat_are_fused_and_world_model_failure_is_tolerated() {
        let svc = service(
            FakeWorldModel::failing("db down"),
            FakeKnowledge::with_context(""),
            FakeMemory::answering(Ok(memory_result("Mag kein Obst", vec![]))),
            FakeChat::returning(vec![stored(
                "m1",
                "user",
                "Ich wollte Yoga machen",
                "2026-10-05T09:00:00.000Z",
            )]),
            settings(),
        );
        let conv = conversation("WebChat", Some("p1"));
        let fused = svc
            .build_recall_context(&conv, "Was haben wir gestern besprochen?")
            .await
            .expect("fused context");
        assert!(fused.contains("[Memory]\nMag kein Obst"), "{fused}");
        assert!(fused.contains("[Chat History]"), "{fused}");
        assert!(!fused.contains("[World Model]"), "{fused}");
        assert_eq!(
            svc.chat
                .as_ref()
                .unwrap()
                .queries
                .lock()
                .unwrap()
                .as_slice(),
            ["Was haben wir gestern besprochen?"]
        );
        let requests = svc.memory.requests.lock().unwrap().clone();
        assert_eq!(requests[0].mode, RecallMode::Semantic);
        assert_eq!(requests[0].memory_types, None);
    }

    #[tokio::test]
    async fn empty_scope_is_skipped_on_the_next_turn() {
        let svc = default_service(
            FakeMemory::answering(Ok(no_memory())),
            FakeChat::returning(vec![]),
        );
        let conv = conversation("WebChat", Some("p1"));
        assert_eq!(
            svc.build_recall_context(&conv, "Was haben wir gestern besprochen?")
                .await,
            None
        );
        assert_eq!(
            svc.build_recall_context(&conv, "Was haben wir gestern besprochen?")
                .await,
            None
        );
        // The second turn is served from the empty-scope cache, so memory is
        // asked only once.
        assert_eq!(svc.memory.requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn mem0_recall_is_followed_by_feedback_and_correction() {
        let svc = default_service(
            FakeMemory::answering(Ok(memory_result(
                "Termin: Dienstag",
                vec![
                    memory_match("n1", "Termin am Dienstag", "2026-10-05T10:00:00.000Z"),
                    memory_match("n2", "Termin um 9", "2026-10-05T10:00:00.000Z"),
                ],
            ))),
            FakeChat::returning(vec![]),
        );
        let conv = conversation("WebChat", Some("p1"));
        svc.build_recall_context(&conv, "Was haben wir gestern besprochen?")
            .await
            .expect("context");

        svc.maybe_learn_from_feedback(&conv, "Das ist falsch, der Termin ist morgen")
            .await;

        let feedback = svc.memory.feedback.lock().unwrap().clone();
        assert_eq!(feedback.len(), 1);
        assert_eq!(feedback[0].1, vec!["n1".to_string(), "n2".to_string()]);
        assert_eq!(feedback[0].2, MemoryFeedbackSignal::Negative);
        assert_eq!(feedback[0].3, "user-1");
        let stored = svc.memory.stored.lock().unwrap().clone();
        assert_eq!(stored[0].content, "der Termin ist morgen");
        assert_eq!(svc.state.get_state("conv-1"), None);
    }

    #[tokio::test]
    async fn non_mem0_provider_keeps_no_feedback_state() {
        let mut provider_settings = settings();
        provider_settings.memory_provider = MemoryProviderKind::Postgres;
        let svc = service(
            FakeWorldModel::empty(),
            FakeKnowledge::with_context(""),
            FakeMemory::answering(Ok(memory_result(
                "Termin",
                vec![memory_match("n1", "Termin", "2026-10-05T10:00:00.000Z")],
            ))),
            FakeChat::returning(vec![]),
            provider_settings,
        );
        let conv = conversation("WebChat", Some("p1"));
        svc.build_recall_context(&conv, "Was haben wir gestern besprochen?")
            .await;
        svc.maybe_learn_from_feedback(&conv, "falsch, der Termin ist morgen")
            .await;
        assert!(svc.memory.feedback.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn preferences_only_limits_memory_types_and_semantic_knowledge() {
        let mut prefs = settings();
        prefs.mem0_preferences_only = true;
        prefs.knowledge_layer_enabled = true;
        prefs.knowledge_retrieval_enabled = true;
        prefs.knowledge_pre_ingest_on_recall = true;
        let svc = service(
            FakeWorldModel::empty(),
            FakeKnowledge::with_context("Meeting am Montag"),
            FakeMemory::answering(Ok(no_memory())),
            FakeChat::returning(vec![]),
            prefs,
        );
        let conv = conversation("WebChat", Some("p1"));
        let fused = svc
            .build_recall_context(&conv, "Was haben wir gestern besprochen?")
            .await
            .expect("knowledge context");
        assert!(fused.contains("[Knowledge]\nMeeting am Montag"), "{fused}");
        let requests = svc.memory.requests.lock().unwrap().clone();
        let types = requests[0].memory_types.clone().expect("type filter");
        assert_eq!(types.len(), 4);
        assert!(!types.contains(&MemoryType::Fact));
    }

    #[tokio::test]
    async fn canonical_world_model_disables_the_knowledge_layer() {
        let mut canonical = settings();
        canonical.knowledge_layer_enabled = true;
        canonical.knowledge_retrieval_enabled = true;
        canonical.knowledge_pre_ingest_on_recall = true;
        canonical.world_model_canonical = true;
        let svc = service(
            FakeWorldModel::empty(),
            FakeKnowledge::with_context("Meeting am Montag"),
            FakeMemory::answering(Ok(no_memory())),
            FakeChat::returning(vec![]),
            canonical,
        );
        let conv = conversation("WebChat", Some("p1"));
        svc.build_recall_context(&conv, "Was haben wir gestern besprochen?")
            .await;
        assert!(svc.knowledge.ingested_users.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn strict_reply_uses_the_chat_hits_and_the_flag() {
        let mut strict = settings();
        strict.strict_evidence_enabled = true;
        let svc = service(
            FakeWorldModel::empty(),
            FakeKnowledge::with_context(""),
            FakeMemory::answering(Ok(no_memory())),
            FakeChat::returning(vec![stored(
                "m1",
                "user",
                "Ich wollte heute Yoga machen",
                "2026-10-05T09:00:00.000Z",
            )]),
            strict,
        );
        let conv = conversation("WebChat", Some("p1"));
        let reply = svc
            .build_strict_evidence_reply(&conv, "Was wollte ich heute machen?")
            .await
            .expect("strict reply");
        assert!(reply.content.contains("Yoga"), "{}", reply.content);
        assert_eq!(reply.metadata["strictRecall"], true);
    }
}
