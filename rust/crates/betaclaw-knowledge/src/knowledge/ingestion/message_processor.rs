//! Port of `src/server/knowledge/ingestion/messageProcessor.ts` (1-386).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `ProcessWindowContext` (`:28-34`) | [`ProcessWindowContext`] |
//! | `ProcessWindowResult` (`:36-51`) | [`ProcessWindowResult`] |
//! | `buildPersonaContext` (`:56-69`) | [`build_persona_context`] |
//! | `normalizeExtractionSelfReferences` (`:74-93`) | [`normalize_extraction_self_references`] |
//! | `processWindow` (`:98-386`) | [`process_window`] |
//! | the task evidence block (`:150-180`) | [`completed_task_evidence`] (private) |
//! | the canonical projection block (`:136-258`) | [`project_canonical`] (private) |
//!
//! The World Model calls go through [`WorldModelPort`]; see `world_model_port.rs`.
//!
//! # Deviations
//!
//! * The SQLite projection is written by [`write_sqlite_projection`]. A failure
//!   takes the TypeScript's two paths (`messageProcessor.ts:356-386`): without the
//!   World Model it is returned as [`ProcessWindowError::Knowledge`]; with the
//!   World Model on, the messages are marked memory-pending and a `sqlite_knowledge`
//!   retry is enqueued, and the window completes without the SQLite results.
//! * `console.*` calls become `tracing` events.

use serde_json::{json, Value};
use tracing::{error, warn};

use crate::knowledge::extractor::{KnowledgeExtractionInput, KnowledgeExtractionResult};
use crate::knowledge::ingestion::constants::GERMAN_SELF_REFERENCES;
use crate::knowledge::ingestion::emotion_tracker::detect_dominant_emotion;
use crate::knowledge::ingestion::entity_extractor::{
    normalize_self_references, self_reference_set, store_entities, validate_event_speaker_roles,
    EntityProcessingContext, EntityProcessingResult,
};
use crate::knowledge::ingestion::episode_extractor::{upsert_episode_and_ledger, EpisodeInput};
use crate::knowledge::ingestion::event_extractor::{
    store_events, EventProcessingContext, EventStorageResult,
};
use crate::knowledge::ingestion::fact_extractor::{
    detect_corrections, process_facts, process_meeting_ledger, store_facts, FactProcessingContext,
};
use crate::knowledge::ingestion::task_completion::{
    store_task_completions, TaskCompletionContext, TaskCompletionResult,
};
use crate::knowledge::ingestion::types::{
    KnowledgeExtractorLike, MemoryFactService, MessageMemoryMarker,
};
use crate::knowledge::ingestion::world_model_port::{
    CompletedTaskEvidence, ObservationDraft, ProjectWindowRequest, ProjectionPendingInput,
    WorldModelPort, WorldModelPortError, WorldModelProjection, WorldModelScope,
};
use crate::knowledge::ingestion_cursor::IngestionWindow;
use crate::knowledge::prompts::ExtractionPersonaContext;
use crate::knowledge::repositories::now_iso;
use crate::knowledge::repository::{KnowledgeError, KnowledgeRepository};
use crate::knowledge::task_tracker::{detect_task_completion, TaskStatus, TaskType, TrackedTask};
use crate::messages_store::MessageRepositoryError;

/// `ProcessWindowResult` (`messageProcessor.ts:36-51`).
#[derive(Debug, Clone, PartialEq)]
pub struct ProcessWindowResult {
    pub facts_stored: usize,
    pub events_stored: usize,
    pub entities_created: usize,
    pub entities_merged: usize,
    pub task_completions: Vec<TaskCompletionResult>,
    pub mem0_fail_count: usize,
    /// Facts that were not persisted and must be retried.
    pub mem0_pending_count: usize,
    /// The World Model projection was committed after the canonical write.
    pub world_model_projected: bool,
    pub world_model_observation_id: Option<String>,
    pub world_model_projection: Option<WorldModelProjection>,
}

/// An error that aborts [`process_window`].
#[derive(Debug)]
pub enum ProcessWindowError {
    /// A World Model operation failed and the projection is required.
    WorldModel(WorldModelPortError),
    /// The message store could not record the pending state.
    Messages(MessageRepositoryError),
    /// The SQLite projection failed and the World Model is off, so there is no
    /// retry path (`messageProcessor.ts:357`).
    Knowledge(KnowledgeError),
}

