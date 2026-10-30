//! Port of `src/server/channels/messages/service/recall/utils.ts`, plus the
//! UTF-16 length helpers the TypeScript budgets depend on.
//!
//! Differences from the JavaScript original:
//! - `normalize_for_match` replaces `String.prototype.normalize('NFD')` with
//!   [`NFD_BASE`]. The table covers U+00C0..U+024F and U+1E00..U+1EFF for
//!   lowercase letters, and was generated with Node 24 from
//!   `ch.normalize('NFD').replace(/\p{Diacritic}/gu, '')`. Other scripts are
//!   not decomposed. The workspace has no Unicode-normalization crate and this
//!   port must not add one.
//! - Whitespace uses the Unicode `White_Space` set. JavaScript `\s` also matches
//!   U+FEFF. Chat input does not produce that character in practice.

use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;

use crate::memory::service::{resolve_memory_user_id_candidates, MemoryScopeInput};
use crate::messages_store::{Conversation, SearchMessagesOptions};

use super::types::StrictRecallCandidate;

static DIACRITIC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\p{Diacritic}").expect("static pattern"));
static TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]+").expect("static pattern"));

const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// `Date.now()`: Unix time in milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// JavaScript `string.length`, which counts UTF-16 code units.
pub fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// `value.slice(0, units)` in UTF-16 units.
///
/// JavaScript can cut a surrogate pair in half. A Rust string cannot hold a lone
/// surrogate, so the cut moves back to the previous character boundary.
pub fn utf16_prefix(value: &str, units: usize) -> &str {
    let mut used = 0;
    for (index, ch) in value.char_indices() {
        let width = ch.len_utf16();
        if used + width > units {
            return &value[..index];
        }
        used += width;
    }
    value
}

/// `normalizeForMatch`: lowercase, strip diacritics, `ß` to `ss`, collapse
/// whitespace.
pub fn normalize_for_match(value: &str) -> String {
    let lowered = value.to_lowercase();
    let mut decomposed = String::with_capacity(lowered.len());
    for ch in lowered.chars() {
        match decompose(ch) {
            Some(base) => decomposed.push_str(base),
            None => decomposed.push(ch),
        }
    }
    let stripped = DIACRITIC.replace_all(&decomposed, "");
    stripped
        .replace('ß', "ss")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn decompose(ch: char) -> Option<&'static str> {
    NFD_BASE
        .binary_search_by_key(&ch, |(from, _)| *from)
        .ok()
        .map(|index| NFD_BASE[index].1)
}

/// `tokenizeNormalized`: runs of letters and digits (`[\p{L}\p{N}]+`).
pub fn tokenize_normalized(value: &str) -> Vec<String> {
    TOKEN
        .find_iter(value)
        .map(|found| found.as_str().to_string())
        .collect()
}

/// `countHits`: how many tokens occur as substrings of `text`.
pub fn count_hits(text: &str, tokens: &[String]) -> usize {
    tokens
        .iter()
        .filter(|token| !token.is_empty() && text.contains(token.as_str()))
        .count()
}

/// `hasAnyToken`: whether any of `tokens` occurs in `text`.
pub fn has_any_token(text: &str, tokens: &[&str]) -> bool {
    tokens.iter().any(|token| text.contains(token))
}

/// Parses an ISO timestamp to epoch milliseconds. Only RFC 3339 is accepted,
/// which is the format the stores write. `Date.parse` also takes other shapes.
fn parse_timestamp_ms(value: &str) -> Option<f64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.timestamp_millis() as f64)
}

/// `applyRecencyBoost`: the newest candidate gets +0.7, and each day older
/// costs 0.1, with a floor of 0.
pub fn apply_recency_boost(candidates: &mut [StrictRecallCandidate]) {
    let timestamps: Vec<f64> = candidates
        .iter()
        .filter_map(|candidate| candidate.created_at.as_deref().and_then(parse_timestamp_ms))
        .collect();
    let Some(newest) = timestamps.into_iter().reduce(f64::max) else {
        return;
    };
    for candidate in candidates.iter_mut() {
        let Some(ts) = candidate.created_at.as_deref().and_then(parse_timestamp_ms) else {
            continue;
        };
        let day_distance = ((newest - ts) / DAY_MS).max(0.0);
        candidate.score += (0.7 - day_distance * 0.1).max(0.0);
    }
}

