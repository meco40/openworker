//! Shared test doubles for the model-hub slice.
//!
//! `openai_compatible` decides whether an attachment is inlined as a data URL or
//! a text snippet, or degraded to its placeholder. Both paths run through the
//! [`AttachmentStore`] seam, so the golden-file tests of `request/build.ts` need
//! a store that resolves the file behind a known `storagePath` and refuses
//! everything else. That double lives here because two modules import it
//! (`openai_compatible` itself and `openai_compatible::request`).

use crate::model_hub::openai_compatible::utils::AttachmentStore;
use crate::model_hub::types::GatewayMessageAttachment;

/// An in-memory [`AttachmentStore`] keyed by `storagePath`.
///
/// The MIME type in the constructor argument is accepted for symmetry with
/// [`GatewayMessageAttachment`] but deliberately ignored: the TypeScript
/// `readStoredAttachmentBuffer` takes the bytes from the resolved path alone and
/// never inspects the declared type, so a test may omit it without changing
/// behaviour.
#[derive(Debug, Clone, Default)]
pub struct StubAttachmentStore {
    files: Vec<(String, Vec<u8>)>,
}

impl StubAttachmentStore {
    /// Builds a store from `(storagePath, mimeType, bytes)` triples.
    pub fn new(files: Vec<(&str, &str, Vec<u8>)>) -> Self {
        Self {
            files: files
                .into_iter()
                .map(|(path, _mime_type, bytes)| (path.to_string(), bytes))
                .collect(),
        }
    }
}

impl AttachmentStore for StubAttachmentStore {
    fn read(&self, attachment: &GatewayMessageAttachment) -> Result<Vec<u8>, String> {
        self.files
            .iter()
            .find(|(path, _)| path == &attachment.storage_path)
            .map(|(_, bytes)| bytes.clone())
            .ok_or_else(|| format!("Attachment not found: {}", attachment.storage_path))
    }
}

/// The open and close delimiters of `THINK_BLOCK_REGEX_PATTERN`.
///
/// The fixtures for `stripThinkingBlocks` derive them from the pattern instead
/// of repeating the literal, so a test cannot drift away from the regex it is
/// meant to exercise.
pub fn think_delimiters() -> (&'static str, &'static str) {
    use crate::model_hub::openai_compatible::constants::THINK_BLOCK_REGEX_PATTERN;

    let body = THINK_BLOCK_REGEX_PATTERN.trim_start_matches("(?is)");
    body.split_once(".*?")
        .expect("the think pattern is open delimiter, body, close delimiter")
}

#[cfg(test)]
mod stub_store_tests {
    use super::*;

    fn attachment(storage_path: &str) -> GatewayMessageAttachment {
        GatewayMessageAttachment {
            name: storage_path.to_string(),
            mime_type: "image/png".to_string(),
            size: 7,
            storage_path: storage_path.to_string(),
            sha256: None,
        }
    }

    #[test]
    fn resolves_a_registered_storage_path() {
        let store = StubAttachmentStore::new(vec![("a.png", "image/png", b"PNGDATA".to_vec())]);
        assert_eq!(store.read(&attachment("a.png")).expect("read"), b"PNGDATA");
    }

    #[test]
    fn an_unknown_path_is_an_error_not_a_panic() {
        let store = StubAttachmentStore::default();
        let error = store.read(&attachment("missing.png")).expect_err("missing");
        assert!(error.contains("missing.png"), "{error}");
    }

    /// An empty byte slice must survive the lookup, because
    /// `readStoredAttachmentAsDataUrl` returns `null` for it rather than
    /// treating it as an error.
    #[test]
    fn an_empty_file_is_not_an_error() {
        let store = StubAttachmentStore::new(vec![("empty.txt", "text/plain", Vec::new())]);
        assert_eq!(
            store.read(&attachment("empty.txt")).expect("read"),
            Vec::<u8>::new()
        );
    }
}