impl std::fmt::Display for ProcessWindowError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProcessWindowError::WorldModel(error) => write!(f, "{error}"),
            ProcessWindowError::Messages(error) => write!(f, "{error}"),
            ProcessWindowError::Knowledge(error) => write!(f, "{error}"),
        }
    }
}

impl From<WorldModelPortError> for ProcessWindowError {
    fn from(error: WorldModelPortError) -> Self {
        ProcessWindowError::WorldModel(error)
    }
}

impl From<MessageRepositoryError> for ProcessWindowError {
    fn from(error: MessageRepositoryError) -> Self {
        ProcessWindowError::Messages(error)
    }
}

impl From<KnowledgeError> for ProcessWindowError {
    fn from(error: KnowledgeError) -> Self {
        ProcessWindowError::Knowledge(error)
    }
}

/// The `resolvePersonaName` callback, borrowed (`messageProcessor.ts:28-34`).
pub type PersonaNameLookup<'a> = &'a (dyn Fn(&str) -> Option<String> + Sync);

/// `ProcessWindowContext` (`messageProcessor.ts:28-34`).
pub struct ProcessWindowContext<'a, X: ?Sized, R: ?Sized, M: ?Sized, W: ?Sized, P: ?Sized> {
    pub window: &'a IngestionWindow,
    pub extractor: &'a X,
    pub repo: &'a R,
    pub memory: Option<&'a M>,
    pub world_model: &'a W,
    /// `resolvePersonaName?.(personaId)`.
    pub resolve_persona_name: Option<PersonaNameLookup<'a>>,
    /// `markMessagesMemoryPending`.
    pub marker: Option<&'a P>,
}

/// `buildPersonaContext(window, resolvePersonaName)` (`messageProcessor.ts:56-69`).
/// The persona name is the resolved name, else the persona id.
pub fn build_persona_context(
    window: &IngestionWindow,
    resolve_persona_name: Option<PersonaNameLookup<'_>>,
) -> (String, ExtractionPersonaContext) {
    let resolved = resolve_persona_name
        .and_then(|resolve| resolve(&window.persona_id))
        .filter(|name| !name.is_empty());
    let persona_name = resolved.unwrap_or_else(|| window.persona_id.clone());
    let context = ExtractionPersonaContext {
        name: persona_name.clone(),
        identity_terms: Some(
            GERMAN_SELF_REFERENCES
                .iter()
                .map(|term| term.to_string())
                .collect(),
        ),
    };
    (persona_name, context)
}

/// `normalizeExtractionSelfReferences` (`messageProcessor.ts:74-93`): entity
/// names and event subjects or counterparts that are self-references become the
/// persona name.
pub fn normalize_extraction_self_references(
    extraction: &mut KnowledgeExtractionResult,
    persona_name: &str,
    persona_id: &str,
) {
    if persona_name == persona_id {
        return;
    }
    normalize_self_references(&mut extraction.entities, persona_name, persona_id);

    let self_refs = self_reference_set(persona_id);
    for event in &mut extraction.events {
        if !event.subject.is_empty() && self_refs.contains(&event.subject.to_lowercase()) {
            event.subject = persona_name.to_string();
        }
        if !event.counterpart.is_empty() && self_refs.contains(&event.counterpart.to_lowercase()) {
            event.counterpart = persona_name.to_string();
        }
    }
}

/// The WorldModel scope of a window (`{ userId, personaId, workspaceId ?? '' }`).
fn scope_of(window: &IngestionWindow) -> WorldModelScope {
    WorldModelScope {
        user_id: window.user_id.clone(),
        persona_id: window.persona_id.clone(),
        workspace_id: window.workspace_id.clone().unwrap_or_default(),
    }
}

/// `${conversationId}:${fromSeqExclusive + 1}-${toSeqInclusive}`.
pub(crate) fn window_id_of(window: &IngestionWindow) -> String {
    format!(
        "{}:{}-{}",
        window.conversation_id,
        window.from_seq_exclusive + 1,
        window.to_seq_inclusive
    )
}

/// The message ids of the window, as the marker expects them.
fn message_ids(window: &IngestionWindow) -> Vec<&str> {
    window
        .messages
        .iter()
        .map(|message| message.id.as_str())
        .collect()
}

