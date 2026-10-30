//! Port of `src/server/knowledge/retrieval/service/index.ts` (1-20) — the
//! retrieval service entrypoint.
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`knowledge_retrieval_service`] | `service/knowledgeRetrievalService.ts` |
//! | [`types`] | `service/types.ts` |
//! | [`constants`] | `service/constants.ts` |
//! | [`counterpart_cache`] | `service/counterpartCache.ts` |
//! | [`query_planning`] | `service/queryPlanning.ts` |
//! | [`retrieval_execution`] | `service/retrievalExecution.ts` |
//! | [`rule_evidence_collector`] | `service/ruleEvidenceCollector.ts` |
//! | [`query`] | `service/query/**` |
//! | [`ranking`] | `service/ranking/**` |
//! | [`formatters`] | `service/formatters/**` |

pub mod constants;
pub mod counterpart_cache;
pub mod formatters;
pub mod knowledge_retrieval_service;
pub mod query;
pub mod query_planning;
pub mod ranking;
pub mod retrieval_execution;
pub mod rule_evidence_collector;
pub mod types;

// index.ts:6
pub use knowledge_retrieval_service::KnowledgeRetrievalService;
// index.ts:8-14
pub use crate::knowledge::retrieval::types::{
    KnowledgeRecallProbeInput, KnowledgeRetrievalInput, KnowledgeRetrievalResult,
    KnowledgeRetrievalSections, KnowledgeRetrievalServiceOptions,
};
// index.ts:16-20
pub use constants::*;
pub use formatters::*;
pub use query::*;
pub use ranking::*;
pub use types::*;
