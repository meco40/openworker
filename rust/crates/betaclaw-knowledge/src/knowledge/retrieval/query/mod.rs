//! Port of `src/server/knowledge/retrieval/query/` — the query analysis helpers.
//!
//! The TypeScript directory has no `index.ts`, so this `mod.rs` only declares
//! the three files; `retrieval/index.ts:18-28` is mirrored by the re-exports in
//! [`super`].
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`intent_detector`] | `query/intentDetector.ts` |
//! | [`query_parser`] | `query/queryParser.ts` |
//! | [`rules_extractor`] | `query/rulesExtractor.ts` |

pub mod intent_detector;
pub mod query_parser;
pub mod rules_extractor;
