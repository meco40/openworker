//! Port of `src/server/knowledge/retrieval/service/counterpartCache.ts` (1-46).
//!
//! | TypeScript                                                | Rust |
//! | --------------------------------------------------------- | ---- |
//! | `service/counterpartCache.ts:4-7` (`CounterpartCacheEntry`) | [`CounterpartCacheEntry`] |
//! | `service/counterpartCache.ts:9-15` (`GetKnownCounterpartsArgs`) | [`GetKnownCounterpartsArgs`] |
//! | `service/counterpartCache.ts:17-46` (`getKnownCounterparts`) | [`get_known_counterparts`] |
//!
//! # Deviations
//!
//! 1. **`Date.now()` is injected.** [`get_known_counterparts_at`] takes the
//!    instant so the cache TTL is deterministic in tests; the public
//!    [`get_known_counterparts`] reads the clock.
//! 2. **The repository can fail.** `listMeetingLedger`/`listEpisodes` throw in the
//!    TypeScript; the port returns [`RetrievalResult`].
//! 3. `value.length >= 2` is UTF-16 through
//!    [`crate::knowledge::retrieval::js_str_len`].

use std::collections::HashMap;

use crate::knowledge::repository::ListKnowledgeFilter;
use crate::knowledge::retrieval::js_str_len;
use crate::knowledge::retrieval::ranking::episode_ranker::now_millis;
use crate::knowledge::retrieval::types::{RetrievalKnowledgeRepository, RetrievalResult};
use crate::knowledge::retrieval::utils::unique_strings;

/// `CounterpartCacheEntry` from `service/counterpartCache.ts:4-7`.
#[derive(Debug, Clone, PartialEq)]
pub struct CounterpartCacheEntry {
    pub counterparts: Vec<String>,
    /// `expiresAt` is a JavaScript `Date.now()` value (milliseconds).
    pub expires_at: f64,
}

/// `GetKnownCounterpartsArgs` from `service/counterpartCache.ts:9-15`.
pub struct GetKnownCounterpartsArgs<'a> {
    pub user_id: &'a str,
    pub persona_id: &'a str,
    pub cache: &'a mut HashMap<String, CounterpartCacheEntry>,
    pub ttl_ms: f64,
    pub knowledge_repository: &'a dyn RetrievalKnowledgeRepository,
}

/// `getKnownCounterparts` from `service/counterpartCache.ts:17-46` at a fixed
/// instant.
pub fn get_known_counterparts_at(
    args: GetKnownCounterpartsArgs<'_>,
    now_ms: f64,
) -> RetrievalResult<Vec<String>> {
    let cache_key = format!("{}::{}", args.user_id, args.persona_id);
    if let Some(cached) = args.cache.get(&cache_key) {
        if cached.expires_at > now_ms {
            return Ok(cached.counterparts.clone());
        }
    }

    let filter = ListKnowledgeFilter {
        user_id: args.user_id.to_string(),
        persona_id: args.persona_id.to_string(),
        limit: Some(60),
        ..ListKnowledgeFilter::default()
    };
    let ledger_rows = args.knowledge_repository.list_meeting_ledger(&filter)?;
    let episodes = args.knowledge_repository.list_episodes(&filter)?;

    let mut candidates: Vec<String> = Vec::new();
    for row in &ledger_rows {
        candidates.push(
            row.counterpart
                .clone()
                .unwrap_or_default()
                .trim()
                .to_string(),
        );
    }
    for row in &episodes {
        candidates.push(
            row.counterpart
                .clone()
                .unwrap_or_default()
                .trim()
                .to_string(),
        );
    }
    let counterparts: Vec<String> = unique_strings(candidates)
        .into_iter()
        .filter(|value| js_str_len(value) >= 2)
        .collect();

    args.cache.insert(
        cache_key,
        CounterpartCacheEntry {
            counterparts: counterparts.clone(),
            expires_at: now_ms + args.ttl_ms,
        },
    );

    Ok(counterparts)
}

/// `getKnownCounterparts` from `service/counterpartCache.ts:17-46`.
pub fn get_known_counterparts(args: GetKnownCounterpartsArgs<'_>) -> RetrievalResult<Vec<String>> {
    let now = now_millis();
    get_known_counterparts_at(args, now)
}
