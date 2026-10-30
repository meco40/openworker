//! Port of `src/server/knowledge/ingestion/factExtractor.ts` (1-359).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `CorrectionResult` (`:26-30`) | [`CorrectionResult`] (the type is [`CorrectionType`], not a string) |
//! | `FactProcessingContext` / `FactProcessingResult` (`:32-46`) | [`FactProcessingContext`], [`FactStorageResult`] |
//! | `detectCorrections` (`:51-66`) | [`detect_corrections`] |
//! | `processFacts` (`:71-85`) | [`process_facts`] |
//! | `processMeetingLedger` (`:90-124`) | [`process_meeting_ledger`] |
//! | `storeFacts` (`:129-359`) | [`store_facts`] |
//! | `MemoryServiceLike` / `KnowledgeRepositoryLike` arguments | [`MemoryFactService`], [`WorldModelPort`] |
//! | `isMem0FactualWriteBlocked()` (`:24`) | [`WorldModelPort::is_mem0_factual_write_blocked`] |
//!
//! # Deviations
//!
//! * `storeFacts` takes a `repo` argument that the TypeScript never reads. The
//!   port drops it.
//! * Metadata is a JSON map, as in the TypeScript. The `sourceSeqStart` and
//!   `sourceSeqEnd` values are JSON numbers.
//! * `Promise.race` with a timer becomes [`tokio::time::timeout`]. Dropping the
//!   store future cancels it, which is what `controller.abort()` does there.
//! * `console.warn` and `console.log` become `tracing` events.

use std::time::Duration;

use serde_json::{json, Map, Value};
use tracing::{info, warn};

use crate::knowledge::contradiction_detector::detect_contradiction_signal;
use crate::knowledge::correction_detector::{detect_correction, CorrectionType};
use crate::knowledge::emotion_tracker::EmotionalState;
use crate::knowledge::extractor::{detect_fact_subject, FactSubject, KnowledgeExtractionResult};
use crate::knowledge::ingestion::constants::{
    DEFAULT_TOPIC_KEY, MEM0_MAX_CONSECUTIVE_FAILURES_PER_WINDOW, MEM0_STORE_FACT_TIMEOUT_MS,
};
use crate::knowledge::ingestion::quality_checks::{
    collect_user_rule_evidence_texts, infer_source_end, infer_source_start,
    keep_only_evidence_backed_rule_statements,
};
use crate::knowledge::ingestion::types::{FactStoreInput, MemoryFactError, MemoryFactService};
use crate::knowledge::ingestion::world_model_port::WorldModelPort;
use crate::knowledge::ingestion_cursor::IngestionWindow;
use crate::knowledge::js_compat::js_slice_prefix;
use crate::knowledge::repositories::now_iso;
use crate::knowledge::text_quality::sanitize_knowledge_facts;
use crate::memory::lifecycle::{transition_lifecycle, LifecycleSignal, LifecycleStatus};
use crate::memory::poisoning::{check_memory_poisoning, PoisoningRiskLevel};
use crate::memory::utils::create_memory_idempotency_key;

/// A correction found in a user message (`factExtractor.ts:26-30`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorrectionResult {
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    pub correction_type: CorrectionType,
}

/// `FactProcessingContext` (`factExtractor.ts:32-37`).
#[derive(Debug, Clone)]
pub struct FactProcessingContext<'a> {
    pub window: &'a IngestionWindow,
    pub extraction: &'a KnowledgeExtractionResult,
    pub dominant_emotion: Option<EmotionalState>,
    pub corrections: Vec<CorrectionResult>,
}

/// The result of `storeFacts` (`factExtractor.ts:140-145`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FactStorageResult {
    pub fail_count: usize,
    pub skipped_count: usize,
    /// Facts that were not persisted and must be retried before checkpointing.
    pub pending_count: usize,
    pub memory_ids: Vec<String>,
}

/// The four meeting-ledger lists after the evidence check.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MeetingLedgerItems {
    pub decisions: Vec<String>,
    pub negotiated_terms: Vec<String>,
    pub open_points: Vec<String>,
    pub action_items: Vec<String>,
}

