//! Port of `src/server/model-hub/Models/openai-codex/mappers/requestMapper.ts`.
//!
//! The Responses request body is fixed apart from the model, the input array,
//! the instructions and the optional reasoning/tools:
//!
//! ```text
//! { model, store: false, stream: true, input, text, include, tool_choice,
//!   parallel_tool_calls, instructions, reasoning?, tools? }
//! ```
//!
//! `max_tokens` and `temperature` are **not** sent, although `GatewayRequest`
//! carries them — `openai-codex-models.test.ts:149` asserts that a
//! `temperature` from the caller never reaches the body.

use serde_json::{json, Map, Value};

use crate::model_hub::openai_compatible::utils::AttachmentStore;
use crate::model_hub::types::{GatewayRequest, GatewayRole};

use super::super::client::config::clamp_codex_reasoning_effort;
use super::super::constants::DEFAULT_CODEX_INSTRUCTIONS;
use super::super::types::CodexReasoningEffort;
use super::super::utils::{is_truthy, js_string_value};
use super::message_mapper::build_codex_input_messages;
use super::tool_mapper::map_codex_tools;

/// `mapResponseFormat` from `requestMapper.ts:8-33`.
///
/// A `{ type: 'json_object' }` wins first. `json_schema` needs both a truthy
/// `name` and a truthy `schema`, and `strict` defaults to `true` — only an
/// explicit `false` turns it off. When nothing matched, only
/// `responseMimeType === 'application/json'` still yields a format.
pub fn map_response_format(
    value: Option<&Value>,
    response_mime_type: Option<&str>,
) -> Option<Value> {
    if let Some(object) = value.and_then(Value::as_object) {
        match object.get("type").and_then(Value::as_str) {
            Some("json_object") => return Some(json!({ "type": "json_object" })),
            Some("json_schema") => {
                if let Some(json_schema) = object.get("json_schema").and_then(Value::as_object) {
                    let name = json_schema
                        .get("name")
                        .filter(|value| is_truthy(value))
                        .map(js_string_value);
                    let schema = json_schema.get("schema").filter(|value| is_truthy(value));
                    if let (Some(name), Some(schema)) = (name, schema) {
                        let mut format = Map::new();
                        format.insert("type".to_string(), Value::from("json_schema"));
                        format.insert("name".to_string(), Value::from(name));
                        format.insert("schema".to_string(), schema.clone());
                        format.insert(
                            "strict".to_string(),
                            Value::from(!matches!(
                                json_schema.get("strict"),
                                Some(Value::Bool(false))
                            )),
                        );
                        return Some(Value::Object(format));
                    }
                }
            }
            _ => {}
        }
    }

    (response_mime_type == Some("application/json")).then(|| json!({ "type": "json_object" }))
}