/// The tasks the projector found that are completed in a user message
/// (`messageProcessor.ts:150-180`): the first matching user message per task.
fn completed_task_evidence(
    window: &IngestionWindow,
    projection: &WorldModelProjection,
) -> Vec<CompletedTaskEvidence> {
    let now = now_iso();
    projection
        .tasks
        .iter()
        .filter_map(|task| {
            let tracked = TrackedTask {
                id: task.title.clone(),
                user_id: window.user_id.clone(),
                persona_id: window.persona_id.clone(),
                title: task.title.clone(),
                description: None,
                task_type: TaskType::OneTime,
                status: TaskStatus::Open,
                deadline: None,
                recurrence: None,
                location: None,
                related_entity_id: None,
                created_at: now.clone(),
                completed_at: None,
                source_conversation_id: window.conversation_id.clone(),
            };
            window
                .messages
                .iter()
                .filter(|message| message.role == "user")
                .find_map(|message| {
                    detect_task_completion(&message.content, std::slice::from_ref(&tracked)).map(
                        |found| CompletedTaskEvidence {
                            title: task.title.clone(),
                            message_seq: message.seq.unwrap_or(0),
                            evidence_text: message.content.clone(),
                            confidence: found.match_confidence,
                        },
                    )
                })
        })
        .collect()
}

/// The canonical projection of one window (`messageProcessor.ts:136-258`).
/// Writes the projection, the standing-intent pass and the observation match.
/// The outputs go into `state`, so a later failure keeps what was already done.
#[derive(Debug, Default)]
struct CanonicalState {
    projected: bool,
    observation_id: Option<String>,
    projection: Option<WorldModelProjection>,
}