/// `detectCorrections(window)` (`factExtractor.ts:51-66`): corrections in the
/// user messages, in order.
pub fn detect_corrections(window: &IngestionWindow) -> Vec<CorrectionResult> {
    window
        .messages
        .iter()
        .filter(|message| message.role == "user")
        .filter_map(|message| {
            let result = detect_correction(&message.content);
            result.is_correction.then_some(CorrectionResult {
                old_value: result.old_value,
                new_value: result.new_value,
                correction_type: result.correction_type,
            })
        })
        .collect()
}

/// `processFacts(extraction, window)` (`factExtractor.ts:71-85`): sanitised
/// facts, minus the rule statements that have no user evidence.
pub fn process_facts(
    extraction: &KnowledgeExtractionResult,
    window: &IngestionWindow,
) -> Vec<String> {
    let evidence = collect_user_rule_evidence_texts(window, &extraction.meeting_ledger.source_refs);
    keep_only_evidence_backed_rule_statements(
        &sanitize_knowledge_facts(&extraction.facts),
        &evidence,
    )
}

/// `processMeetingLedger(extraction, window)` (`factExtractor.ts:90-124`).
pub fn process_meeting_ledger(
    extraction: &KnowledgeExtractionResult,
    window: &IngestionWindow,
) -> MeetingLedgerItems {
    let evidence = collect_user_rule_evidence_texts(window, &extraction.meeting_ledger.source_refs);
    let ledger = &extraction.meeting_ledger;
    MeetingLedgerItems {
        decisions: keep_only_evidence_backed_rule_statements(&ledger.decisions, &evidence),
        negotiated_terms: keep_only_evidence_backed_rule_statements(
            &ledger.negotiated_terms,
            &evidence,
        ),
        open_points: keep_only_evidence_backed_rule_statements(&ledger.open_points, &evidence),
        action_items: keep_only_evidence_backed_rule_statements(&ledger.action_items, &evidence),
    }
}

/// A fact after the synchronous checks, with its metadata.
#[derive(Debug, Clone)]
struct PreparedFact {
    fact: String,
    metadata: Map<String, Value>,
}

/// The `lifecycleStatus` of a metadata map, if it is a string.
fn lifecycle_status_of(metadata: Option<&Map<String, Value>>) -> Option<&str> {
    metadata
        .and_then(|map| map.get("lifecycleStatus"))
        .and_then(Value::as_str)
}

/// Phase 1b of `storeFacts`: a fact that contradicts an already persisted fact
/// supersedes that fact. A failure here is logged by the caller and does not
/// stop the store.
async fn maintain_persisted_contradictions<M: MemoryFactService + ?Sized>(
    memory: &M,
    window: &IngestionWindow,
    prepared: &mut [PreparedFact],
) -> Result<(), MemoryFactError> {
    let existing = memory
        .list_fact_nodes(&window.persona_id, &window.user_id, 200)
        .await?;
    for prepared_fact in prepared.iter_mut() {
        let prior = existing.iter().find(|node| {
            detect_contradiction_signal(&prepared_fact.fact, &node.content).has_contradiction
                && lifecycle_status_of(node.metadata.as_ref()) != Some("superseded")
        });
        let Some(prior) = prior else {
            continue;
        };
        let prior_id = prior.id.clone();

        prepared_fact
            .metadata
            .insert("contradictionDetected".into(), Value::Bool(true));
        prepared_fact
            .metadata
            .insert("supersedesMemoryId".into(), Value::String(prior_id.clone()));
        prepared_fact
            .metadata
            .insert("lifecycleStatus".into(), json!("confirmed"));
        prepared_fact
            .metadata
            .insert("lifecycleSignal".into(), json!("user_confirmed"));

        let mut patch = Map::new();
        patch.insert("lifecycleStatus".into(), json!("superseded"));
        patch.insert("lifecycleSignal".into(), json!("contradicted"));
        patch.insert(
            "supersededBy".into(),
            Value::String(prepared_fact.fact.clone()),
        );
        patch.insert("lastVerified".into(), Value::String(now_iso()));
        memory
            .update_memory_metadata(&window.persona_id, &prior_id, &window.user_id, patch)
            .await?;
    }
    Ok(())
}

