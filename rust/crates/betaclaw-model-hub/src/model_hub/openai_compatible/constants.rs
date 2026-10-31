//! Port of `src/server/model-hub/Models/shared/openai-compatible/constants.ts`.

/// `DEFAULT_MAX_TOKENS` from `constants.ts:1`.
pub const DEFAULT_MAX_TOKENS: i64 = 4096;
/// `DEFAULT_TEMPERATURE` from `constants.ts:2`.
pub const DEFAULT_TEMPERATURE: f64 = 0.7;
/// `MAX_TEXT_ATTACHMENT_SNIPPET_LENGTH` from `constants.ts:3`.
pub const MAX_TEXT_ATTACHMENT_SNIPPET_LENGTH: usize = 12_000;

/// `CONTENT_TYPE_JSON` from `constants.ts:5`.
pub const CONTENT_TYPE_JSON: &str = "application/json";
/// `CONTENT_TYPE_EVENT_STREAM` from `constants.ts:6`.
pub const CONTENT_TYPE_EVENT_STREAM: &str = "text/event-stream";

/// `SSE_DATA_PREFIX` from `constants.ts:8`.
pub const SSE_DATA_PREFIX: &str = "data:";
/// `SSE_DONE_MARKER` from `constants.ts:9`.
pub const SSE_DONE_MARKER: &str = "[DONE]";
/// `SSE_BLOCK_SEPARATOR` from `constants.ts:10`.
pub const SSE_BLOCK_SEPARATOR: &str = "\n\n";

/// `PROVIDERS_SUPPORTING_REASONING_EFFORT` from `constants.ts:14`.
///
/// **Dead constant.** `buildRequestBody` does not read it; `request/build.ts:155-160`
/// hard-codes `['openai', 'openai-codex', 'opencode']` instead, so OpenCode is
/// missing from this list and this list has no consumer at all. The port keeps the
/// literal for traceability but the builder uses the hard-coded list.
pub const PROVIDERS_SUPPORTING_REASONING_EFFORT: &[&str] = &["openai", "openai-codex"];

/// `THINK_BLOCK_REGEX` from `constants.ts:12`: `/<think>[\s\S]*?<\/think>/gi`.
///
/// The JavaScript pattern uses `[\s\S]` and the `g`/`i` flags. Rust's `regex`
/// crate spells the same pattern `(?is)<think>.*?</think>`.
pub const THINK_BLOCK_REGEX_PATTERN: &str = r"(?is)<think>.*?</think>";

/// The providers `buildRequestBody` forwards `reasoning_effort` to, from the
/// literal in `request/build.ts:157`.
pub const REASONING_EFFORT_PROVIDERS: &[&str] =
    &["openai", "openai-codex", "opencode", "refuseless"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_match_the_typescript_literals() {
        assert_eq!(DEFAULT_MAX_TOKENS, 4096);
        assert_eq!(DEFAULT_TEMPERATURE, 0.7);
        assert_eq!(MAX_TEXT_ATTACHMENT_SNIPPET_LENGTH, 12_000);
        assert_eq!(SSE_DATA_PREFIX, "data:");
        assert_eq!(SSE_DONE_MARKER, "[DONE]");
        assert_eq!(SSE_BLOCK_SEPARATOR, "\n\n");
        assert_eq!(CONTENT_TYPE_EVENT_STREAM, "text/event-stream");
    }

    /// The dead constant and the hard-coded list disagree about OpenCode. Keeping
    /// the assertion documents the drift instead of hiding it.
    #[test]
    fn the_exported_provider_list_drifted_from_the_builder() {
        assert!(!PROVIDERS_SUPPORTING_REASONING_EFFORT.contains(&"opencode"));
        assert!(REASONING_EFFORT_PROVIDERS.contains(&"opencode"));
        assert_eq!(
            PROVIDERS_SUPPORTING_REASONING_EFFORT,
            &["openai", "openai-codex"]
        );
    }
}
