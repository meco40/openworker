//! Port of `src/server/channels/messages/service/recall/constants.ts`.

/// `MEM0_EMPTY_SCOPE_TTL_MS` (5 minutes), in milliseconds like `Date.now()`.
pub const MEM0_EMPTY_SCOPE_TTL_MS: i64 = 5 * 60 * 1000;

/// `RECALL_QUERY_STOP_WORDS`. Compared against normalized query tokens.
pub const RECALL_QUERY_STOP_WORDS: &[&str] = &[
    "erinner",
    "erinnere",
    "dich",
    "welche",
    "welcher",
    "welches",
    "welchen",
    "was",
    "wie",
    "wann",
    "wo",
    "warum",
    "wieso",
    "du",
    "ich",
    "mir",
    "mich",
    "dein",
    "deine",
    "heute",
    "gestern",
    "vorgestern",
    "nochmal",
    "machen",
    "machst",
    "willst",
    "wolltest",
    "wollen",
    "will",
    "remember",
    "recall",
    "bitte",
    "denn",
    "mal",
];

/// `TIME_TOKENS` for strict recall.
pub const TIME_TOKENS: &[&str] = &["heute", "gestern", "vorgestern", "abend", "morgen", "nacht"];

/// `COMMITMENT_TOKENS` for strict recall scoring.
///
/// `möchte` keeps its umlaut as in the source. Text is normalized before the
/// lookup, so this entry never matches. That matches the TypeScript behaviour
/// and is kept on purpose.
pub const COMMITMENT_TOKENS: &[&str] = &[
    "will", "werde", "mache", "mach", "mochte", "möchte", "plane", "vor", "nehme",
];
