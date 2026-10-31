//! Port of `src/server/model-hub/Models/openai-codex/mappers/messageMapper.ts`.
//!
//! The conversation is converted into the Responses `input` array: user turns
//! become `{ role: 'user', content: [parts] }`, assistant turns become full
//! `message` items with a synthetic `msg_<n>` id, and **system** turns are
//! dropped here — their text is folded into `instructions` by
//! [`super::request_mapper`] instead.
//!
//! Binary attachments are only read for the *last* user message that has any
//! (`messageMapper.ts:9-16`); every earlier attachment degrades to its
//! placeholder text.

use serde_json::{json, Value};

use crate::model_hub::openai_compatible::utils::AttachmentStore;
use crate::model_hub::types::{GatewayMessage, GatewayRole};

use super::super::attachments::build_codex_user_content_parts;

/// `buildCodexInputMessages` from `messageMapper.ts:4-45`.
///
/// A user turn without text and without attachments contributes nothing, and an
/// assistant turn with only whitespace is dropped — but it does not consume an
/// `msg_` index.
pub fn build_codex_input_messages(
    messages: &[GatewayMessage],
    store: &dyn AttachmentStore,
) -> Vec<Value> {
    let mut converted: Vec<Value> = Vec::new();
    let mut assistant_index: usize = 0;

    // `latestUserAttachmentIndex`: the last user message with attachments.
    let mut latest_user_attachment_index: Option<usize> = None;
    for (index, message) in messages.iter().enumerate().rev() {
        if message.role != GatewayRole::User {
            continue;
        }
        if !message.attachments().is_empty() {
            latest_user_attachment_index = Some(index);
            break;
        }
    }

    for (index, message) in messages.iter().enumerate() {
        let content = message.content.trim();
        if message.role == GatewayRole::System {
            continue;
        }

        if message.role == GatewayRole::User {
            let parts = build_codex_user_content_parts(
                message,
                latest_user_attachment_index == Some(index),
                store,
            );
            if parts.is_empty() {
                continue;
            }
            converted.push(json!({ "role": "user", "content": parts }));
            continue;
        }

        if content.is_empty() {
            continue;
        }
        let id = format!("msg_{assistant_index}");
        assistant_index += 1;
        converted.push(json!({
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "id": id,
            "content": [{ "type": "output_text", "text": content, "annotations": [] }],
        }));
    }

    converted
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_hub::openai_compatible::utils::AttachmentStore;
    use crate::model_hub::types::GatewayMessageAttachment;
    use serde_json::json;

    /// A store that resolves nothing: every attachment degrades to its
    /// placeholder.
    struct EmptyStore;

    impl AttachmentStore for EmptyStore {
        fn read(&self, _attachment: &GatewayMessageAttachment) -> Result<Vec<u8>, String> {
            Err("no attachment".to_string())
        }
    }

    /// A store that answers every path with the same bytes.
    struct AnyStore(&'static [u8]);

    impl AttachmentStore for AnyStore {
        fn read(&self, _attachment: &GatewayMessageAttachment) -> Result<Vec<u8>, String> {
            Ok(self.0.to_vec())
        }
    }

    const EMPTY: EmptyStore = EmptyStore;

    fn user(content: &str) -> GatewayMessage {
        GatewayMessage::user(content)
    }

    fn assistant(content: &str) -> GatewayMessage {
        GatewayMessage::new(GatewayRole::Assistant, content)
    }

    fn system(content: &str) -> GatewayMessage {
        GatewayMessage::new(GatewayRole::System, content)
    }

    fn image(name: &str) -> GatewayMessageAttachment {
        GatewayMessageAttachment {
            name: name.to_string(),
            mime_type: "image/png".to_string(),
            size: 3,
            storage_path: "pixel.png".to_string(),
            sha256: None,
        }
    }

    /// System turns never reach `input`; their text becomes `instructions`.
    #[test]
    fn system_messages_are_dropped() {
        let converted = build_codex_input_messages(
            &[system("be terse"), user("hi"), assistant("hello")],
            &EMPTY,
        );
        assert_eq!(
            converted,
            vec![
                json!({ "role": "user", "content": [{ "type": "input_text", "text": "hi" }] }),
                json!({
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "id": "msg_0",
                    "content": [{ "type": "output_text", "text": "hello", "annotations": [] }],
                }),
            ]
        );
    }

    /// Only assistant turns consume an `msg_<n>` index, and their text is
    /// trimmed.
    #[test]
    fn assistant_messages_are_indexed_in_order() {
        let converted = build_codex_input_messages(
            &[
                assistant(" first "),
                user("hi"),
                assistant("second"),
                assistant("   "),
            ],
            &EMPTY,
        );
        assert_eq!(converted[0]["id"], json!("msg_0"));
        assert_eq!(converted[0]["content"][0]["text"], json!("first"));
        assert_eq!(converted[2]["id"], json!("msg_1"));
        // The whitespace-only assistant turn contributes nothing.
        assert_eq!(converted.len(), 3);
    }

    /// A user turn without text and without attachments is skipped, and one with
    /// only an attachment survives as the placeholder.
    #[test]
    fn empty_user_turns_are_skipped_unless_they_carry_attachments() {
        assert_eq!(
            build_codex_input_messages(&[user("  ")], &EMPTY),
            Vec::<Value>::new()
        );

        let mut with_attachment = user("");
        with_attachment.attachments = Some(vec![image("pixel.png")]);
        assert_eq!(
            build_codex_input_messages(&[with_attachment], &EMPTY),
            vec![json!({
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": "[Attachment: pixel.png (image/png, 3 bytes)]"
                }]
            })]
        );
    }

    /// `latestUserAttachmentIndex` is the *last* user message with attachments,
    /// so an earlier one keeps the placeholder while that one carries the image.
    #[test]
    fn only_the_last_user_message_with_attachments_reads_the_image() {
        let mut earlier = user("früher");
        earlier.attachments = Some(vec![image("old.png")]);
        let mut later = user("jetzt");
        later.attachments = Some(vec![image("new.png")]);
        // The trailing user message has no attachments and must not move the
        // index.
        let plain = user("danach");

        let converted = build_codex_input_messages(&[earlier, later, plain], &AnyStore(&[1, 2, 3]));
        assert_eq!(converted.len(), 3);
        assert_eq!(converted[0]["content"][1]["type"], json!("input_text"));
        assert_eq!(
            converted[0]["content"][1]["text"],
            json!("[Attachment: old.png (image/png, 3 bytes)]")
        );
        assert_eq!(converted[1]["content"][1]["type"], json!("input_image"));
        assert_eq!(
            converted[1]["content"][1]["image_url"],
            json!("data:image/png;base64,AQID")
        );
        assert_eq!(
            converted[2]["content"],
            json!([{ "type": "input_text", "text": "danach" }])
        );
    }
}
