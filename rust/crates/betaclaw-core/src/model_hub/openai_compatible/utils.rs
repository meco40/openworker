//! Port of `src/server/model-hub/Models/shared/openai-compatible/utils.ts`,
//! plus the attachment access that `utils.ts` borrows from
//! `src/server/channels/messages/attachments.ts`.
//!
//! Two of the helpers need care:
//!
//! - `readTextAttachmentSnippet` truncates with `String.prototype.slice`, which
//!   counts **UTF-16 code units**, while Rust slices by bytes or `char`. The port
//!   reimplements the JavaScript semantics, including the replacement character a
//!   split surrogate pair produces.
//! - The filesystem side of attachment reading (`resolveStoredAttachmentPath`)
//!   belongs to the channels module and is not part of S4a, so it arrives through
//!   the [`AttachmentStore`] seam.

use std::sync::LazyLock;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use regex::Regex;

use super::constants::{MAX_TEXT_ATTACHMENT_SNIPPET_LENGTH, THINK_BLOCK_REGEX_PATTERN};
use crate::model_hub::types::GatewayMessageAttachment;

static THINK_BLOCK_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(THINK_BLOCK_REGEX_PATTERN).expect("static regex is valid"));

/// `normalizeBearerSecret` from `utils.ts:5-13`.
///
/// The five steps are applied in order. Step 3 is the interesting one:
/// `/^['"`](.*)['"`]$/s` uses a greedy `.*` with the `s` flag, so it strips a
/// leading and a trailing quote character even when they differ and even when
/// there are quotes in between — a bare backtick is dropped as well.
pub fn normalize_bearer_secret(secret: &str) -> String {
    let mut normalized = secret.trim().to_string();
    normalized = normalized
        .trim_matches(|c| matches!(c, '\r' | '\n' | '\t' | ' '))
        .to_string();
    normalized = strip_wrapping_quote(&normalized).trim().to_string();
    normalized = strip_bearer_prefix(&normalized).trim().to_string();
    // `/\\[nrt]/g` — a *backslash* followed by n, r or t, not a control character.
    normalized = normalized.replace("\\n", "");
    normalized = normalized.replace("\\r", "");
    normalized = normalized.replace("\\t", "");
    normalized
        .chars()
        .filter(|c| !matches!(c, '\r' | '\n' | '\t'))
        .collect()
}

fn is_quote(c: char) -> bool {
    matches!(c, '\'' | '"' | '`')
}

fn strip_wrapping_quote(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() >= 2 && is_quote(chars[0]) && is_quote(chars[chars.len() - 1]) {
        return chars[1..chars.len() - 1].iter().collect();
    }
    value.to_string()
}

/// `/^Bearer\s+/i` — case-insensitive prefix plus at least one whitespace.
fn strip_bearer_prefix(value: &str) -> String {
    let lowered = value.to_ascii_lowercase();
    if !lowered.starts_with("bearer") {
        return value.to_string();
    }
    let rest = &value[6..];
    match rest.chars().next() {
        Some(first) if first.is_whitespace() => rest.trim_start().to_string(),
        _ => value.to_string(),
    }
}

/// `buildOptionalAuthHeaders` from `utils.ts:15-19`. Returns `None` for an empty
/// secret, which the callers render as "no Authorization header".
pub fn build_optional_auth_headers(secret: &str) -> Option<String> {
    let normalized = normalize_bearer_secret(secret);
    if normalized.is_empty() {
        None
    } else {
        Some(format!("Bearer {normalized}"))
    }
}

/// `isImageAttachment` from `utils.ts:21-23`.
pub fn is_image_attachment(mime_type: &str) -> bool {
    mime_type.trim().to_lowercase().starts_with("image/")
}

/// `isTextAttachment` from `utils.ts:25-28`.
pub fn is_text_attachment(mime_type: &str) -> bool {
    let normalized = mime_type.trim().to_lowercase();
    normalized.starts_with("text/") || normalized == "application/json"
}

/// `attachmentFallbackText` from `utils.ts:42-44`.
pub fn attachment_fallback_text(attachment: &GatewayMessageAttachment) -> String {
    format!(
        "[Attachment: {} ({}, {} bytes)]",
        attachment.name, attachment.mime_type, attachment.size
    )
}

/// `normalizeBaseUrl` from `utils.ts:46-48` — removes exactly one trailing slash.
pub fn normalize_base_url(base_url: &str) -> String {
    base_url.strip_suffix('/').unwrap_or(base_url).to_string()
}

/// `buildModelsUrl` from `utils.ts:50-52`.
pub fn build_models_url(base_url: &str) -> String {
    format!("{}/models", normalize_base_url(base_url))
}

/// `buildChatUrl` from `utils.ts:54-56`.
pub fn build_chat_url(base_url: &str) -> String {
    format!("{}/chat/completions", normalize_base_url(base_url))
}

/// `stripThinkingBlocks` from `utils.ts:58-60`.
pub fn strip_thinking_blocks(text: &str) -> String {
    THINK_BLOCK_REGEX.replace_all(text, "").trim().to_string()
}

