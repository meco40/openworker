//! Port of `src/server/world-model/retrieval/hybridRanker.ts` (49 lines).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `hybridRanker.ts:1` (`RankSource`) | [`RankSource`] |
//! | `hybridRanker.ts:3-9` (`RankCandidate`) | [`RankCandidate`] |
//! | `hybridRanker.ts:11-13` (`RankedHit`) | [`RankedHit`] |
//! | `hybridRanker.ts:23-41` (`hybridRank`) | [`hybrid_rank`] |
//! | `hybridRanker.ts:48-54` (`suppressInactiveBeforeLowerSource`) | [`suppress_inactive_before_lower_source`] |
//!
//! # Verified TypeScript quirks
//!
//! * `intentBonus` (`:36`) tests the *truthiness* of `queryIntent`, not its
//!   presence: `queryIntent: ''` is falsy and gets the `1.0` multiplier, so the
//!   port tests `Some(value) if !value.is_empty() && value != "generic"`.
//! * `triage[candidate.source] ?? 0` (`:34`) and `order[hit.source] ?? 2`
//!   (`:53`) look up a total record over the three-member union, so the
//!   fallbacks are unreachable in TypeScript; the Rust enum covers all three
//!   arms and the fallbacks disappear.
//! * `Array#sort` is stable since ES2019 and Rust's `slice::sort_by` is stable,
//!   so equal `combined` values keep their insertion order in both.
//! * The comparator is `b.combined - a.combined`; a `NaN` difference makes both
//!   `< 0` and `> 0` false, which the sort treats as "equal".
//!   [`compare_combined`] maps a `NaN` to `Ordering::Equal` for that effect.
//! * `combined` is `(sourceWeight + score) * stateMultiplier * intentBonus`, a
//!   plain JavaScript number product — no clamping, and an infinite `score`
//!   stays infinite (IEEE-754, unchanged in Rust).

/// `RankSource` from `hybridRanker.ts:1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RankSource {
    Structured,
    Fulltext,
    Vector,
}

/// `triage` (`:24-28`) — the source priority of the combined score.
fn source_weight(source: RankSource) -> f64 {
    match source {
        RankSource::Structured => 100.0,
        RankSource::Fulltext => 50.0,
        RankSource::Vector => 10.0,
    }
}

/// `order` (`:52`) — the suppression ranking of the sources.
fn source_order(source: RankSource) -> usize {
    match source {
        RankSource::Structured => 0,
        RankSource::Fulltext => 1,
        RankSource::Vector => 2,
    }
}

/// `RankCandidate` from `hybridRanker.ts:3-9`.
#[derive(Debug, Clone, PartialEq)]
pub struct RankCandidate {
    pub id: String,
    pub source: RankSource,
    pub score: f64,
    pub active: bool,
    /// `queryIntent?: string` — an empty string is falsy in the source.
    pub query_intent: Option<String>,
}

/// `RankedHit extends RankCandidate` from `hybridRanker.ts:11-13`.
#[derive(Debug, Clone, PartialEq)]
pub struct RankedHit {
    pub candidate: RankCandidate,
    /// `(sourceWeight + score) * stateMultiplier * intentBonus`.
    pub combined: f64,
}

impl RankedHit {
    pub fn id(&self) -> &str {
        &self.candidate.id
    }

    pub fn source(&self) -> RankSource {
        self.candidate.source
    }

    pub fn active(&self) -> bool {
        self.candidate.active
    }
}

/// The `activeMultiplier` of `hybridRanker.ts:29`.
const ACTIVE_MULTIPLIER: f64 = 1.0;
/// The `inactiveMultiplier` of `hybridRanker.ts:30`.
const INACTIVE_MULTIPLIER: f64 = 0.25;

/// `hybridRank(candidates)` — `hybridRanker.ts:23-41`.
///
/// The combined score is computed for every candidate first and the list is then
/// sorted descending, exactly like the two passes of the source.
pub fn hybrid_rank(candidates: &[RankCandidate]) -> Vec<RankedHit> {
    let mut ranked: Vec<RankedHit> = candidates
        .iter()
        .map(|candidate| {
            let source_weight = source_weight(candidate.source);
            let state_multiplier = if candidate.active {
                ACTIVE_MULTIPLIER
            } else {
                INACTIVE_MULTIPLIER
            };
            let has_intent_bonus = matches!(
                candidate.query_intent.as_deref(),
                Some(intent) if !intent.is_empty() && intent != "generic"
            );
            let intent_bonus = if has_intent_bonus { 0.9 } else { 1.0 };
            RankedHit {
                candidate: candidate.clone(),
                combined: (source_weight + candidate.score) * state_multiplier * intent_bonus,
            }
        })
        .collect();
    ranked.sort_by(compare_combined);
    ranked
}

/// `(a, b) => b.combined - a.combined` — descending, `NaN`-tolerant.
fn compare_combined(left: &RankedHit, right: &RankedHit) -> std::cmp::Ordering {
    right
        .combined
        .partial_cmp(&left.combined)
        .unwrap_or(std::cmp::Ordering::Equal)
}

