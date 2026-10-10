//! The small pure helpers of the slice.
//!
//! | TypeScript                                   | Rust function                                   |
//! | -------------------------------------------- | ----------------------------------------------- |
//! | `utils/scoring.ts`                           | [`normalize_mem0_score`]                        |
//! | `utils/queryUtils.ts`                        | [`matches_query`], [`matches_type`], [`is_rules_like_query`], [`contains_rules_word`] |
//! | `utils/timestamp.ts`                         | [`format_timestamp`], [`now_iso`]               |
//! | `idempotency.ts`                             | [`create_memory_idempotency_key`]               |
//! | `mem0/utils/http.ts`                         | [`normalize_base_url`], [`normalize_api_path`], [`join_url`], [`normalize_text`] |
//!
//! # `formatTimestamp` is locale-dependent in TypeScript
//!
//! `new Date(...).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })`
//! formats with the *host* locale and its default 12/24-hour preference. A Rust
//! port cannot read `Intl`, so the port renders the `en-US` shape (`hh:mm AM`,
//! e.g. `01:23 PM`) with chrono. The value is only ever written into the
//! `timestamp` display field and read back by
//! [`crate::memory::mappers::to_memory_node`], where an unparsable string is
//! returned unchanged — so the locale choice does not change any comparison.
//! The ISO stamps that *are* compared (`createdAt`, `updatedAt`,
//! `lastVerified`) go through [`now_iso`] / [`normalize_timestamp`] and are
//! locale-free.

use chrono::{Local, Utc};
use sha2::{Digest, Sha256};

use super::types::MemoryNode;

/// `normalizeMem0Score` from `utils/scoring.ts:1-7`.
pub fn normalize_mem0_score(score: Option<f64>) -> f64 {
    let Some(score) = score.filter(|score| score.is_finite()) else {
        return 0.75;
    };
    if (0.0..=1.0).contains(&score) {
        score
    } else if score > 1.0 && score <= 100.0 {
        (score / 100.0).min(1.0)
    } else if score < 0.0 {
        0.0
    } else {
        0.75
    }
}

/// `matchesQuery` from `utils/queryUtils.ts:3-9`.
///
/// An empty needle matches everything, exactly like the falsy check in
/// JavaScript.
pub fn matches_query(node: &MemoryNode, query: Option<&str>) -> bool {
    let needle = query.unwrap_or("").trim().to_lowercase();
    if needle.is_empty() {
        return true;
    }
    node.content.to_lowercase().contains(&needle) || node.node_type.as_str().contains(&needle)
}

/// `matchesType` from `utils/queryUtils.ts:11-15`.
pub fn matches_type(node: &MemoryNode, node_type: Option<&super::types::MemoryType>) -> bool {
    match node_type {
        Some(expected) => &node.node_type == expected,
        None => true,
    }
}

/// `isRulesLikeQuery` from `utils/queryUtils.ts:16-22`.
pub fn is_rules_like_query(query: &str) -> bool {
    matches_rules_word(query)
}

/// `containsRulesWord` from `utils/queryUtils.ts:24-30`.
pub fn contains_rules_word(text: &str) -> bool {
    matches_rules_word(text)
}

/// The shared pattern body: `\b(regel|regeln|rule|rules|richtlinie|…)`.
fn matches_rules_word(text: &str) -> bool {
    let normalized = text.trim().to_lowercase();
    const WORDS: [&str; 10] = [
        "regel",
        "regeln",
        "rule",
        "rules",
        "richtlinie",
        "richtlinien",
        "policy",
        "policies",
        "vorgabe",
        "vorgaben",
    ];
    // JavaScript's `\b` on this pattern is an ASCII/simple word boundary. A
    // character-based scan reproduces it without pulling in Unicode-aware
    // boundaries: a word counts when it is not glued to another word character.
    WORDS.iter().any(|word| contains_word(&normalized, word))
}