/// `buildCodexRequestBody` from `requestMapper.ts:35-76`.
///
/// The instructions are `systemInstruction` when it trims to something, else the
/// joined system messages, else [`DEFAULT_CODEX_INSTRUCTIONS`]. `text` always
/// carries `verbosity: 'medium'` and gains `format` only when a response format
/// was resolved.
pub fn build_codex_request_body(request: &GatewayRequest, store: &dyn AttachmentStore) -> Value {
    let system_parts: Vec<&str> = request
        .messages
        .iter()
        .filter(|message| message.role == GatewayRole::System)
        .map(|message| message.content.trim())
        .filter(|content| !content.is_empty())
        .collect();

    let instructions = request
        .system_instruction
        .as_deref()
        .map(str::trim)
        .filter(|instruction| !instruction.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if system_parts.is_empty() {
                DEFAULT_CODEX_INSTRUCTIONS.to_string()
            } else {
                system_parts.join("\n\n")
            }
        });

    let mut text = Map::new();
    text.insert("verbosity".to_string(), Value::from("medium"));
    if let Some(response_format) = map_response_format(
        request.response_format.as_ref(),
        request.response_mime_type.as_deref(),
    ) {
        text.insert("format".to_string(), response_format);
    }

    let mut body = Map::new();
    body.insert("model".to_string(), Value::from(request.model.clone()));
    body.insert("store".to_string(), Value::from(false));
    body.insert("stream".to_string(), Value::from(true));
    body.insert(
        "input".to_string(),
        Value::Array(build_codex_input_messages(&request.messages, store)),
    );
    body.insert("text".to_string(), Value::Object(text));
    body.insert(
        "include".to_string(),
        json!(["reasoning.encrypted_content"]),
    );
    body.insert("tool_choice".to_string(), Value::from("auto"));
    body.insert("parallel_tool_calls".to_string(), Value::from(true));
    body.insert("instructions".to_string(), Value::from(instructions));

    if let Some(effort) = request.reasoning_effort {
        body.insert(
            "reasoning".to_string(),
            json!({
                "effort": clamp_codex_reasoning_effort(
                    &request.model,
                    CodexReasoningEffort::from(effort),
                )
                .as_str(),
                "summary": "auto",
            }),
        );
    }

    let tools = map_codex_tools(request.tools.as_deref());
    if !tools.is_empty() {
        body.insert("tools".to_string(), Value::Array(tools));
    }

    Value::Object(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_hub::openai_compatible::utils::AttachmentStore;
    use crate::model_hub::types::{
        GatewayMessage, GatewayMessageAttachment, GatewayReasoningEffort,
    };
    use serde_json::json;

    struct EmptyStore;

    impl AttachmentStore for EmptyStore {
        fn read(&self, _attachment: &GatewayMessageAttachment) -> Result<Vec<u8>, String> {
            Err("no attachment".to_string())
        }
    }

    const EMPTY: EmptyStore = EmptyStore;

    fn request() -> GatewayRequest {
        GatewayRequest::new("gpt-5.3-codex", vec![GatewayMessage::user("hi")])
    }

    /// The exact key order of `requestMapper.ts:48-58`, which `JSON.stringify`
    /// would produce.
    #[test]
    fn the_body_keeps_the_field_order_of_the_typescript() {
        let body = build_codex_request_body(&request(), &EMPTY);
        assert_eq!(
            serde_json::to_string(&body).expect("json"),
            concat!(
                r#"{"model":"gpt-5.3-codex","store":false,"stream":true,"input":["#,
                r#"{"role":"user","content":[{"type":"input_text","text":"hi"}]}],"#,
                r#""text":{"verbosity":"medium"},"include":["reasoning.encrypted_content"],"#,
                r#""tool_choice":"auto","parallel_tool_calls":true,"#,
                r#""instructions":"You are a helpful coding assistant."}"#
            )
        );
    }

    /// `systemInstruction` wins when it trims to something, the joined system
    /// messages come second, the default last.
    #[test]
    fn the_instructions_fall_back_from_the_option_to_the_system_messages() {
        let mut with_system = request();
        with_system.messages = vec![
            GatewayMessage::new(GatewayRole::System, "  be terse  "),
            GatewayMessage::new(GatewayRole::System, "  "),
            GatewayMessage::new(GatewayRole::System, "and kind"),
            GatewayMessage::user("hi"),
        ];
        assert_eq!(
            build_codex_request_body(&with_system, &EMPTY)["instructions"],
            json!("be terse\n\nand kind")
        );

        with_system.system_instruction = Some("  verbatim  ".to_string());
        assert_eq!(
            build_codex_request_body(&with_system, &EMPTY)["instructions"],
            json!("verbatim")
        );

        with_system.system_instruction = Some("   ".to_string());
        assert_eq!(
            build_codex_request_body(&with_system, &EMPTY)["instructions"],
            json!("be terse\n\nand kind")
        );

        let mut no_system = request();
        no_system.system_instruction = Some("   ".to_string());
        assert_eq!(
            build_codex_request_body(&no_system, &EMPTY)["instructions"],
            json!(DEFAULT_CODEX_INSTRUCTIONS)
        );
    }

    /// `max_tokens` and `temperature` are dropped, and `reasoning` only appears
    /// with a `reasoning_effort`.
    #[test]
    fn unsupported_fields_are_dropped_and_reasoning_is_optional() {
        let mut request = request();
        request.max_tokens = Some(16);
        request.temperature = Some(0.7);
        let body = build_codex_request_body(&request, &EMPTY);
        assert!(body.get("max_tokens").is_none());
        assert!(body.get("temperature").is_none());
        assert!(body.get("reasoning").is_none());

        request.reasoning_effort = Some(GatewayReasoningEffort::Low);
        let body = build_codex_request_body(&request, &EMPTY);
        assert_eq!(
            body["reasoning"],
            json!({ "effort": "low", "summary": "auto" })
        );
    }

    #[test]
    fn tools_are_attached_only_when_the_list_maps_to_something() {
        let mut request = request();
        request.tools = Some(vec![json!({ "type": "custom", "name": "skipped" })]);
        assert!(build_codex_request_body(&request, &EMPTY)
            .get("tools")
            .is_none());

        request.tools = Some(vec![json!({ "type": "function", "name": "lookup" })]);
        assert_eq!(
            build_codex_request_body(&request, &EMPTY)["tools"],
            json!([{ "type": "function", "name": "lookup" }])
        );
    }

    /// `mapResponseFormat` from `requestMapper.ts:8-33`.
    #[test]
    fn the_response_format_is_mapped_into_text() {
        assert_eq!(
            map_response_format(Some(&json!({ "type": "json_object" })), None),
            Some(json!({ "type": "json_object" }))
        );
        assert_eq!(
            map_response_format(None, Some("application/json")),
            Some(json!({ "type": "json_object" }))
        );
        assert_eq!(map_response_format(None, Some("text/plain")), None);
        // An array and a scalar are not a format object.
        assert_eq!(map_response_format(Some(&json!([])), None), None);
        assert_eq!(map_response_format(Some(&json!("json_object")), None), None);

        // `json_schema` defaults to strict and honours an explicit `false`.
        assert_eq!(
            map_response_format(
                Some(&json!({
                    "type": "json_schema",
                    "json_schema": { "name": "answer", "schema": { "type": "object" } }
                })),
                None
            ),
            Some(json!({
                "type": "json_schema",
                "name": "answer",
                "schema": { "type": "object" },
                "strict": true
            }))
        );
        assert_eq!(
            map_response_format(
                Some(&json!({
                    "type": "json_schema",
                    "json_schema": {
                        "name": "answer",
                        "schema": { "type": "object" },
                        "strict": false
                    }
                })),
                None
            ),
            Some(json!({
                "type": "json_schema",
                "name": "answer",
                "schema": { "type": "object" },
                "strict": false
            }))
        );

        // A truthy `name` and a truthy `schema` are both required, and the
        // `json_object` mime type still matches afterwards.
        assert_eq!(
            map_response_format(
                Some(&json!({
                    "type": "json_schema",
                    "json_schema": { "name": "", "schema": { "type": "object" } }
                })),
                Some("application/json")
            ),
            Some(json!({ "type": "json_object" }))
        );
        assert_eq!(
            map_response_format(
                Some(&json!({
                    "type": "json_schema",
                    "json_schema": { "name": "answer", "schema": null }
                })),
                None
            ),
            None
        );

        // `String(name)` coerces a non-string name.
        assert_eq!(
            map_response_format(
                Some(&json!({
                    "type": "json_schema",
                    "json_schema": { "name": 7, "schema": { "type": "object" } }
                })),
                None
            )
            .expect("format")["name"],
            json!("7")
        );
    }

    /// `text.format` is set from the request's format or mime type, and the
    /// input comes from the message mapper.
    #[test]
    fn the_text_format_and_input_follow_the_request() {
        let mut with_mime = request();
        with_mime.response_mime_type = Some("application/json".to_string());
        assert_eq!(
            build_codex_request_body(&with_mime, &EMPTY)["text"],
            json!({ "verbosity": "medium", "format": { "type": "json_object" } })
        );

        let mut with_input = request();
        with_input.messages = vec![
            GatewayMessage::new(GatewayRole::System, "be terse"),
            GatewayMessage::new(GatewayRole::Assistant, "hello"),
            GatewayMessage::user("hi"),
        ];
        assert_eq!(
            build_codex_request_body(&with_input, &EMPTY)["input"],
            json!([
                {
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "id": "msg_0",
                    "content": [{ "type": "output_text", "text": "hello", "annotations": [] }]
                },
                { "role": "user", "content": [{ "type": "input_text", "text": "hi" }] }
            ])
        );
    }
}