/// `suppressInactiveBeforeLowerSource(ranked, minActiveSource = 'vector')` —
/// `hybridRanker.ts:48-54`.
///
/// Keeps a hit when it is active *or* when its source ranks before
/// `min_active_source`; with the default `'vector'` every structured and
/// full-text hit survives and an inactive vector hit is dropped.
pub fn suppress_inactive_before_lower_source(
    ranked: &[RankedHit],
    min_active_source: RankSource,
) -> Vec<RankedHit> {
    let min_order = source_order(min_active_source);
    ranked
        .iter()
        .filter(|hit| hit.candidate.active || source_order(hit.candidate.source) < min_order)
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(id: &str, source: RankSource, score: f64, active: bool) -> RankCandidate {
        RankCandidate {
            id: id.to_string(),
            source,
            score,
            active,
            query_intent: None,
        }
    }

    fn with_intent(candidate: RankCandidate, intent: &str) -> RankCandidate {
        RankCandidate {
            query_intent: Some(intent.to_string()),
            ..candidate
        }
    }

    fn ids(ranked: &[RankedHit]) -> Vec<String> {
        ranked.iter().map(|hit| hit.id().to_string()).collect()
    }

    /// `tests/unit/world-model/hybrid-ranking.test.ts:10-27`.
    #[test]
    fn structured_active_ranks_ahead_of_fulltext_ahead_of_vector() {
        let ranked = hybrid_rank(&[
            candidate("v", RankSource::Vector, 0.9, true),
            candidate("ft", RankSource::Fulltext, 0.7, true),
            candidate("s", RankSource::Structured, 0.5, true),
        ]);
        assert_eq!(ids(&ranked), vec!["s", "ft", "v"]);
        assert_eq!(ranked[0].combined, 100.5);
        assert_eq!(ranked[1].combined, 50.7);
        assert_eq!(ranked[2].combined, 10.9);

        let retrieved = hybrid_rank(&[
            candidate("active-assertion", RankSource::Fulltext, 0.4, true),
            candidate("retracted-vector", RankSource::Vector, 0.99, false),
        ]);
        assert_eq!(retrieved[0].id(), "active-assertion");
        assert_eq!(retrieved[1].combined, (10.0 + 0.99) * 0.25);
    }

    /// `tests/unit/world-model/hybrid-ranking.test.ts:29-39` — the bonus is a
    /// `0.9` *multiplier*, so a non-generic intent lowers the score while the
    /// order of two candidates of the same source is unchanged.
    #[test]
    fn the_intent_bonus_multiplies_by_zero_point_nine() {
        let generic = hybrid_rank(&[with_intent(
            candidate("a", RankSource::Vector, 0.5, true),
            "generic",
        )]);
        let specific = hybrid_rank(&[with_intent(
            candidate("b", RankSource::Vector, 0.5, true),
            "what_done",
        )]);
        assert_eq!(generic[0].combined, 10.5);
        assert_eq!(specific[0].combined, 10.5 * 0.9);
        assert!(specific[0].combined < generic[0].combined);
    }

    /// The emptiness rule of `:36`: only a non-empty, non-`generic` intent
    /// earns the multiplier, and an absent intent is the same as `generic`.
    #[test]
    fn an_empty_or_generic_intent_gets_the_full_multiplier() {
        let empty = hybrid_rank(&[with_intent(
            candidate("a", RankSource::Structured, 0.0, true),
            "",
        )]);
        assert_eq!(empty[0].combined, 100.0);
        let absent = hybrid_rank(&[candidate("a", RankSource::Structured, 0.0, true)]);
        assert_eq!(absent[0].combined, 100.0);
        let generic = hybrid_rank(&[with_intent(
            candidate("a", RankSource::Structured, 0.0, true),
            "generic",
        )]);
        assert_eq!(generic[0].combined, 100.0);
    }

    /// `Array#sort` stability — equal scores keep the insertion order.
    #[test]
    fn equal_combined_values_keep_the_insertion_order() {
        let ranked = hybrid_rank(&[
            candidate("first", RankSource::Structured, 0.0, true),
            candidate("second", RankSource::Structured, 0.0, true),
            candidate("third", RankSource::Vector, 10.0, true),
        ]);
        assert_eq!(ids(&ranked), vec!["first", "second", "third"]);

        // A `NaN` difference compares equal, so the insertion order survives
        // and the entry is not dropped.
        let with_nan = hybrid_rank(&[
            candidate("nan", RankSource::Vector, f64::NAN, true),
            candidate("ten", RankSource::Vector, 0.0, true),
        ]);
        assert!(with_nan[0].combined.is_nan());
        assert_eq!(ids(&with_nan), vec!["nan", "ten"]);
    }

    /// `tests/unit/world-model/hybrid-ranking.test.ts:42-52`.
    #[test]
    fn inactive_hits_of_a_lower_source_are_dropped() {
        let ranked = hybrid_rank(&[
            candidate("active-structured", RankSource::Structured, 0.5, true),
            candidate("inactive-vector", RankSource::Vector, 0.9, false),
            candidate("inactive-fulltext", RankSource::Fulltext, 0.9, false),
        ]);
        let filtered = suppress_inactive_before_lower_source(&ranked, RankSource::Vector);
        assert_eq!(
            ids(&filtered),
            vec!["active-structured", "inactive-fulltext"],
            "full-text ranks before the `vector` floor and survives while inactive"
        );

        // A `structured` floor keeps only the active hits.
        let strict = suppress_inactive_before_lower_source(&ranked, RankSource::Structured);
        assert_eq!(ids(&strict), vec!["active-structured"]);
    }

    #[test]
    fn the_source_tables_match_the_records() {
        assert_eq!(source_order(RankSource::Structured), 0);
        assert_eq!(source_order(RankSource::Fulltext), 1);
        assert_eq!(source_order(RankSource::Vector), 2);
        assert_eq!(source_weight(RankSource::Structured), 100.0);
        assert_eq!(source_weight(RankSource::Fulltext), 50.0);
        assert_eq!(source_weight(RankSource::Vector), 10.0);
    }
}