/// `String.prototype.slice(0, MAX_TEXT_ATTACHMENT_SNIPPET_LENGTH)`.
///
/// The JavaScript string index is a UTF-16 code unit, and a cut that lands in the
/// middle of a surrogate pair yields a lone surrogate — which JSON encodes as
/// U+FFFD. Reproducing that keeps the request body byte-identical for non-ASCII
/// attachments.
pub fn js_slice_utf16(text: &str, max_units: usize) -> String {
    let mut out = String::new();
    let mut units = 0usize;
    for c in text.chars() {
        let width = c.len_utf16();
        if units + width > max_units {
            if width == 2 {
                // A surrogate pair that does not fit: the high surrogate survives
                // the slice and becomes U+FFFD when encoded.
                out.push('\u{fffd}');
            }
            break;
        }
        units += width;
        out.push(c);
    }
    out
}

/// Reads a stored attachment from disk.
///
/// The TypeScript implementation is
/// `readStoredAttachmentBuffer(attachment)` in
/// `src/server/channels/messages/attachments.ts`, which resolves
/// `storagePath` against the persona-scoped attachment root and refuses any path
/// that escapes it. That path resolution belongs to the channels slice, so S4a
/// takes it as an injected seam instead of duplicating a security check.
pub trait AttachmentStore: Send + Sync {
    /// `readStoredAttachmentBuffer`. The error string is the message the
    /// TypeScript `Error` would carry; the caller catches it either way.
    fn read(&self, attachment: &GatewayMessageAttachment) -> Result<Vec<u8>, String>;
}

/// An [`AttachmentStore`] that resolves nothing, so every attachment degrades to
/// its placeholder text.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopAttachmentStore;

impl AttachmentStore for NoopAttachmentStore {
    fn read(&self, _attachment: &GatewayMessageAttachment) -> Result<Vec<u8>, String> {
        Err("Attachment storage path is empty.".to_string())
    }
}

/// Shared [`NOOP_ATTACHMENT_STORE`] instance.
pub static NOOP_ATTACHMENT_STORE: NoopAttachmentStore = NoopAttachmentStore;

/// `readStoredAttachmentAsDataUrl` from
/// `src/server/channels/messages/attachments.ts`: `null` on any error and for an
/// empty file.
pub fn read_stored_attachment_as_data_url(
    store: &dyn AttachmentStore,
    attachment: &GatewayMessageAttachment,
) -> Option<String> {
    let bytes = store.read(attachment).ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some(format!(
        "data:{};base64,{}",
        attachment.mime_type,
        STANDARD.encode(&bytes)
    ))
}

/// `readTextAttachmentSnippet` from `utils.ts:30-40`.
pub fn read_text_attachment_snippet(
    store: &dyn AttachmentStore,
    attachment: &GatewayMessageAttachment,
) -> Option<String> {
    let bytes = store.read(attachment).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let text = String::from_utf8_lossy(&bytes).replace('\u{0000}', "");
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(js_slice_utf16(trimmed, MAX_TEXT_ATTACHMENT_SNIPPET_LENGTH))
}

