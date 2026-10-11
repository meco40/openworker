//! Codex parsers, one module per TypeScript file of
//! `src/server/model-hub/Models/openai-codex/parsers/`.
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`response_parser`] | `responseParser.ts` |
//! | [`error_parser`] | `errorParser.ts` |
//! | [`rate_limit_parser`] | `rateLimitParser.ts` |
//! | [`usage_rate_limit_parser`] | `usageRateLimitParser.ts` |
//! | [`sse_parser`] | `sseParser.ts` |

pub mod error_parser;
pub mod rate_limit_parser;
pub mod response_parser;
pub mod sse_parser;
pub mod usage_rate_limit_parser;

pub use error_parser::{parse_codex_http_error, to_codex_stream_error};
pub use rate_limit_parser::parse_codex_rate_limits_from_headers;
pub use response_parser::{
    append_unique_function_calls, extract_function_calls_from_codex_output,
    extract_text_from_codex_output, map_codex_usage, map_function_call_args,
};
pub use sse_parser::{
    parse_codex_sse_response, parse_sse_events, CodexSseAccumulator, CodexStreamParseResult,
};
pub use usage_rate_limit_parser::{merge_rate_limit_snapshots, parse_codex_usage_rate_limits};