/// `\b<word>\b` against a simple word character = `[A-Za-z0-9_]` definition.
fn contains_word(haystack: &str, word: &str) -> bool {
    let bytes = haystack.as_bytes();
    let mut from = 0;
    while let Some(offset) = haystack[from..].find(word) {
        let start = from + offset;
        let end = start + word.len();
        let before_ok = start == 0 || !is_word_byte(bytes[start - 1]);
        let after_ok = end >= bytes.len() || !is_word_byte(bytes[end]);
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
    }
    false
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// `formatTimestamp` from `utils/timestamp.ts:1-8`.
///
/// See the module documentation for the locale caveat. An absent or unparsable
/// input is returned unchanged, which is what `Date.parse` returning `NaN` does.
pub fn format_timestamp(input: Option<&str>) -> String {
    match input {
        None => Local::now().format("%I:%M %p").to_string(),
        Some(text) => match chrono::DateTime::parse_from_rfc3339(text) {
            Ok(parsed) => parsed
                .with_timezone(&Local)
                .format("%I:%M %p")
                .to_string(),
            Err(_) => text.to_string(),
        },
    }
}

/// `new Date().toISOString()` — millisecond precision, always UTC.
pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `timestamp(value)` from `postgresMemoryClient.ts:60-64`.
///
/// Parses an ISO stamp; a value that does not parse falls back to *now*, not to
/// an empty string, because the caller uses the result as a sort key.
pub fn normalize_timestamp(value: Option<&str>) -> String {
    let text = value.unwrap_or("").trim();
    if text.is_empty() {
        return now_iso();
    }
    match chrono::DateTime::parse_from_rfc3339(text) {
        Ok(parsed) => parsed.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        Err(_) => now_iso(),
    }
}

/// `createMemoryIdempotencyKey` from `idempotency.ts:3-8`.
///
/// Joins the parts with `\u001f`, drops `null`/`undefined`, trims each part and
/// hashes the UTF-8 payload with SHA-256.
pub fn create_memory_idempotency_key(parts: &[Option<String>]) -> String {
    let payload: Vec<&str> = parts
        .iter()
        .map(|part| part.as_deref().unwrap_or("").trim())
        .collect();
    let joined = payload.join("\u{1f}");
    let digest = Sha256::digest(joined.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `normalizeBaseUrl` from `mem0/utils/http.ts:10-13`.
pub fn normalize_base_url(url: &str) -> String {
    let trimmed = url.trim_end_matches('/');
    // JavaScript's `/\/+$/` only strips trailing slashes; leading ones stay.
    trimmed.to_string()
}

/// `normalizeApiPath` from `mem0/utils/http.ts:17-22`.
pub fn normalize_api_path(path: &str) -> String {
    if path.trim().is_empty() {
        return String::new();
    }
    let with_leading = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    with_leading.trim_end_matches('/').to_string()
}

/// `joinUrl` from `mem0/utils/http.ts:26-29`.
pub fn join_url(base_url: &str, api_path: &str, resource_path: &str) -> String {
    let suffix = if resource_path.starts_with('/') {
        resource_path.to_string()
    } else {
        format!("/{resource_path}")
    };
    format!(
        "{}{}{}",
        normalize_base_url(base_url),
        normalize_api_path(api_path),
        suffix
    )
}

/// `normalizeText` from `mem0/utils/http.ts:34-36`.
pub fn normalize_text(value: &str) -> String {
    value.trim().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::types::{MemoryMetadata, MemoryType};

    fn node(content: &str, node_type: MemoryType) -> MemoryNode {
        MemoryNode {
            id: "n".to_string(),
            node_type,
            content: content.to_string(),
            embedding: Vec::new(),
            importance: 3.0,
            confidence: 0.3,
            timestamp: "t".to_string(),
            metadata: Some(MemoryMetadata::new()),
        }
    }

    #[test]
    fn score_normalisation_covers_every_branch() {
        assert_eq!(normalize_mem0_score(Some(0.4)), 0.4);
        assert_eq!(normalize_mem0_score(Some(0.0)), 0.0);
        assert_eq!(normalize_mem0_score(Some(50.0)), 0.5);
        assert_eq!(normalize_mem0_score(Some(150.0)), 1.0);
        assert_eq!(normalize_mem0_score(Some(-3.0)), 0.0);
        assert_eq!(normalize_mem0_score(Some(101.0)), 0.75);
        assert_eq!(normalize_mem0_score(None), 0.75);
        assert_eq!(normalize_mem0_score(Some(f64::NAN)), 0.75);
    }

    /// A whitespace-only needle is falsy in JavaScript after `trim()`, so an
    /// all-whitespace query must not filter anything out.
    #[test]
    fn an_empty_query_matches_every_node() {
        let node = node("hello", MemoryType::Fact);
        assert!(matches_query(&node, None));
        assert!(matches_query(&node, Some("   ")));
        assert!(matches_query(&node, Some("HELLO")));
        assert!(!matches_query(&node, Some("goodbye")));
        assert!(matches_query(&node, Some("fact")), "the type is searched too");
        assert!(matches_type(&node, Some(&MemoryType::Fact)));
        assert!(!matches_type(&node, Some(&MemoryType::Lesson)));
        assert!(matches_type(&node, None));
    }

    #[test]
    fn the_rules_word_uses_word_boundaries() {
        assert!(is_rules_like_query("was sind die Regeln?"));
        assert!(is_rules_like_query("regel"));
        assert!(!is_rules_like_query("regelwerk"));
        assert!(contains_rules_word("the policy applies"));
        assert!(!contains_rules_word("policymaker"));
        assert!(!contains_rules_word("nothing here"));
    }

    #[test]
    fn url_helpers_normalise_the_same_way() {
        assert_eq!(normalize_base_url("https://x///"), "https://x");
        assert_eq!(normalize_api_path("v1/"), "/v1");
        assert_eq!(normalize_api_path("/v1/"), "/v1");
        assert_eq!(normalize_api_path("   "), "");
        assert_eq!(
            join_url("https://x//", "v1", "memories"),
            "https://x/v1/memories"
        );
        assert_eq!(
            join_url("https://x", "/v2", "/memories"),
            "https://x/v2/memories"
        );
        assert_eq!(normalize_text("  AbC "), "abc");
    }

    #[test]
    fn the_idempotency_key_is_a_sha256_of_the_joined_parts() {
        let key = create_memory_idempotency_key(&[
            Some("u-1".to_string()),
            None,
            Some("  p1  ".to_string()),
            Some(String::new()),
        ]);
        let expected = Sha256::digest("u-1\u{1f}\u{1f}p1\u{1f}".as_bytes());
        let rendered: String = expected.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(key, rendered);
        assert_eq!(key.len(), 64);
    }

    #[test]
    fn an_unparsable_timestamp_passes_through_unchanged() {
        assert_eq!(format_timestamp(Some("01:23 PM")), "01:23 PM");
        assert_eq!(format_timestamp(Some("not a date")), "not a date");
        assert!(!format_timestamp(None).is_empty());
    }

    #[test]
    fn normalize_timestamp_falls_back_to_now_for_garbage() {
        assert_eq!(
            normalize_timestamp(Some("2026-01-02T03:04:05Z")),
            "2026-01-02T03:04:05.000Z"
        );
        assert_eq!(normalize_timestamp(Some("nonsense")), now_iso());
        assert_eq!(normalize_timestamp(None), now_iso());
    }
}