/// `data:<mimeType>;base64,<bytes>` for a byte slice, used by tests.
pub fn data_url_for_bytes(mime_type: &str, bytes: &[u8]) -> String {
    format!("data:{mime_type};base64,{}", STANDARD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_secret_strips_quotes_and_prefixes() {
        assert_eq!(normalize_bearer_secret("sk-test"), "sk-test");
        assert_eq!(normalize_bearer_secret("  sk-test  "), "sk-test");
        assert_eq!(normalize_bearer_secret("\"sk-test\""), "sk-test");
        assert_eq!(normalize_bearer_secret("'sk-test'"), "sk-test");
        assert_eq!(normalize_bearer_secret("`sk-test`"), "sk-test");
        assert_eq!(normalize_bearer_secret("Bearer sk-test"), "sk-test");
        assert_eq!(normalize_bearer_secret("bearer sk-test"), "sk-test");
        assert_eq!(normalize_bearer_secret("BEARER\tsk-test"), "sk-test");
        assert_eq!(normalize_bearer_secret("\"Bearer sk-test\""), "sk-test");
        assert_eq!(normalize_bearer_secret("sk\\ntest"), "sktest");
        assert_eq!(normalize_bearer_secret("sk\r\n\ttest"), "sktest");
        assert_eq!(normalize_bearer_secret(""), "");
        // `"""` is three quote characters: the greedy `.*` keeps the middle one,
        // because `/^['"`](.*)['"`]$/s` strips exactly one pair.
        assert_eq!(normalize_bearer_secret("\"\"\""), "\"");
    }

    /// `Bearer` without trailing whitespace is *not* a prefix, so it survives.
    #[test]
    fn bearer_without_whitespace_is_kept() {
        assert_eq!(normalize_bearer_secret("BearerKey"), "BearerKey");
        assert_eq!(normalize_bearer_secret("Bearer "), "Bearer");
    }

    /// The greedy `.*` means a mismatched quote pair is stripped too — but only
    /// once, and only one pair.
    #[test]
    fn greedy_quote_strip_accepts_mismatched_delimiters() {
        assert_eq!(normalize_bearer_secret("`sk-test\""), "sk-test");
        // `"` `'` are stripped, `'` stays: the inner quote is part of the `.*`.
        assert_eq!(normalize_bearer_secret("\"'sk-test'"), "'sk-test");
    }

    #[test]
    fn optional_auth_headers_are_omitted_for_an_empty_secret() {
        assert_eq!(
            build_optional_auth_headers("sk-test"),
            Some("Bearer sk-test".to_string())
        );
        assert_eq!(build_optional_auth_headers(""), None);
        assert_eq!(build_optional_auth_headers("   "), None);
        assert_eq!(build_optional_auth_headers("\"\""), None);
    }

    #[test]
    fn attachment_mime_classification_matches_typescript() {
        assert!(is_image_attachment("image/png"));
        assert!(is_image_attachment("  IMAGE/JPEG "));
        assert!(!is_image_attachment("application/json"));
        assert!(is_text_attachment("text/plain"));
        assert!(is_text_attachment("text/markdown; charset=utf-8"));
        assert!(is_text_attachment("application/json"));
        assert!(is_text_attachment("APPLICATION/JSON"));
        assert!(!is_text_attachment("application/pdf"));
        assert!(!is_image_attachment("imagex/png"));
    }

    #[test]
    fn fallback_text_matches_the_template() {
        let attachment = GatewayMessageAttachment {
            name: "notes".to_string(),
            mime_type: "application/pdf".to_string(),
            size: 42,
            storage_path: "p/notes.pdf".to_string(),
            sha256: None,
        };
        assert_eq!(
            attachment_fallback_text(&attachment),
            "[Attachment: notes (application/pdf, 42 bytes)]"
        );
    }

    /// `normalizeBaseUrl` strips exactly one trailing slash.
    #[test]
    fn base_urls_lose_exactly_one_trailing_slash() {
        assert_eq!(normalize_base_url("https://x/v1"), "https://x/v1");
        assert_eq!(normalize_base_url("https://x/v1/"), "https://x/v1");
        assert_eq!(normalize_base_url("https://x/v1//"), "https://x/v1/");
        assert_eq!(
            build_chat_url("https://x/v1"),
            "https://x/v1/chat/completions"
        );
        assert_eq!(
            build_chat_url("https://x/v1/"),
            "https://x/v1/chat/completions"
        );
        assert_eq!(build_models_url("https://x/v1"), "https://x/v1/models");
    }

    /// The delimiters and the stripping behaviour come from the same pattern,
    /// so the fixtures below cannot drift away from the regex.
    #[test]
    fn thinking_blocks_are_stripped_and_the_result_is_trimmed() {
        let (open, close) = crate::model_hub::tests::think_delimiters();
        assert_eq!(
            strip_thinking_blocks(&format!("a{open}hidden{close}b")),
            "ab"
        );
        assert_eq!(
            strip_thinking_blocks(&format!("  a{open}hidden{close}  ")),
            "a"
        );
        // An unterminated block is left alone; only the trailing trim applies.
        let unterminated = format!("a{open}");
        assert_eq!(strip_thinking_blocks(&unterminated), unterminated);
        // `.*?` is lazy, so two complete blocks are removed one at a time and the
        // text between them survives.
        assert_eq!(
            strip_thinking_blocks(&format!("{open}x{close}between{open}y{close}")),
            "between"
        );
        // `[\s\S]*?` also spans newlines.
        assert_eq!(
            strip_thinking_blocks(&format!("a{open}\nmulti\nline\n{close}b")),
            "ab"
        );
        assert_eq!(strip_thinking_blocks("plain"), "plain");
    }

    /// The pattern carries the `i` flag, so an upper-case block is stripped too,
    /// and only the configured delimiters are ever stripped.
    #[test]
    fn only_the_configured_delimiters_are_stripped() {
        assert_eq!(strip_thinking_blocks("<THINK>x</THINK>"), "");
        assert_eq!(
            strip_thinking_blocks("<reasoning>x</reasoning>"),
            "<reasoning>x</reasoning>"
        );
    }

    /// `slice` counts UTF-16 code units, so an emoji is two units wide and a cut
    /// through it yields U+FFFD.
    #[test]
    fn js_slice_counts_utf16_code_units() {
        assert_eq!(js_slice_utf16("abcde", 3), "abc");
        assert_eq!(js_slice_utf16("ab\u{1f600}cde", 3), "ab\u{fffd}");
        assert_eq!(js_slice_utf16("ab\u{1f600}cde", 4), "ab\u{1f600}");
        assert_eq!(js_slice_utf16("äöü", 2), "äö");
        assert_eq!(js_slice_utf16("short", 100), "short");
    }
}
