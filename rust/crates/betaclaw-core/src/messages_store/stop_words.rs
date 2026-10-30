//! Port of `src/server/channels/messages/repository/constants/stopWords.ts`.
//!
//! German and English function words that add no search value and would make the
//! FTS5 `OR` expression far too restrictive.
//!
//! The TypeScript source builds a `Set`, so the repeated entries (`an`, `in`,
//! `is`, `was`, `will`, `and`, `or`, `not`, `so`, `sie`) collapse to one. A
//! slice with `contains` gives the same answer, and keeping the literal order
//! and the duplicates makes this file diffable against the source.

/// `STOP_WORDS` from `repository/constants/stopWords.ts:4-179`, in source order.
pub const STOP_WORDS: &[&str] = &[
    // German
    "der", "die", "das", "den", "dem", "des", "ein", "eine", "einer", "einem", "einen", "ich", "du",
    "er", "sie", "es", "wir", "ihr", "mich", "mir", "dich", "dir", "sich", "uns", "euch", "ihm",
    "ihn", "ihnen", "mein", "dein", "sein", "unser", "ist", "sind", "war", "bin", "hat", "haben",
    "hatte", "wird", "werden", "wurde", "kann", "soll", "muss", "darf", "will", "mag", "könnte",
    "sollte", "müsste", "und", "oder", "aber", "denn", "weil", "dass", "wenn", "als", "ob", "da",
    "in", "an", "auf", "aus", "bei", "mit", "nach", "von", "zu", "für", "über", "um", "durch",
    "vor", "zwischen", "unter", "neben", "hinter", "wie", "was", "wer", "wo", "wann", "warum",
    "welche", "welcher", "welches", "nicht", "auch", "noch", "schon", "nur", "sehr", "mehr", "so",
    "ja", "nein", "hier", "dort", "jetzt", "dann", "immer", "nie", "mal", "doch", "eben",
    // English
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do",
    "does", "did", "will", "would", "could", "should", "i", "you", "he", "she", "it", "we", "they",
    "me", "him", "her", "us", "them", "my", "your", "his", "its", "our", "their", "in", "on", "at",
    "to", "for", "of", "with", "by", "from", "about", "and", "or", "but", "not", "if", "so", "no",
    "yes", "this", "that", "what", "which", "who", "how", "when", "where", "why",
];

#[cfg(test)]
mod tests {
    use super::STOP_WORDS;

    #[test]
    fn contains_the_german_and_english_core() {
        for word in ["der", "die", "und", "oder", "the", "and", "with", "why"] {
            assert!(
                STOP_WORDS.contains(&word),
                "{word} is a stop word in the source"
            );
        }
        assert!(!STOP_WORDS.contains(&"rust"));
    }

    #[test]
    fn keeps_the_source_length() {
        // `stopWords.ts` lists 172 words between the `new Set([` and `]);`
        // lines, duplicates included.
        assert_eq!(STOP_WORDS.len(), 172);
    }
}