/// `dedupeCandidates`: one entry per normalized text, with the highest score.
/// Output keeps the order of first occurrence, like a JavaScript `Map`. A tie
/// keeps the earlier candidate.
pub fn dedupe_candidates(candidates: Vec<StrictRecallCandidate>) -> Vec<StrictRecallCandidate> {
    let mut out: Vec<StrictRecallCandidate> = Vec::new();
    let mut position: HashMap<String, usize> = HashMap::new();
    for candidate in candidates {
        match position.get(&candidate.normalized).copied() {
            Some(index) => {
                if candidate.score > out[index].score {
                    out[index] = candidate;
                }
            }
            None => {
                position.insert(candidate.normalized.clone(), out.len());
                out.push(candidate);
            }
        }
    }
    out
}

/// `memoryUserIds` as `resolveMemoryUserIdCandidates` derives them for a
/// conversation. `externalChatId || 'default'` is applied first.
pub fn memory_user_ids(conversation: &Conversation) -> Vec<String> {
    let external_chat_id = conversation
        .external_chat_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or("default");
    resolve_memory_user_id_candidates(MemoryScopeInput {
        user_id: Some(conversation.user_id.as_str()),
        channel_type: Some(conversation.channel_type.as_str()),
        external_chat_id: Some(external_chat_id),
    })
}

/// Search options used by the chat recall (`searchMessages(userInput, {...})`).
pub fn chat_search_options(conversation: &Conversation) -> SearchMessagesOptions<'_> {
    SearchMessagesOptions {
        user_id: Some(conversation.user_id.as_str()),
        persona_id: conversation.persona_id.as_deref(),
        limit: Some(50),
        ..Default::default()
    }
}

