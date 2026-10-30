//! Port of
//! `src/server/model-hub/Models/openai-codex/attachments/attachmentHandler.ts`.
//!
//! The file duplicates four helpers that also exist in the shared layer, and
//! they are *identical* line for line:
//!
//! | Codex TypeScript | Shared TypeScript | Rust |
//! | --- | --- | --- |
//! | `isImageAttachment` (`:7-9`) | `utils.ts:21-23` | [`is_image_attachment`] |
//! | `isTextAttachment` (`:11-14`) | `utils.ts:25-28` | [`is_text_attachment`] |
//! | `readTextAttachmentSnippet` (`:20-32`) | `utils.ts:30-40` | [`read_text_attachment_snippet`] |
//! | `toAttachmentFallbackText` (`:16-18`) | `utils.ts:42-44` | [`to_attachment_fallback_text`] |
//!
//! The port calls the shared [`crate::model_hub::openai_compatible`] helpers for
//! the first three instead of copying them. The fourth differs in one argument:
//! `attachmentHandler.ts:70` passes the *resolved* mime type, so an attachment
//! without one renders `application/octet-stream` instead of an empty string,
//! which is why the template is re-declared here.
//!
//! `readStoredAttachmentBuffer` resolves `storagePath` against the persona's
//! attachment root and refuses escapes; that path belongs to the channels slice,
//! so it arrives through the [`AttachmentStore`] seam, as in the shared layer.

use serde_json::{json, Value};

use crate::model_hub::openai_compatible::utils::{
    is_image_attachment, is_text_attachment, read_stored_attachment_as_data_url,
    read_text_attachment_snippet, AttachmentStore,
};
use crate::model_hub::types::GatewayMessage;

/// `attachment.mimeType || 'application/octet-stream'` from
/// `attachmentHandler.ts:45`.
pub const DEFAULT_ATTACHMENT_MIME_TYPE: &str = "application/octet-stream";

/// `toAttachmentFallbackText(name, mimeType, size)` from
/// `attachmentHandler.ts:16-18`.
pub fn to_attachment_fallback_text(name: &str, mime_type: &str, size: i64) -> String {
    format!("[Attachment: {name} ({mime_type}, {size} bytes)]")
}