/// `storeFacts(memoryService, repo, facts, context)` (`factExtractor.ts:129-359`).
///
/// Phase 1 checks and annotates each fact. Phase 1b supersedes persisted
/// contradictions. In canonical mode the factual write is blocked and counted as
/// skipped. Phase 2 stores the facts one by one with a per-fact timeout and a
/// per-window circuit breaker.
pub async fn store_facts<M, W>(
    memory: Option<&M>,
    facts: &[String],
    context: &FactProcessingContext<'_>,
    world_model: &W,
) -> FactStorageResult
where
    M: MemoryFactService + Sync + ?Sized,
    W: WorldModelPort + Sync + ?Sized,
{
    let Some(memory) = memory else {
        return FactStorageResult {
            fail_count: 0,
            skipped_count: facts.len(),
            pending_count: facts.len(),
            memory_ids: Vec::new(),
        };
    };

    let window = context.window;
    let extraction = context.extraction;
    let topic_key = match extraction.meeting_ledger.topic_key.trim() {
        "" => DEFAULT_TOPIC_KEY.to_string(),
        trimmed => trimmed.to_string(),
    };
    let source_seq_start = infer_source_start(window);
    let source_seq_end = infer_source_end(window);

    // ── Phase 1: pre-process every fact (metadata and guards) ──────────────
    let mut prepared: Vec<PreparedFact> = Vec::new();
    let mut skipped_count = 0usize;

    for fact in facts {
        // Memory poisoning guard.
        let poisoning = check_memory_poisoning(fact);
        if poisoning.risk_level == PoisoningRiskLevel::Blocked {
            warn!(
                reason = poisoning.reason.as_deref().unwrap_or(""),
                fact = js_slice_prefix(fact, 80).as_str(),
                "[KnowledgeIngestion] poisoning guard blocked fact"
            );
            skipped_count += 1;
            continue;
        }

        let subject = detect_fact_subject(fact);
        let mut metadata = Map::new();
        metadata.insert("topicKey".into(), Value::String(topic_key.clone()));
        metadata.insert(
            "conversationId".into(),
            Value::String(window.conversation_id.clone()),
        );
        metadata.insert("sourceSeqStart".into(), json!(source_seq_start));
        metadata.insert("sourceSeqEnd".into(), json!(source_seq_end));
        metadata.insert("subject".into(), json!(subject.as_str()));
        let source_role = match subject {
            FactSubject::Assistant => "assistant",
            FactSubject::User => "user",
            FactSubject::Conversation => "mixed",
        };
        metadata.insert("sourceRole".into(), json!(source_role));
        metadata.insert("sourceType".into(), json!("knowledge_ingestion"));
        metadata.insert("artifactType".into(), json!("fact"));
        metadata.insert(
            "selfReference".into(),
            Value::Bool(subject == FactSubject::Assistant),
        );

        if poisoning.risk_level == PoisoningRiskLevel::Suspicious {
            metadata.insert("securityFlag".into(), json!("suspicious"));
            metadata.insert(
                "securityReason".into(),
                poisoning
                    .reason
                    .clone()
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            );
        }

        if let Some(emotion) = &context.dominant_emotion {
            metadata.insert("emotionalTone".into(), json!(emotion.emotion));
            metadata.insert("emotionIntensity".into(), json!(emotion.intensity));
            if let Some(trigger) = &emotion.trigger {
                metadata.insert("emotionTrigger".into(), json!(trigger));
            }
        }

        if !context.corrections.is_empty() {
            metadata.insert("hasCorrections".into(), Value::Bool(true));
            metadata.insert("correctionCount".into(), json!(context.corrections.len()));
        }

        // Within-batch contradiction against the facts prepared so far.
        for previous in prepared.iter_mut() {
            let signal = detect_contradiction_signal(fact, &previous.fact);
            if signal.has_contradiction {
                metadata.insert("contradictionDetected".into(), Value::Bool(true));
                metadata.insert(
                    "contradictionType".into(),
                    json!(signal.contradiction_type.as_str()),
                );
                metadata.insert("contradictionConfidence".into(), json!(signal.confidence));
                metadata.insert("supersedes".into(), Value::String(previous.fact.clone()));
                let superseded =
                    transition_lifecycle(LifecycleStatus::New, LifecycleSignal::Contradicted);
                previous
                    .metadata
                    .insert("lifecycleStatus".into(), json!(superseded.as_str()));
                previous
                    .metadata
                    .insert("lifecycleSignal".into(), json!("contradicted"));
                previous
                    .metadata
                    .insert("supersededBy".into(), Value::String(fact.clone()));
                metadata.insert(
                    "supersededFactLifecycleStatus".into(),
                    json!(superseded.as_str()),
                );
                break;
            }
        }

        let mut lifecycle_status = LifecycleStatus::New;
        if !context.corrections.is_empty() {
            // The correction is the active replacement.
            lifecycle_status = LifecycleStatus::Confirmed;
            metadata.insert("lifecycleSignal".into(), json!("user_confirmed"));
        }
        metadata.insert("lifecycleStatus".into(), json!(lifecycle_status.as_str()));
        metadata.insert(
            "idempotencyKey".into(),
            json!(create_memory_idempotency_key(&[
                Some("knowledge-fact".to_string()),
                Some(window.user_id.clone()),
                Some(window.persona_id.clone()),
                Some(window.conversation_id.clone()),
                Some(source_seq_start.to_string()),
                Some(source_seq_end.to_string()),
                Some(fact.clone()),
            ])),
        );

        prepared.push(PreparedFact {
            fact: fact.clone(),
            metadata,
        });
    }

    if prepared.is_empty() {
        return FactStorageResult {
            fail_count: 0,
            skipped_count,
            pending_count: 0,
            memory_ids: Vec::new(),
        };
    }

    // Phase 1b: supersede contradicted facts that are already persisted.
    if let Err(error) = maintain_persisted_contradictions(memory, window, &mut prepared).await {
        warn!(
            error = %error,
            "[KnowledgeIngestion] persisted contradiction maintenance skipped"
        );
    }

    // ── Phase 2: store sequentially with a per-window circuit breaker ──────
    // In canonical mode factual facts are not written to Mem0; PostgreSQL is the
    // source of truth. The window counts as projected so the checkpoint advances.
    if world_model.is_mem0_factual_write_blocked() {
        let blocked_count = prepared.len();
        info!(
            blocked_count,
            "[KnowledgeIngestion] canonical mode: blocked factual Mem0 write(s); facts are already canonical in PostgreSQL"
        );
        return FactStorageResult {
            fail_count: 0,
            skipped_count: skipped_count + blocked_count,
            pending_count: 0,
            memory_ids: Vec::new(),
        };
    }

    let timeout = Duration::from_millis(*MEM0_STORE_FACT_TIMEOUT_MS);
    let mut fail_count = 0usize;
    let mut pending_count = 0usize;
    let mut consecutive_failures = 0usize;
    let mut memory_ids: Vec<String> = Vec::new();

    for index in 0..prepared.len() {
        // Per-window circuit breaker.
        if consecutive_failures >= MEM0_MAX_CONSECUTIVE_FAILURES_PER_WINDOW {
            let remaining = prepared.len() - index;
            warn!(
                consecutive_failures,
                remaining,
                "[KnowledgeIngestion] Per-window circuit breaker open; skipping remaining fact(s)."
            );
            skipped_count += remaining;
            pending_count += remaining;
            break;
        }

        let fact = &prepared[index];
        let input = FactStoreInput {
            persona_id: window.persona_id.clone(),
            content: fact.fact.clone(),
            importance: 4,
            user_id: window.user_id.clone(),
            metadata: fact.metadata.clone(),
        };
        match tokio::time::timeout(timeout, memory.store_fact(input)).await {
            Ok(Ok(stored_id)) => {
                if let Some(id) = stored_id {
                    memory_ids.push(id);
                }
                consecutive_failures = 0;
            }
            Ok(Err(error)) => {
                fail_count += 1;
                pending_count += 1;
                consecutive_failures += 1;
                warn!(
                    index = index + 1,
                    total = prepared.len(),
                    error = %error,
                    "[KnowledgeIngestion] Mem0 store failed for fact"
                );
            }
            Err(_elapsed) => {
                fail_count += 1;
                pending_count += 1;
                consecutive_failures += 1;
                warn!(
                    timeout_ms = *MEM0_STORE_FACT_TIMEOUT_MS,
                    "[KnowledgeIngestion] Mem0 fact store timeout"
                );
            }
        }
    }

    // ── Phase 3: summary ──────────────────────────────────────────────────
    if fail_count > 0 {
        warn!(
            persona_id = window.persona_id.as_str(),
            seq_start = source_seq_start,
            seq_end = source_seq_end,
            failed = fail_count,
            total = prepared.len(),
            "[KnowledgeIngestion] Mem0 store summary for window"
        );
    }

    FactStorageResult {
        fail_count,
        skipped_count,
        pending_count,
        memory_ids,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::extractor::KnowledgeMeetingLedger;
    use crate::messages_store::StoredMessage;

    use crate::knowledge::ingestion::test_support::{FakeMemory, FakeWorldModel};

    fn window(messages: Vec<StoredMessage>) -> IngestionWindow {
        IngestionWindow {
            conversation_id: "c-1".into(),
            user_id: "u-1".into(),
            persona_id: "p-1".into(),
            workspace_id: None,
            from_seq_exclusive: 0,
            to_seq_inclusive: 2,
            messages,
        }
    }

    fn user_message(seq: i64, content: &str) -> StoredMessage {
        StoredMessage {
            id: format!("m{seq}"),
            conversation_id: "c-1".into(),
            seq: Some(seq),
            role: "user".into(),
            content: content.into(),
            platform: "web".into(),
            external_msg_id: None,
            sender_name: None,
            metadata: None,
            created_at: String::new(),
        }
    }

    fn extraction() -> KnowledgeExtractionResult {
        KnowledgeExtractionResult {
            facts: vec![],
            teaser: String::new(),
            episode: String::new(),
            meeting_ledger: KnowledgeMeetingLedger {
                topic_key: String::new(),
                counterpart: None,
                participants: vec![],
                decisions: vec![],
                negotiated_terms: vec![],
                open_points: vec![],
                action_items: vec![],
                source_refs: vec![],
                confidence: 0.6,
            },
            events: vec![],
            entities: vec![],
        }
    }

    fn context<'a>(
        window: &'a IngestionWindow,
        extraction: &'a KnowledgeExtractionResult,
    ) -> FactProcessingContext<'a> {
        FactProcessingContext {
            window,
            extraction,
            dominant_emotion: None,
            corrections: vec![],
        }
    }

    #[test]
    fn a_correction_is_detected_only_in_user_messages() {
        let corrections = detect_corrections(&window(vec![
            user_message(1, "Nein, das war nicht Lisa, sondern Maria"),
            StoredMessage {
                role: "agent".into(),
                ..user_message(2, "Nein, das war nicht Lisa, sondern Maria")
            },
        ]));
        assert_eq!(corrections.len(), 1);
        assert_eq!(corrections[0].correction_type, CorrectionType::ValueChange);
    }

    #[tokio::test]
    async fn without_a_memory_service_every_fact_is_skipped_and_pending() {
        let w = window(vec![]);
        let ex = extraction();
        let facts = vec!["Ich wohne in Berlin".to_string()];
        let result = store_facts::<FakeMemory, FakeWorldModel>(
            None,
            &facts,
            &context(&w, &ex),
            &FakeWorldModel {
                blocked: false,
                ..Default::default()
            },
        )
        .await;
        assert_eq!(
            result,
            FactStorageResult {
                fail_count: 0,
                skipped_count: 1,
                pending_count: 1,
                memory_ids: vec![]
            }
        );
    }

    #[tokio::test]
    async fn in_canonical_mode_the_factual_write_is_blocked_and_counted_as_skipped() {
        let w = window(vec![]);
        let ex = extraction();
        let facts = vec!["Ich wohne in Berlin".to_string()];
        let result = store_facts(
            Some(&FakeMemory),
            &facts,
            &context(&w, &ex),
            &FakeWorldModel {
                blocked: true,
                ..Default::default()
            },
        )
        .await;
        assert_eq!(
            result,
            FactStorageResult {
                fail_count: 0,
                skipped_count: 1,
                pending_count: 0,
                memory_ids: vec![]
            }
        );
    }

    #[tokio::test]
    async fn stored_facts_return_their_memory_ids() {
        let w = window(vec![]);
        let ex = extraction();
        let facts = vec!["Ich wohne in Berlin".to_string()];
        let result = store_facts(
            Some(&FakeMemory),
            &facts,
            &context(&w, &ex),
            &FakeWorldModel {
                blocked: false,
                ..Default::default()
            },
        )
        .await;
        assert_eq!(result.fail_count, 0);
        assert_eq!(result.pending_count, 0);
        assert_eq!(result.memory_ids.len(), 1);
    }
}