/// Base letters of the lowercase precomposed characters (see module header).
/// Sorted by code point for the binary search in [`decompose`].
const NFD_BASE: &[(char, &str)] = &[
    ('\u{e0}', "a"),
    ('\u{e1}', "a"),
    ('\u{e2}', "a"),
    ('\u{e3}', "a"),
    ('\u{e4}', "a"),
    ('\u{e5}', "a"),
    ('\u{e7}', "c"),
    ('\u{e8}', "e"),
    ('\u{e9}', "e"),
    ('\u{ea}', "e"),
    ('\u{eb}', "e"),
    ('\u{ec}', "i"),
    ('\u{ed}', "i"),
    ('\u{ee}', "i"),
    ('\u{ef}', "i"),
    ('\u{f1}', "n"),
    ('\u{f2}', "o"),
    ('\u{f3}', "o"),
    ('\u{f4}', "o"),
    ('\u{f5}', "o"),
    ('\u{f6}', "o"),
    ('\u{f9}', "u"),
    ('\u{fa}', "u"),
    ('\u{fb}', "u"),
    ('\u{fc}', "u"),
    ('\u{fd}', "y"),
    ('\u{ff}', "y"),
    ('\u{101}', "a"),
    ('\u{103}', "a"),
    ('\u{105}', "a"),
    ('\u{107}', "c"),
    ('\u{109}', "c"),
    ('\u{10b}', "c"),
    ('\u{10d}', "c"),
    ('\u{10f}', "d"),
    ('\u{113}', "e"),
    ('\u{115}', "e"),
    ('\u{117}', "e"),
    ('\u{119}', "e"),
    ('\u{11b}', "e"),
    ('\u{11d}', "g"),
    ('\u{11f}', "g"),
    ('\u{121}', "g"),
    ('\u{123}', "g"),
    ('\u{125}', "h"),
    ('\u{129}', "i"),
    ('\u{12b}', "i"),
    ('\u{12d}', "i"),
    ('\u{12f}', "i"),
    ('\u{135}', "j"),
    ('\u{137}', "k"),
    ('\u{13a}', "l"),
    ('\u{13c}', "l"),
    ('\u{13e}', "l"),
    ('\u{144}', "n"),
    ('\u{146}', "n"),
    ('\u{148}', "n"),
    ('\u{14d}', "o"),
    ('\u{14f}', "o"),
    ('\u{151}', "o"),
    ('\u{155}', "r"),
    ('\u{157}', "r"),
    ('\u{159}', "r"),
    ('\u{15b}', "s"),
    ('\u{15d}', "s"),
    ('\u{15f}', "s"),
    ('\u{161}', "s"),
    ('\u{163}', "t"),
    ('\u{165}', "t"),
    ('\u{169}', "u"),
    ('\u{16b}', "u"),
    ('\u{16d}', "u"),
    ('\u{16f}', "u"),
    ('\u{171}', "u"),
    ('\u{173}', "u"),
    ('\u{175}', "w"),
    ('\u{177}', "y"),
    ('\u{17a}', "z"),
    ('\u{17c}', "z"),
    ('\u{17e}', "z"),
    ('\u{1a1}', "o"),
    ('\u{1b0}', "u"),
    ('\u{1ce}', "a"),
    ('\u{1d0}', "i"),
    ('\u{1d2}', "o"),
    ('\u{1d4}', "u"),
    ('\u{1d6}', "u"),
    ('\u{1d8}', "u"),
    ('\u{1da}', "u"),
    ('\u{1dc}', "u"),
    ('\u{1df}', "a"),
    ('\u{1e1}', "a"),
    ('\u{1e3}', "\u{e6}"),
    ('\u{1e7}', "g"),
    ('\u{1e9}', "k"),
    ('\u{1eb}', "o"),
    ('\u{1ed}', "o"),
    ('\u{1ef}', "\u{292}"),
    ('\u{1f0}', "j"),
    ('\u{1f5}', "g"),
    ('\u{1f9}', "n"),
    ('\u{1fb}', "a"),
    ('\u{1fd}', "\u{e6}"),
    ('\u{1ff}', "\u{f8}"),
    ('\u{201}', "a"),
    ('\u{203}', "a"),
    ('\u{205}', "e"),
    ('\u{207}', "e"),
    ('\u{209}', "i"),
    ('\u{20b}', "i"),
    ('\u{20d}', "o"),
    ('\u{20f}', "o"),
    ('\u{211}', "r"),
    ('\u{213}', "r"),
    ('\u{215}', "u"),
    ('\u{217}', "u"),
    ('\u{219}', "s"),
    ('\u{21b}', "t"),
    ('\u{21f}', "h"),
    ('\u{227}', "a"),
    ('\u{229}', "e"),
    ('\u{22b}', "o"),
    ('\u{22d}', "o"),
    ('\u{22f}', "o"),
    ('\u{231}', "o"),
    ('\u{233}', "y"),
    ('\u{1e01}', "a"),
    ('\u{1e03}', "b"),
    ('\u{1e05}', "b"),
    ('\u{1e07}', "b"),
    ('\u{1e09}', "c"),
    ('\u{1e0b}', "d"),
    ('\u{1e0d}', "d"),
    ('\u{1e0f}', "d"),
    ('\u{1e11}', "d"),
    ('\u{1e13}', "d"),
    ('\u{1e15}', "e"),
    ('\u{1e17}', "e"),
    ('\u{1e19}', "e"),
    ('\u{1e1b}', "e"),
    ('\u{1e1d}', "e"),
    ('\u{1e1f}', "f"),
    ('\u{1e21}', "g"),
    ('\u{1e23}', "h"),
    ('\u{1e25}', "h"),
    ('\u{1e27}', "h"),
    ('\u{1e29}', "h"),
    ('\u{1e2b}', "h"),
    ('\u{1e2d}', "i"),
    ('\u{1e2f}', "i"),
    ('\u{1e31}', "k"),
    ('\u{1e33}', "k"),
    ('\u{1e35}', "k"),
    ('\u{1e37}', "l"),
    ('\u{1e39}', "l"),
    ('\u{1e3b}', "l"),
    ('\u{1e3d}', "l"),
    ('\u{1e3f}', "m"),
    ('\u{1e41}', "m"),
    ('\u{1e43}', "m"),
    ('\u{1e45}', "n"),
    ('\u{1e47}', "n"),
    ('\u{1e49}', "n"),
    ('\u{1e4b}', "n"),
    ('\u{1e4d}', "o"),
    ('\u{1e4f}', "o"),
    ('\u{1e51}', "o"),
    ('\u{1e53}', "o"),
    ('\u{1e55}', "p"),
    ('\u{1e57}', "p"),
    ('\u{1e59}', "r"),
    ('\u{1e5b}', "r"),
    ('\u{1e5d}', "r"),
    ('\u{1e5f}', "r"),
    ('\u{1e61}', "s"),
    ('\u{1e63}', "s"),
    ('\u{1e65}', "s"),
    ('\u{1e67}', "s"),
    ('\u{1e69}', "s"),
    ('\u{1e6b}', "t"),
    ('\u{1e6d}', "t"),
    ('\u{1e6f}', "t"),
    ('\u{1e71}', "t"),
    ('\u{1e73}', "u"),
    ('\u{1e75}', "u"),
    ('\u{1e77}', "u"),
    ('\u{1e79}', "u"),
    ('\u{1e7b}', "u"),
    ('\u{1e7d}', "v"),
    ('\u{1e7f}', "v"),
    ('\u{1e81}', "w"),
    ('\u{1e83}', "w"),
    ('\u{1e85}', "w"),
    ('\u{1e87}', "w"),
    ('\u{1e89}', "w"),
    ('\u{1e8b}', "x"),
    ('\u{1e8d}', "x"),
    ('\u{1e8f}', "y"),
    ('\u{1e91}', "z"),
    ('\u{1e93}', "z"),
    ('\u{1e95}', "z"),
    ('\u{1e96}', "h"),
    ('\u{1e97}', "t"),
    ('\u{1e98}', "w"),
    ('\u{1e99}', "y"),
    ('\u{1e9b}', "\u{17f}"),
    ('\u{1ea1}', "a"),
    ('\u{1ea3}', "a"),
    ('\u{1ea5}', "a"),
    ('\u{1ea7}', "a"),
    ('\u{1ea9}', "a"),
    ('\u{1eab}', "a"),
    ('\u{1ead}', "a"),
    ('\u{1eaf}', "a"),
    ('\u{1eb1}', "a"),
    ('\u{1eb3}', "a"),
    ('\u{1eb5}', "a"),
    ('\u{1eb7}', "a"),
    ('\u{1eb9}', "e"),
    ('\u{1ebb}', "e"),
    ('\u{1ebd}', "e"),
    ('\u{1ebf}', "e"),
    ('\u{1ec1}', "e"),
    ('\u{1ec3}', "e"),
    ('\u{1ec5}', "e"),
    ('\u{1ec7}', "e"),
    ('\u{1ec9}', "i"),
    ('\u{1ecb}', "i"),
    ('\u{1ecd}', "o"),
    ('\u{1ecf}', "o"),
    ('\u{1ed1}', "o"),
    ('\u{1ed3}', "o"),
    ('\u{1ed5}', "o"),
    ('\u{1ed7}', "o"),
    ('\u{1ed9}', "o"),
    ('\u{1edb}', "o"),
    ('\u{1edd}', "o"),
    ('\u{1edf}', "o"),
    ('\u{1ee1}', "o"),
    ('\u{1ee3}', "o"),
    ('\u{1ee5}', "u"),
    ('\u{1ee7}', "u"),
    ('\u{1ee9}', "u"),
    ('\u{1eeb}', "u"),
    ('\u{1eed}', "u"),
    ('\u{1eef}', "u"),
    ('\u{1ef1}', "u"),
    ('\u{1ef3}', "y"),
    ('\u{1ef5}', "y"),
    ('\u{1ef7}', "y"),
    ('\u{1ef9}', "y"),
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::messages::service::recall::testing::{candidate, conversation};

    #[test]
    fn normalize_strips_diacritics_and_sharp_s() {
        assert_eq!(normalize_for_match("Übung  Größe"), "ubung grosse");
        assert_eq!(normalize_for_match("café"), "cafe");
        assert_eq!(normalize_for_match("a^b`c"), "abc");
    }

    #[test]
    fn tokenize_keeps_letters_and_digits_only() {
        assert_eq!(
            tokenize_normalized("hallo, welt! 42"),
            vec!["hallo", "welt", "42"]
        );
    }

    #[test]
    fn utf16_prefix_counts_surrogates_as_two_units() {
        assert_eq!(utf16_prefix("a😀b", 2), "a");
        assert_eq!(utf16_prefix("a😀b", 3), "a😀");
        assert_eq!(utf16_len("a😀b"), 4);
    }

    #[test]
    fn dedupe_keeps_best_score_at_first_position() {
        let mut low = candidate("ubung", None);
        low.score = 1.0;
        let mut other = candidate("andere", None);
        other.score = 2.0;
        let mut high = candidate("ubung", None);
        high.score = 3.0;
        let out = dedupe_candidates(vec![low, other, high]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].score, 3.0);
        assert_eq!(out[1].text, "andere");
    }

    #[test]
    fn recency_boost_favours_the_newest_candidate() {
        let mut items = vec![
            candidate("neu", Some("2026-10-10T10:00:00Z")),
            candidate("alt", Some("2026-10-08T10:00:00Z")),
            candidate("ohne", None),
        ];
        apply_recency_boost(&mut items);
        assert!((items[0].score - 0.7).abs() < 1e-9);
        assert!((items[1].score - 0.5).abs() < 1e-9);
        assert_eq!(items[2].score, 0.0);
    }

    #[test]
    fn memory_user_ids_is_a_single_candidate() {
        let conv = conversation("WebChat", Some("persona-1"));
        assert_eq!(memory_user_ids(&conv), vec![conv.user_id.clone()]);
    }

    #[test]
    fn nfd_table_is_sorted_for_binary_search() {
        assert!(NFD_BASE.windows(2).all(|pair| pair[0].0 < pair[1].0));
        assert!(NFD_BASE.len() > 200);
    }
}
