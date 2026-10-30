//! Port of `src/server/knowledge/retrieval/service/knowledgeRetrievalService.ts`
//! (1-41).
//!
//! | TypeScript                                                  | Rust |
//! | ----------------------------------------------------------- | ---- |
//! | `service/knowledgeRetrievalService.ts:13-41` (`KnowledgeRetrievalService`) | [`KnowledgeRetrievalService`] |
//!
//! # Deviations
//!
//! 1. **The cache lives behind `&mut self` on `shouldTriggerRecall`.** The
//!    TypeScript mutates a `Map` field from an `async` method; the port needs
//!    `&mut self` for the same effect ([`get_known_counterparts`]).
//! 2. **`maxContextTokens` normalisation.** `Math.max(1, Math.floor(options.maxContextTokens || 1200))`
//!    (`:19`): only `0` (and `null`/`undefined`) is falsy, so the port maps `0`
//!    to `1200` and clamps the rest to `>= 1`; the value is kept as `f64` for the
//!    budget arithmetic.
//! 3. **Synchronous.** Both methods await nothing in the crate's synchronous
//!    memory/repository seams (`retrievalExecution.ts` deviation 1).

use std::collections::HashMap;

use crate::knowledge::retrieval::service::constants::COUNTERPART_CACHE_TTL_MS;
use crate::knowledge::retrieval::service::counterpart_cache::{
    get_known_counterparts, CounterpartCacheEntry, GetKnownCounterpartsArgs,
};
use crate::knowledge::retrieval::service::query_planning::should_trigger_recall_for_query;
use crate::knowledge::retrieval::service::retrieval_execution::{
    execute_knowledge_retrieval, ExecuteKnowledgeRetrievalArgs,
};
use crate::knowledge::retrieval::types::{
    KnowledgeRecallProbeInput, KnowledgeRetrievalInput, KnowledgeRetrievalResult,
    KnowledgeRetrievalServiceOptions, RetrievalResult,
};

/// `KnowledgeRetrievalService` from `service/knowledgeRetrievalService.ts:13-41`.
pub struct KnowledgeRetrievalService<'a> {
    max_context_tokens: f64,
    counterpart_cache: HashMap<String, CounterpartCacheEntry>,
    counterpart_cache_ttl_ms: f64,
    options: &'a KnowledgeRetrievalServiceOptions<'a>,
}

impl<'a> KnowledgeRetrievalService<'a> {
    /// `constructor` from `service/knowledgeRetrievalService.ts:18-20`.
    pub fn new(options: &'a KnowledgeRetrievalServiceOptions<'a>) -> Self {
        let base = if options.max_context_tokens == 0 {
            1200
        } else {
            options.max_context_tokens
        };
        Self {
            max_context_tokens: base.max(1) as f64,
            counterpart_cache: HashMap::new(),
            counterpart_cache_ttl_ms: COUNTERPART_CACHE_TTL_MS,
            options,
        }
    }

    /// `shouldTriggerRecall` from `service/knowledgeRetrievalService.ts:22-32`.
    pub fn should_trigger_recall(
        &mut self,
        input: &KnowledgeRecallProbeInput,
    ) -> RetrievalResult<bool> {
        let known_counterparts = get_known_counterparts(GetKnownCounterpartsArgs {
            user_id: &input.user_id,
            persona_id: &input.persona_id,
            cache: &mut self.counterpart_cache,
            ttl_ms: self.counterpart_cache_ttl_ms,
            knowledge_repository: self.options.knowledge_repository,
        })?;
        Ok(should_trigger_recall_for_query(input, &known_counterparts))
    }

    /// `retrieve` from `service/knowledgeRetrievalService.ts:34-40`.
    pub fn retrieve(
        &self,
        input: &KnowledgeRetrievalInput,
    ) -> RetrievalResult<KnowledgeRetrievalResult> {
        execute_knowledge_retrieval(&ExecuteKnowledgeRetrievalArgs {
            input,
            options: self.options,
            max_context_tokens: self.max_context_tokens,
        })
    }
}