/// `buildCodexUserContentParts` from `attachmentHandler.ts:34-74`.
///
/// The text content comes first, then one part per attachment. An image becomes
/// `input_image` and a readable text attachment becomes `input_text` with a
/// `Attachment <name> (<mime>):` header line; everything else — including a
/// binary attachment when `include_binary_attachments` is `false`, which is the
/// case for every message except the latest user message with attachments
/// (`messageMapper.ts:9-16`) — degrades to the placeholder text.
pub fn build_codex_user_content_parts(
    message: &GatewayMessage,
    include_binary_attachments: bool,
    store: &dyn AttachmentStore,
) -> Vec<Value> {
    let mut parts: Vec<Value> = Vec::new();

    let trimmed_content = message.content.trim();
    if !trimmed_content.is_empty() {
        parts.push(json!({ "type": "input_text", "text": trimmed_content }));
    }

    for attachment in message.attachments() {
        let mime_type = if attachment.mime_type.is_empty() {
            DEFAULT_ATTACHMENT_MIME_TYPE
        } else {
            attachment.mime_type.as_str()
        };

        if include_binary_attachments && is_image_attachment(mime_type) {
            if let Some(data_url) = read_stored_attachment_as_data_url(store, attachment) {
                parts.push(json!({ "type": "input_image", "image_url": data_url }));
                continue;
            }
        }

        if include_binary_attachments && is_text_attachment(mime_type) {
            if let Some(snippet) = read_text_attachment_snippet(store, attachment) {
                parts.push(json!({
                    "type": "input_text",
                    "text": format!("Attachment {} ({}):\n{}", attachment.name, mime_type, snippet),
                }));
                continue;
            }
        }

        parts.push(json!({
            "type": "input_text",
            "text": to_attachment_fallback_text(&attachment.name, mime_type, attachment.size),
        }));
    }

    parts
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::model_hub::types::GatewayMessageAttachment;
    use serde_json::json;

    struct MapStore(HashMap<String, Vec<u8>>);

    impl AttachmentStore for MapStore {
        fn read(&self, attachment: &GatewayMessageAttachment) -> Result<Vec<u8>, String> {
            self.0
                .get(&attachment.storage_path)
                .cloned()
                .ok_or_else(|| "Attachment storage path is empty.".to_string())
        }
    }

    fn store(files: &[(&str, &[u8])]) -> MapStore {
        MapStore(
            files
                .iter()
                .map(|(path, bytes)| ((*path).to_string(), bytes.to_vec()))
                .collect(),
        )
    }

    fn attachment(name: &str, mime_type: &str, path: &str, size: i64) -> GatewayMessageAttachment {
        GatewayMessageAttachment {
            name: name.to_string(),
            mime_type: mime_type.to_string(),
            size,
            storage_path: path.to_string(),
            sha256: None,
        }
    }

    fn message(content: &str, attachments: Vec<GatewayMessageAttachment>) -> GatewayMessage {
        GatewayMessage {
            role: crate::model_hub::types::GatewayRole::User,
            content: content.to_string(),
            attachments: (!attachments.is_empty()).then_some(attachments),
        }
    }

    #[test]
    fn a_text_only_message_yields_one_input_text_part() {
        let parts =
            build_codex_user_content_parts(&message("  hallo  ", Vec::new()), true, &store(&[]));
        assert_eq!(
            parts,
            vec![json!({ "type": "input_text", "text": "hallo" })]
        );
    }

    #[test]
    fn an_empty_message_has_no_parts() {
        assert_eq!(
            build_codex_user_content_parts(&message("   ", Vec::new()), true, &store(&[])),
            Vec::<Value>::new()
        );
    }

    #[test]
    fn an_image_becomes_an_input_image_part() {
        let store = store(&[("pixel.png", &[1u8, 2, 3])]);
        let parts = build_codex_user_content_parts(
            &message(
                "sieh",
                vec![attachment("pixel.png", "image/png", "pixel.png", 3)],
            ),
            true,
            &store,
        );
        assert_eq!(
            parts,
            vec![
                json!({ "type": "input_text", "text": "sieh" }),
                json!({ "type": "input_image", "image_url": "data:image/png;base64,AQID" }),
            ]
        );
    }

    /// Only the latest user message with attachments reads binary data; every
    /// other one gets the placeholder.
    #[test]
    fn binary_attachments_are_only_read_when_included() {
        let store = store(&[("pixel.png", &[1u8, 2, 3])]);
        let parts = build_codex_user_content_parts(
            &message(
                "sieh",
                vec![attachment("pixel.png", "image/png", "pixel.png", 3)],
            ),
            false,
            &store,
        );
        assert_eq!(
            parts,
            vec![
                json!({ "type": "input_text", "text": "sieh" }),
                json!({
                    "type": "input_text",
                    "text": "[Attachment: pixel.png (image/png, 3 bytes)]"
                }),
            ]
        );
    }

    /// `attachment.mimeType || 'application/octet-stream'`.
    #[test]
    fn the_placeholder_uses_the_resolved_mime_type() {
        let parts = build_codex_user_content_parts(
            &message("x", vec![attachment("blob", "", "blob.bin", 12)]),
            true,
            &store(&[("blob.bin", &[1u8])]),
        );
        assert_eq!(
            parts[1],
            json!({
                "type": "input_text",
                "text": "[Attachment: blob (application/octet-stream, 12 bytes)]"
            })
        );
    }

    /// A text attachment is inlined under an `Attachment <name> (<mime>):`
    /// header, with the NUL bytes stripped by the shared reader.
    #[test]
    fn a_text_attachment_is_inlined() {
        let store = store(&[("notes.txt", b"line\0 one\nline two")]);
        let parts = build_codex_user_content_parts(
            &message(
                "x",
                vec![attachment("notes.txt", "text/plain", "notes.txt", 19)],
            ),
            true,
            &store,
        );
        assert_eq!(
            parts[1],
            json!({
                "type": "input_text",
                "text": "Attachment notes.txt (text/plain):\nline one\nline two"
            })
        );
    }

    /// `text/` with parameters and `application/json` both count as text.
    #[test]
    fn parameterised_text_types_and_json_are_inlined() {
        let store = store(&[("a.md", b"# title"), ("b.json", b"{}")]);
        let parts = build_codex_user_content_parts(
            &message(
                "x",
                vec![
                    attachment("a.md", "text/markdown; charset=utf-8", "a.md", 7),
                    attachment("b.json", "APPLICATION/JSON", "b.json", 2),
                ],
            ),
            true,
            &store,
        );
        assert_eq!(
            parts[1]["text"],
            json!("Attachment a.md (text/markdown; charset=utf-8):\n# title")
        );
        assert_eq!(
            parts[2]["text"],
            json!("Attachment b.json (APPLICATION/JSON):\n{}")
        );
    }

    /// An unreadable attachment degrades to the placeholder, for an image and
    /// for a text file alike.
    #[test]
    fn an_unreadable_attachment_degrades_to_the_placeholder() {
        let parts = build_codex_user_content_parts(
            &message(
                "x",
                vec![
                    attachment("gone.png", "image/png", "gone.png", 1),
                    attachment("gone.txt", "text/plain", "gone.txt", 2),
                ],
            ),
            true,
            &store(&[]),
        );
        assert_eq!(
            parts,
            vec![
                json!({ "type": "input_text", "text": "x" }),
                json!({
                    "type": "input_text",
                    "text": "[Attachment: gone.png (image/png, 1 bytes)]"
                }),
                json!({
                    "type": "input_text",
                    "text": "[Attachment: gone.txt (text/plain, 2 bytes)]"
                }),
            ]
        );
    }
}