async fn project_canonical<W: WorldModelPort + Sync + ?Sized>(
    world_model: &W,
    window: &IngestionWindow,
    extraction: &KnowledgeExtractionResult,
    state: &mut CanonicalState,
) -> Result<(), WorldModelPortError> {
    let scope = scope_of(window);
    let projection = world_model.normalize_extraction(extraction, &scope)?;
    state.projection = Some(projection.clone());

    let window_id = window_id_of(window);
    let evidence = completed_task_evidence(window, &projection);
    let texts: Vec<Value> = window
        .messages
        .iter()
        .map(|message| {
            json!({
                "seq": message.seq.unwrap_or(0),
                "role": message.role,
                "content": message.content,
            })
        })
        .collect();
    let observation = ObservationDraft {
        user_id: window.user_id.clone(),
        persona_id: window.persona_id.clone(),
        workspace_id: window.workspace_id.clone().unwrap_or_default(),
        source_type: "automation".to_string(),
        source_id: window_id.clone(),
        occurred_at: now_iso(),
        payload: json!({
            "conversationId": window.conversation_id,
            "fromSeq": window.from_seq_exclusive + 1,
            "toSeq": window.to_seq_inclusive,
            "extractionVersion": "1",
            "windowId": window_id,
            "text": window
                .messages
                .iter()
                .map(|message| message.content.as_str())
                .filter(|content| !content.is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
            "rawExtraction": extraction,
            "texts": texts,
        }),
        source_authority: "persona".to_string(),
    };

    let projected = world_model
        .project_window(ProjectWindowRequest {
            scope: scope.clone(),
            projection,
            observation,
            extraction,
            completed_task_evidence: evidence,
        })
        .await?;
    state.observation_id = Some(projected.observation_id.clone());
    state.projected = true;

    for message in window
        .messages
        .iter()
        .filter(|message| message.role == "user")
    {
        world_model
            .process_incoming_standing_intents(&scope, &message.content)
            .await?;
    }
    if let Some(observation) = world_model
        .get_observation_by_id(&projected.observation_id, &scope)
        .await?
    {
        world_model.match_standing_intents(&observation).await?;
    }
    Ok(())
}

/// The SQLite knowledge writes of one window, in the TypeScript order
/// (`messageProcessor.ts:327-355`): the episode and the ledger, then the events,
/// then the entities. The first failure stops the writes.
fn write_sqlite_projection<R: KnowledgeRepository + ?Sized>(
    repo: &R,
    episode: &EpisodeInput<'_>,
    events: &EventProcessingContext<'_>,
    entities: &EntityProcessingContext<'_>,
) -> Result<(EventStorageResult, EntityProcessingResult), KnowledgeError> {
    upsert_episode_and_ledger(repo, episode)?;
    let event_result = store_events(repo, events)?;
    let entity_result = store_entities(repo, entities)?;
    Ok((event_result, entity_result))
}

/// `processWindow(context)` (`messageProcessor.ts:98-386`): extract, normalise,
/// project to the World Model when it is on, store facts to memory, then store
/// the episode, events, entities and task completions in the knowledge
/// repository.
pub async fn process_window<X, R, M, W, P>(
    context: ProcessWindowContext<'_, X, R, M, W, P>,
) -> Result<ProcessWindowResult, ProcessWindowError>
where
    X: KnowledgeExtractorLike + Sync + ?Sized,
    R: KnowledgeRepository + Sync + ?Sized,
    M: MemoryFactService + Sync + ?Sized,
    W: WorldModelPort + Sync + ?Sized,
    P: MessageMemoryMarker + Sync + ?Sized,
{
    let window = context.window;
    let (persona_name, persona_context) =
        build_persona_context(window, context.resolve_persona_name);

    let mut extraction = context
        .extractor
        .extract(&KnowledgeExtractionInput {
            conversation_id: window.conversation_id.clone(),
            user_id: window.user_id.clone(),
            persona_id: window.persona_id.clone(),
            messages: window.messages.clone(),
            persona_context: Some(persona_context),
        })
        .await;

    normalize_extraction_self_references(&mut extraction, &persona_name, &window.persona_id);
    validate_event_speaker_roles(&mut extraction.events, &extraction.entities, &persona_name);

    let dominant_emotion = detect_dominant_emotion(window);
    let corrections = detect_corrections(window);
    let facts = process_facts(&extraction, window);
    let meeting_ledger = process_meeting_ledger(&extraction, window);

    let config = context.world_model.config();
    let world_model_on = config.enabled || config.e2e_enabled;
    let scope = scope_of(window);
    let window_id = window_id_of(window);
    let mut state = CanonicalState::default();

    // ── Phase 3: canonical PostgreSQL projection first ──────────────────────
    // When the World Model is on, PostgreSQL is the source of truth. Mem0 and
    // SQLite are derived projections written afterwards, and their failures do
    // not block the ingestion.
    if world_model_on {
        if let Err(failure) =
            project_canonical(context.world_model, window, &extraction, &mut state).await
        {
            let text = failure.to_string();
            if let Some(marker) = context.marker {
                marker.mark_messages_memory_pending(
                    &message_ids(window),
                    true,
                    Some(text.as_str()),
                )?;
            }
            if config.required {
                return Err(ProcessWindowError::WorldModel(failure));
            }
            let pending = ProjectionPendingInput {
                scope: scope.clone(),
                projection_type: "world_model_window".to_string(),
                source_window_id: window_id.clone(),
                source_observation_id: None,
                payload: json!({
                    "conversationId": window.conversation_id,
                    "fromSeqExclusive": window.from_seq_exclusive,
                    "toSeqInclusive": window.to_seq_inclusive,
                    "rawExtraction": extraction,
                    "messageIds": window.messages.iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
                }),
                error_message: text.clone(),
            };
            if let Err(pending_error) = context
                .world_model
                .enqueue_projection_pending(pending)
                .await
            {
                error!(error = %pending_error, "[knowledge-ingestion] could not persist projection retry");
            }
            error!(error = %text, "[knowledge-ingestion] world-model projection failed (fail-soft)");
        }
    }

    // ── Derived projections: Mem0 facts ─────────────────────────────────────
    let fact_result = store_facts(
        context.memory,
        &facts,
        &FactProcessingContext {
            window,
            extraction: &extraction,
            dominant_emotion,
            corrections,
        },
        context.world_model,
    )
    .await;

    if fact_result.pending_count > 0 {
        // Legacy mode: Mem0 is the primary store, so the window stops here.
        if !world_model_on {
            return Ok(ProcessWindowResult {
                facts_stored: fact_result.memory_ids.len(),
                events_stored: 0,
                entities_created: 0,
                entities_merged: 0,
                task_completions: Vec::new(),
                mem0_fail_count: fact_result.fail_count,
                mem0_pending_count: fact_result.pending_count,
                world_model_projected: state.projected,
                world_model_observation_id: None,
                world_model_projection: state.projection,
            });
        }

        // World-model mode: the canonical commit is done, so a Mem0 failure does
        // not block the checkpoint.
        let text = format!(
            "{} factual Mem0 projection(s) pending",
            fact_result.pending_count
        );
        if let Some(marker) = context.marker {
            marker.mark_messages_memory_pending(&message_ids(window), true, Some(text.as_str()))?;
        }
        warn!(
            pending = fact_result.pending_count,
            "[knowledge-ingestion] Mem0 projection incomplete after canonical commit"
        );
        if let Some(observation_id) = state.observation_id.clone() {
            context
                .world_model
                .enqueue_projection_pending(ProjectionPendingInput {
                    scope: scope.clone(),
                    projection_type: "mem0_fact".to_string(),
                    source_observation_id: Some(observation_id),
                    source_window_id: window_id.clone(),
                    payload: json!({
                        "facts": facts,
                        "rawExtraction": extraction,
                        "messageIds": window.messages.iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
                    }),
                    error_message: text.clone(),
                })
                .await?;
        }
    }

    // ── Derived projections: SQLite knowledge ───────────────────────────────
    let sqlite = write_sqlite_projection(
        context.repo,
        &EpisodeInput {
            window,
            extraction: &extraction,
            facts: facts.clone(),
            filtered_decisions: meeting_ledger.decisions.clone(),
            filtered_negotiated_terms: meeting_ledger.negotiated_terms.clone(),
            filtered_open_points: meeting_ledger.open_points.clone(),
            filtered_action_items: meeting_ledger.action_items.clone(),
            memory_ids: fact_result.memory_ids.clone(),
        },
        &EventProcessingContext {
            window,
            extraction: &extraction,
            persona_name: persona_name.clone(),
        },
        &EntityProcessingContext {
            window,
            entities: extraction.entities.clone(),
        },
    );
    let (event_result, entity_result, task_completions, sqlite_projected) = match sqlite {
        Ok((event_result, entity_result)) => {
            let task_completions = store_task_completions(
                context.memory,
                window,
                &meeting_ledger.action_items,
                &TaskCompletionContext {
                    user_id: window.user_id.clone(),
                    persona_id: window.persona_id.clone(),
                    conversation_id: window.conversation_id.clone(),
                    topic_key: Some(extraction.meeting_ledger.topic_key.clone()),
                },
                context.world_model,
            )
            .await;
            (event_result, entity_result, task_completions, true)
        }
        Err(failure) => {
            // Legacy mode: the SQLite store is the primary write, so the error stands.
            if !world_model_on {
                return Err(ProcessWindowError::Knowledge(failure));
            }
            // World-model mode: the canonical commit is done. The messages stay
            // memory-pending and the projection is retried later.
            let text = failure.to_string();
            if let Some(marker) = context.marker {
                marker.mark_messages_memory_pending(
                    &message_ids(window),
                    true,
                    Some(text.as_str()),
                )?;
            }
            let pending = ProjectionPendingInput {
                scope: scope.clone(),
                projection_type: "sqlite_knowledge".to_string(),
                source_window_id: window_id.clone(),
                source_observation_id: state.observation_id.clone(),
                payload: json!({
                    "conversationId": window.conversation_id,
                    "fromSeqExclusive": window.from_seq_exclusive,
                    "toSeqInclusive": window.to_seq_inclusive,
                    "messages": window.messages,
                    "rawExtraction": extraction,
                    "facts": facts,
                    "memoryIds": fact_result.memory_ids,
                    "personaName": persona_name,
                }),
                error_message: text.clone(),
            };
            if let Err(pending_error) = context
                .world_model
                .enqueue_projection_pending(pending)
                .await
            {
                error!(error = %pending_error, "[knowledge-ingestion] could not persist projection retry");
            }
            error!(error = %text, "[knowledge-ingestion] SQLite knowledge projection failed (retryable)");
            (
                EventStorageResult::default(),
                EntityProcessingResult::default(),
                Vec::new(),
                false,
            )
        }
    };

    if world_model_on && state.projected && sqlite_projected && fact_result.pending_count == 0 {
        if let Some(marker) = context.marker {
            marker.mark_messages_memory_pending(&message_ids(window), false, None)?;
        }
    }

    Ok(ProcessWindowResult {
        facts_stored: fact_result.memory_ids.len(),
        events_stored: event_result.stored,
        entities_created: entity_result.created,
        entities_merged: entity_result.merged,
        task_completions,
        mem0_fail_count: fact_result.fail_count,
        mem0_pending_count: fact_result.pending_count,
        world_model_projected: state.projected,
        world_model_observation_id: state.observation_id,
        world_model_projection: state.projection,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::event_types::SpeakerRole;
    use crate::knowledge::extractor::KnowledgeMeetingLedger;
    use crate::knowledge::ingestion::test_support::{FakeMemory, FakeWorldModel};
    use crate::knowledge::ingestion::world_model_port::ProjectedTask;
    use crate::knowledge::sqlite_knowledge_repository::SqliteKnowledgeRepository;
    use crate::messages_store::StoredMessage;
    use std::sync::Mutex;

    fn window(messages: Vec<StoredMessage>) -> IngestionWindow {
        IngestionWindow {
            conversation_id: "c-1".into(),
            user_id: "u-1".into(),
            persona_id: "lea".into(),
            workspace_id: None,
            from_seq_exclusive: 4,
            to_seq_inclusive: 6,
            messages,
        }
    }

    fn message(seq: i64, role: &str, content: &str) -> StoredMessage {
        StoredMessage {
            id: format!("m{seq}"),
            conversation_id: "c-1".into(),
            seq: Some(seq),
            role: role.into(),
            content: content.into(),
            platform: "web".into(),
            external_msg_id: None,
            sender_name: None,
            metadata: None,
            created_at: String::new(),
        }
    }

    fn extraction() -> KnowledgeExtractionResult {
        use crate::knowledge::event_extractor::ExtractedEvent;
        KnowledgeExtractionResult {
            facts: vec![],
            teaser: String::new(),
            episode: String::new(),
            meeting_ledger: KnowledgeMeetingLedger {
                topic_key: "general-meeting".into(),
                counterpart: None,
                participants: vec![],
                decisions: vec![],
                negotiated_terms: vec![],
                open_points: vec![],
                action_items: vec![],
                source_refs: vec![],
                confidence: 0.6,
            },
            events: vec![ExtractedEvent {
                event_type: "visit".into(),
                speaker_role: SpeakerRole::User,
                subject: "lea".into(),
                counterpart: "ich".into(),
                relation_label: None,
                time_expression: String::new(),
                start_date: String::new(),
                end_date: String::new(),
                day_count: 1,
                is_confirmation: false,
                confirmation_signals: vec![],
                source_seq: vec![],
            }],
            entities: vec![],
        }
    }

    #[test]
    fn the_persona_name_falls_back_to_the_persona_id() {
        let w = window(vec![]);
        let (name, context) = build_persona_context(&w, None);
        assert_eq!(name, "lea");
        assert_eq!(context.name, "lea");
        assert_eq!(context.identity_terms.as_ref().map(Vec::len), Some(3));

        let resolve = |_: &str| Some("Lea".to_string());
        let (resolved, _) = build_persona_context(&w, Some(&resolve));
        assert_eq!(resolved, "Lea");

        let blank = |_: &str| Some(String::new());
        let (fallback, _) = build_persona_context(&w, Some(&blank));
        assert_eq!(fallback, "lea");
    }

    #[test]
    fn event_self_references_become_the_persona_name() {
        let mut ex = extraction();
        normalize_extraction_self_references(&mut ex, "Lea", "lea-id");
        // The subject is the persona id, which is not the name: `lea` is not a
        // self-reference here, so the subject stays.
        assert_eq!(ex.events[0].subject, "lea");
        assert_eq!(
            ex.events[0].counterpart, "Lea",
            "`ich` becomes the persona name"
        );
    }

    #[test]
    fn the_task_evidence_takes_the_first_matching_user_message() {
        let w = window(vec![
            message(5, "agent", "Müll?"),
            message(6, "user", "Müll ist erledigt"),
        ]);
        let projection = WorldModelProjection {
            tasks: vec![ProjectedTask {
                title: "Müll rausbringen".into(),
            }],
            payload: Value::Null,
        };
        // The evidence is either empty or carries the user's message; the
        // detector decides which. The agent message is never evidence.
        for item in completed_task_evidence(&w, &projection) {
            assert_eq!(item.message_seq, 6);
        }
    }

    #[test]
    fn the_window_id_uses_the_first_seq_after_the_checkpoint() {
        assert_eq!(window_id_of(&window(vec![])), "c-1:5-6");
    }

    /// Returns the same extraction for every window.
    struct FixedExtractor(KnowledgeExtractionResult);

    impl KnowledgeExtractorLike for FixedExtractor {
        async fn extract(&self, _input: &KnowledgeExtractionInput) -> KnowledgeExtractionResult {
            self.0.clone()
        }
    }

    /// One memory-pending mark: the message ids, the flag and the error.
    type Mark = (Vec<String>, bool, Option<String>);

    /// Records every memory-pending mark.
    #[derive(Default)]
    struct RecordingMarker {
        marks: Mutex<Vec<Mark>>,
    }

    impl MessageMemoryMarker for RecordingMarker {
        fn mark_messages_memory_pending(
            &self,
            message_ids: &[&str],
            pending: bool,
            error_message: Option<&str>,
        ) -> Result<(), MessageRepositoryError> {
            self.marks.lock().expect("lock").push((
                message_ids.iter().map(|id| id.to_string()).collect(),
                pending,
                error_message.map(str::to_string),
            ));
            Ok(())
        }
    }

    /// One window with a fact-free extraction and a SQLite store whose
    /// `knowledge_episodes` table is gone, so the SQLite write fails.
    async fn process_with_broken_sqlite(
        world_model: &FakeWorldModel,
        marker: &RecordingMarker,
    ) -> Result<ProcessWindowResult, ProcessWindowError> {
        let repo = SqliteKnowledgeRepository::open(":memory:").expect("open in-memory store");
        repo.execute_batch_for_test("DROP TABLE knowledge_episodes;");
        let window = window(vec![message(5, "user", "Hallo"), message(6, "agent", "Hi")]);
        process_window(ProcessWindowContext {
            window: &window,
            extractor: &FixedExtractor(extraction()),
            repo: &repo,
            memory: Some(&FakeMemory),
            world_model,
            resolve_persona_name: None,
            marker: Some(marker),
        })
        .await
    }

    /// World model on: the canonical commit succeeds and the SQLite write fails.
    /// The window still completes. Its messages stay memory-pending with the error,
    /// and a `sqlite_knowledge` retry is queued (`messageProcessor.ts:356-386`).
    #[tokio::test]
    async fn a_failed_sqlite_write_stays_pending_and_is_queued_when_the_world_model_is_on() {
        let world_model = FakeWorldModel {
            canonical: true,
            ..Default::default()
        };
        let marker = RecordingMarker::default();

        let result = process_with_broken_sqlite(&world_model, &marker)
            .await
            .expect("the window completes");

        assert!(result.world_model_projected);
        assert_eq!(result.events_stored, 0);
        assert!(result.task_completions.is_empty());

        // Only the failure mark: the messages are not cleared afterwards.
        let marks = marker.marks.lock().expect("lock");
        assert_eq!(marks.len(), 1, "{marks:?}");
        assert_eq!(marks[0].0, ["m5", "m6"]);
        assert!(marks[0].1, "the messages stay pending");
        assert!(marks[0]
            .2
            .as_deref()
            .is_some_and(|text| text.contains("no such table")));

        let queued = world_model.enqueued.lock().expect("lock");
        assert_eq!(queued.len(), 1, "{queued:?}");
        assert_eq!(queued[0].projection_type, "sqlite_knowledge");
        assert_eq!(queued[0].source_observation_id.as_deref(), Some("obs-1"));
        assert!(queued[0].error_message.contains("no such table"));
    }

    /// World model off: the same SQLite failure is an error of the window. Nothing
    /// is marked and nothing is queued, because there is no retry path.
    #[tokio::test]
    async fn a_failed_sqlite_write_is_an_error_when_the_world_model_is_off() {
        let world_model = FakeWorldModel::default();
        let marker = RecordingMarker::default();

        let error = process_with_broken_sqlite(&world_model, &marker)
            .await
            .expect_err("the window fails");

        assert!(matches!(error, ProcessWindowError::Knowledge(_)), "{error}");
        assert!(marker.marks.lock().expect("lock").is_empty());
        assert!(world_model.enqueued.lock().expect("lock").is_empty());
    }
}
