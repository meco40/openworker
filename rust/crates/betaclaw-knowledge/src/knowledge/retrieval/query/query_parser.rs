//! Port of `src/server/knowledge/retrieval/query/queryParser.ts` (1-35).
//!
//! | TypeScript                                 | Rust |
//! | ------------------------------------------ | ---- |
//! | `query/queryParser.ts:3-35` (`tokenizeQueryForRanking`) | [`tokenize_query_for_ranking`] |
//!
//! The stopword set is the 24-entry list of `:5-30`; the filter keeps tokens of
//! four or more characters (`:34`) — measured in UTF-16 code units like
//! JavaScript, although `normalizeLookupText` has already reduced the text to
//! ASCII.

use super::super::js_str_len;
use super::intent_detector::normalize_lookup_text;

/// The `stopwords` set of `queryParser.ts:5-30`.
const STOPWORDS: [&str; 24] = [
    "die", "der", "das", "ein", "eine", "und", "oder", "mit", "von", "zu", "an", "mir", "du",
    "ich", "was", "wie", "wann", "warum", "wieso", "nenne", "sage", "sag", "zeige", "bitte",
];

/// `tokenizeQueryForRanking` from `queryParser.ts:3-35`.
pub fn tokenize_query_for_ranking(query: &str) -> Vec<String> {
    normalize_lookup_text(query)
        .split(' ')
        .map(|token| token.trim().to_string())
        .filter(|token| js_str_len(token) >= 4 && !STOPWORDS.contains(&token.as_str()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_normalized_filtered_by_length_and_stopwords() {
        assert_eq!(
            tokenize_query_for_ranking("Was war mit Max beim Vertrag?"),
            vec!["beim".to_string(), "vertrag".to_string()]
        );
        assert_eq!(
            tokenize_query_for_ranking("Richtlinien zum Rabatt"),
            vec!["richtlinien".to_string(), "rabatt".to_string()]
        );
        // "sage" is a stopword, "sauna" is not; three characters are too short.
        assert_eq!(
            tokenize_query_for_ranking("sage mir sauna an der ecke"),
            vec!["sauna".to_string(), "ecke".to_string()]
        );
        assert!(tokenize_query_for_ranking("was wie wann").is_empty());
        assert!(tokenize_query_for_ranking("").is_empty());
    }
}
