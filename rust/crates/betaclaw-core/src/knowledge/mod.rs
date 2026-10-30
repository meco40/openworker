//! Slice S7 (Knowledge).
//!
//! Port of `src/server/knowledge/`. The directory layout mirrors the
//! TypeScript tree so a reviewer can diff one Rust file against its TypeScript
//! original:
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`config`] | `config.ts` |
//! | [`event_types`] | `eventTypes.ts` |
//! | [`entity_graph`] | `entityGraph.ts` |
//! | [`repository`] | `repository.ts` |
//! | [`repositories`] | `repositories/*.ts` |
//! | [`sqlite_knowledge_repository`] | `sqliteKnowledgeRepository.ts` |
//! | [`token_budget`], [`answer_safety_policy`], [`recall_budget_calculator`], [`recall_scoring`], [`persona_strategies`], [`query_planner`], [`event_answer_computer`] | the same-named `*.ts` at the knowledge root (ported as dependencies of `retrieval/**`) |
//! | [`retrieval`] | `retrieval/**` |
//! | [`ingestion`] | `ingestion/**` (World Model seams: [`ingestion::world_model_port`]) |
//! | [`ingestion_cursor`], [`extractor`], [`prompts`], [`entity_extractor`], [`event_extractor`], [`event_dedup`], [`history_summarizer`], [`text_quality`], [`time_resolver`] | the same-named `*.ts` at the knowledge root |
//! | [`security`] | `security/**` |
//! | [`runtime`], [`runtime_loop`] | `runtime.ts` (functions only), `runtimeLoop.ts` |
//! | [`js_compat`] | Rust-only: the JavaScript coercions the TypeScript relies on |
//!
//! # Scope of this port
//!
//! The four `ingestion/` files that depend on the World Model are ported against
//! [`ingestion::world_model_port::WorldModelPort`]. The S6 lane implements that
//! trait. The memory side uses [`ingestion::types::MemoryFactService`] and
//! [`runtime::MemorySnapshot`], which the S5 lane implements.
//!
//! Not ported here: the `globalThis` singletons and the factories of
//! `runtime.ts` (see the module header of [`runtime`]).
//!
//! # Rust-only helpers
//!
//! [`create_id`] replaces `createId` of `src/shared/lib/ids.ts`. The random part
//! is hex instead of base-36. Ids are opaque, so no reader depends on the spelling.

use crate::knowledge::repositories::{js_now_millis, random_hex};

pub mod answer_safety_policy;
pub mod cleanup_detector;
pub mod config;
pub mod contradiction_detector;
pub mod conversation_summary_prompts;
pub mod correction_detector;
pub mod emotion_tracker;
pub mod entity_extractor;
pub mod entity_graph;
pub mod event_answer_computer;
pub mod event_dedup;
pub mod event_extractor;
pub mod event_types;
pub mod extractor;
pub mod fact_lifecycle;
pub mod history_summarizer;
pub mod ingestion;
pub mod ingestion_cursor;
pub mod inline_ingestion_policy;
pub mod js_compat;
pub mod message_ordering_guard;
pub mod multilingual_aliases;
pub mod persona_isolation_policy;
pub mod persona_strategies;
pub mod persona_type_detector;
pub mod project_tracker;
pub mod prompts;
pub mod pronoun_resolver;
pub mod query_planner;
pub mod recall_budget_calculator;
pub mod recall_scoring;
pub mod reconciliation;
pub mod recurrence_detector;
pub mod repositories;
pub mod repository;
pub mod retrieval;
pub mod runtime;
pub mod runtime_loop;
pub mod security;
pub mod sqlite_knowledge_repository;
pub mod task_tracker;
pub mod text_quality;
pub mod time_resolver;
pub mod token_budget;

/// `createId(prefix)` (`src/shared/lib/ids.ts:1-4`): `prefix-<epoch millis>-<random>`.
pub(crate) fn create_id(prefix: &str) -> String {
    format!("{prefix}-{}-{}", js_now_millis(), random_hex(4))
}
