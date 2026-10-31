//! Port of `src/server/model-hub/Models/shared/openai-compatible/request/`:
//! `build.ts`, `headers.ts` and `stream.ts`.
//!
//! This module produces the request body that the provider golden-file tests
//! compare byte for byte. Two properties are load-bearing:
//!
//! - **Key order.** The TypeScript body is an object literal whose insertion order
//!   is `model`, `messages`, `max_tokens`, `temperature`, `stream`, then the
//!   optional `tools`, `response_format`, `reasoning_effort` and
//!   `chat_template_kwargs`. `serde_json` is built with the workspace's
//!   `preserve_order` feature, so inserting into a `Map` in that order produces the
//!   same string.
//! - **Optional key insertion.** The optional keys are *assigned* in the order the
//!   function writes them, so each one lands after `stream` instead of being
//!   alphabetised.

use serde_json::{Map, Value};

use super::constants::{
    CONTENT_TYPE_JSON, DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE, REASONING_EFFORT_PROVIDERS,
};
use super::utils::{
    attachment_fallback_text, build_optional_auth_headers, is_image_attachment, is_text_attachment,
    read_stored_attachment_as_data_url, read_text_attachment_snippet, AttachmentStore,
    NOOP_ATTACHMENT_STORE,
};
use crate::model_hub::http::resolve_model_hub_gateway_timeout_ms_with;
use crate::model_hub::types::{
    GatewayMessage, GatewayMessageAttachment, GatewayReasoningEffort, GatewayRequest, GatewayRole,
};

/// `mapResponseFormat` from `request/build.ts:12-36`.
///
/// Three accepted shapes, in order: a bare `{ type: 'json_object' }`, a
/// `json_schema` whose `name` **and** `schema` are both truthy, and the
/// `responseMimeType` fallback. `strict` defaults to `true` and only an explicit
/// `false` disables it.
fn map_response_format(value: Option<&Value>, response_mime_type: Option<&str>) -> Option<Value> {
    if let Some(Value::Object(typed)) = value {
        let kind = typed.get("type").and_then(Value::as_str);
        if kind == Some("json_object") {
            return Some(object([("type", Value::from("json_object"))]));
        }
        if kind == Some("json_schema") {
            let json_schema = typed.get("json_schema").filter(|schema| schema.is_object());
            // `Option::filter` hands the predicate a `&&Value`, hence the closure.
            let name = json_schema
                .and_then(|schema| schema.get("name"))
                .filter(|name| is_truthy(name));
            let schema = json_schema
                .and_then(|schema| schema.get("schema"))
                .filter(|schema| is_truthy(schema));
            if let (Some(name), Some(schema)) = (name, schema) {
                let strict = json_schema
                    .and_then(|inner| inner.get("strict"))
                    .map(|strict| strict != &Value::Bool(false))
                    .unwrap_or(true);
                return Some(object([
                    ("type", Value::from("json_schema")),
                    (
                        "json_schema",
                        // `String(typed.json_schema.name)` coerces a non-string name.
                        object([
                            ("name", json_string(name)),
                            ("schema", schema.clone()),
                            ("strict", Value::from(strict)),
                        ]),
                    ),
                ]));
            }
        }
    }

    if response_mime_type == Some("application/json") {
        return Some(object([("type", Value::from("json_object"))]));
    }
    None
}

fn object<const N: usize>(entries: [(&str, Value); N]) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key.to_string(), value);
    }
    Value::Object(map)
}

/// JavaScript truthiness for the `json_schema` guard. `0` and `""` are falsy.
fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `String(value)` for the `json_schema.name` coercion.
fn json_string(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(text.clone()),
        Value::Null => Value::String("null".to_string()),
        Value::Bool(flag) => Value::String(flag.to_string()),
        Value::Number(number) => Value::String(number.to_string()),
        other => Value::String(other.to_string()),
    }
}

/// `findLatestUserAttachmentIndex` from `request/build.ts:38-45`.
///
/// Only the **last** user message that carries at least one attachment may inline
/// binary data; every earlier one degrades to a text placeholder.
fn find_latest_user_attachment_index(messages: &[GatewayMessage]) -> Option<usize> {
    messages
        .iter()
        .enumerate()
        .rev()
        .find(|(_, message)| message.role == GatewayRole::User && !message.attachments().is_empty())
        .map(|(index, _)| index)
}

/// `buildContentParts` from `request/build.ts:47-101`.
fn build_content_parts(
    store: &dyn AttachmentStore,
    message: &GatewayMessage,
    include_binary_attachment: bool,
) -> Vec<Value> {
    let mut content_parts: Vec<Value> = Vec::new();
    let mut text_parts: Vec<String> = Vec::new();

    let trimmed_content = message.content.trim();
    if !trimmed_content.is_empty() {
        text_parts.push(trimmed_content.to_string());
    }

    for attachment in message.attachments() {
        if include_binary_attachment && is_image_attachment(&attachment.mime_type) {
            if let Some(data_url) = read_stored_attachment_as_data_url(store, attachment) {
                if !text_parts.is_empty() {
                    content_parts.push(text_part(&text_parts.join("\n\n")));
                    text_parts.clear();
                }
                content_parts.push(object([
                    ("type", Value::from("image_url")),
                    ("image_url", object([("url", Value::from(data_url))])),
                ]));
                continue;
            }
        }

        if include_binary_attachment && is_text_attachment(&attachment.mime_type) {
            if let Some(snippet) = read_text_attachment_snippet(store, attachment) {
                text_parts.push(format!(
                    "Attachment {} ({}):\n{}",
                    attachment.name, attachment.mime_type, snippet
                ));
                continue;
            }
        }

        text_parts.push(attachment_fallback_text(attachment));
    }

    if !text_parts.is_empty() {
        content_parts.push(text_part(&text_parts.join("\n\n")));
    }

    content_parts
}

fn text_part(text: &str) -> Value {
    object([("type", Value::from("text")), ("text", Value::from(text))])
}

/// `buildOpenAICompatibleMessages` from `request/build.ts:103-132`.
///
/// A message keeps its plain string content unless it is a **user** message with at
/// least one attachment *and* the resulting part list is non-empty.
pub fn build_openai_compatible_messages(
    store: &dyn AttachmentStore,
    messages: &[GatewayMessage],
) -> Vec<Value> {
    let latest_user_attachment_index = find_latest_user_attachment_index(messages);

    messages
        .iter()
        .enumerate()
        .map(|(index, message)| {
            let is_user_with_attachments =
                message.role == GatewayRole::User && !message.attachments().is_empty();
            let content = if is_user_with_attachments {
                let parts = build_content_parts(
                    store,
                    message,
                    latest_user_attachment_index == Some(index),
                );
                if parts.is_empty() {
                    Value::String(message.content.clone())
                } else {
                    Value::Array(parts)
                }
            } else {
                Value::String(message.content.clone())
            };

            object([
                ("role", Value::from(message.role.as_str())),
                ("content", content),
            ])
        })
        .collect()
}

/// `buildRequestBody` from `request/build.ts:134-172`.
///
/// `request.max_tokens ?? 4096` and `request.temperature ?? 0.7` are nullish
/// coalescing, so an explicit `0` survives; only `undefined`/`null` fall back.
/// `stream` is coerced with `=== true`.
pub fn build_request_body_with_attachments(
    store: &dyn AttachmentStore,
    request: &GatewayRequest,
    provider_id: &str,
) -> Value {
    let mut body = Map::new();
    body.insert("model".to_string(), Value::from(request.model.clone()));
    body.insert(
        "messages".to_string(),
        Value::Array(build_openai_compatible_messages(store, &request.messages)),
    );
    body.insert(
        "max_tokens".to_string(),
        Value::from(request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS)),
    );
    body.insert(
        "temperature".to_string(),
        Value::from(request.temperature.unwrap_or(DEFAULT_TEMPERATURE)),
    );
    body.insert(
        "stream".to_string(),
        Value::Bool(request.stream == Some(true)),
    );

    if let Some(tools) = request.tools.as_ref().filter(|tools| !tools.is_empty()) {
        body.insert("tools".to_string(), Value::Array(tools.clone()));
    }

    if let Some(response_format) = map_response_format(
        request.response_format.as_ref(),
        request.response_mime_type.as_deref(),
    ) {
        body.insert("response_format".to_string(), response_format);
    }

    // `request/build.ts:157` hard-codes this list; it is *not* the exported
    // `PROVIDERS_SUPPORTING_REASONING_EFFORT` constant, which is unused.
    if let Some(effort) = request
        .reasoning_effort
        .filter(|_| REASONING_EFFORT_PROVIDERS.contains(&provider_id))
    {
        body.insert("reasoning_effort".to_string(), Value::from(effort.as_str()));
    }

    // Nemotron 3.5 Lightning exposes its actual thinking switch through the
    // OpenAI-compatible chat-template kwargs. Keep reasoning_effort as the
    // gateway-level setting, but also make the native on/off intent explicit.
    if provider_id == "opencode" && request.reasoning_effort.is_some() {
        let enable_thinking = request.reasoning_effort != Some(GatewayReasoningEffort::None);
        body.insert(
            "chat_template_kwargs".to_string(),
            object([("enable_thinking", Value::from(enable_thinking))]),
        );
    }

    Value::Object(body)
}

/// [`build_request_body_with_attachments`] with a store that never resolves a
/// file, which reproduces the TypeScript behaviour of degrading every attachment
/// to its placeholder text.
pub fn build_request_body(request: &GatewayRequest, provider_id: &str) -> Value {
    build_request_body_with_attachments(&NOOP_ATTACHMENT_STORE, request, provider_id)
}

/// `buildRequestHeaders` from `request/headers.ts:4-11`.
///
/// Spread order is `Content-Type`, the optional `Authorization`, then
/// `extraHeaders` — so a caller can override both. `extraHeaders` is a slice rather
/// than a map because the TypeScript type is a `Record` whose iteration order
/// follows insertion order, and OpenRouter sends `HTTP-Referer` before `X-Title`.
pub fn build_request_headers(
    secret: &str,
    extra_headers: &[(String, String)],
) -> Vec<(String, String)> {
    let mut headers: Vec<(String, String)> =
        vec![("Content-Type".to_string(), CONTENT_TYPE_JSON.to_string())];
    if let Some(authorization) = build_optional_auth_headers(secret) {
        headers.push(("Authorization".to_string(), authorization));
    }
    for (name, value) in extra_headers {
        match headers.iter_mut().find(|(key, _)| key == name) {
            Some(slot) => slot.1 = value.clone(),
            None => headers.push((name.clone(), value.clone())),
        }
    }
    headers
}

/// `shouldUseStream` from `request/stream.ts:3-5`.
pub fn should_use_stream(request_stream: Option<bool>) -> bool {
    request_stream == Some(true)
}

/// `resolveTimeoutMs` from `request/stream.ts:7-9`, with the environment injected.
pub fn resolve_timeout_ms_with(
    has_tools: bool,
    gateway_timeout: Option<&str>,
    exec_timeout: Option<&str>,
) -> u64 {
    resolve_model_hub_gateway_timeout_ms_with(has_tools, gateway_timeout, exec_timeout)
}

/// `resolveTimeoutMs(hasTools)` reading `process.env`.
pub fn resolve_timeout_ms(has_tools: bool) -> u64 {
    resolve_model_hub_gateway_timeout_ms_with(
        has_tools,
        std::env::var("MODEL_HUB_GATEWAY_TIMEOUT_MS")
            .ok()
            .as_deref(),
        std::env::var("MODEL_HUB_GATEWAY_EXEC_TIMEOUT_MS")
            .ok()
            .as_deref(),
    )
}

/// Builds an attachment stub, used by the providers and the tests.
pub fn attachment(
    name: &str,
    mime_type: &str,
    size: i64,
    storage_path: &str,
) -> GatewayMessageAttachment {
    GatewayMessageAttachment {
        name: name.to_string(),
        mime_type: mime_type.to_string(),
        size,
        storage_path: storage_path.to_string(),
        sha256: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_hub::tests::StubAttachmentStore;

    /// The exact body of `openai-compatible-tools.test.ts`, case 1: no optional
    /// keys, so only the five defaults are present.
    #[test]
    fn builds_the_default_body_without_optional_keys() {
        let request = GatewayRequest::new("gpt-4o-mini", vec![GatewayMessage::user("hello")]);
        let body = build_request_body(&request, "openai");
        assert_eq!(
            serde_json::to_string(&body).expect("serialize"),
            r#"{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}],"max_tokens":4096,"temperature":0.7,"stream":false}"#
        );
    }

    /// Key order is part of the contract, so assert the raw JSON string.
    #[test]
    fn preserves_the_typescript_key_order() {
        let mut request = GatewayRequest::new("m", vec![GatewayMessage::user("hi")]);
        request.tools = Some(vec![serde_json::json!({
            "type": "function",
            "function": { "name": "safe_files", "parameters": { "type": "object", "properties": {} } }
        })]);
        request.reasoning_effort = Some(GatewayReasoningEffort::High);
        assert_eq!(
            serde_json::to_string(&build_request_body(&request, "openai")).expect("serialize"),
            r#"{"model":"m","messages":[{"role":"user","content":"hi"}],"max_tokens":4096,"temperature":0.7,"stream":false,"tools":[{"type":"function","function":{"name":"safe_files","parameters":{"type":"object","properties":{}}}}],"reasoning_effort":"high"}"#
        );
    }

    /// `request.max_tokens ?? DEFAULT` — an explicit zero is not replaced.
    #[test]
    fn nullish_coalescing_keeps_explicit_zero() {
        let mut request = GatewayRequest::new("m", vec![GatewayMessage::user("hi")]);
        request.max_tokens = Some(0);
        request.temperature = Some(0.0);
        let body = build_request_body(&request, "openai");
        assert_eq!(body["max_tokens"], 0);
        assert_eq!(body["temperature"], 0.0);
    }

    #[test]
    fn empty_tools_are_omitted_but_present_tools_are_forwarded() {
        let mut request = GatewayRequest::new("m", vec![GatewayMessage::user("hi")]);
        request.tools = Some(Vec::new());
        assert!(build_request_body(&request, "openai")
            .get("tools")
            .is_none());

        request.tools = Some(vec![
            serde_json::json!({ "function": { "name": "safe_files" } }),
        ]);
        assert_eq!(
            build_request_body(&request, "openai")["tools"][0]["function"]["name"],
            "safe_files"
        );
    }

    /// Case 3 of the golden test: a `json_schema` passes through with `strict`
    /// preserved.
    #[test]
    fn forwards_a_json_schema_response_format() {
        let mut request =
            GatewayRequest::new("json-model", vec![GatewayMessage::user("return JSON")]);
        request.response_format = Some(serde_json::json!({
            "type": "json_schema",
            "json_schema": {
                "name": "entities",
                "schema": { "type": "object", "properties": { "entities": { "type": "array" } } },
                "strict": true
            }
        }));
        assert_eq!(
            build_request_body(&request, "openrouter")["response_format"],
            serde_json::json!({
                "type": "json_schema",
                "json_schema": {
                    "name": "entities",
                    "schema": { "type": "object", "properties": { "entities": { "type": "array" } } },
                    "strict": true
                }
            })
        );
    }

    #[test]
    fn strict_defaults_to_true_and_only_false_disables_it() {
        let schema_for = |strict: Option<Value>| {
            let mut json_schema = Map::new();
            json_schema.insert("name".to_string(), Value::from("s"));
            json_schema.insert(
                "schema".to_string(),
                serde_json::json!({ "type": "object" }),
            );
            if let Some(strict) = strict {
                json_schema.insert("strict".to_string(), strict);
            }
            let mut outer = Map::new();
            outer.insert("type".to_string(), Value::from("json_schema"));
            outer.insert("json_schema".to_string(), Value::Object(json_schema));
            Value::Object(outer)
        };

        let mut request = GatewayRequest::new("m", vec![GatewayMessage::user("hi")]);
        request.response_format = Some(schema_for(None));
        assert_eq!(
            build_request_body(&request, "openrouter")["response_format"]["json_schema"]["strict"],
            true
        );

        request.response_format = Some(schema_for(Some(Value::Bool(false))));
        assert_eq!(
            build_request_body(&request, "openrouter")["response_format"]["json_schema"]["strict"],
            false
        );
    }

    /// A `json_schema` without a name or schema is rejected and the
    /// `responseMimeType` fallback applies instead.
    #[test]
    fn incomplete_json_schema_falls_back_to_the_mime_type() {
        let mut request = GatewayRequest::new("m", vec![GatewayMessage::user("hi")]);
        request.response_mime_type = Some("application/json".to_string());
        request.response_format =
            Some(serde_json::json!({ "type": "json_schema", "json_schema": { "name": "x" } }));
        assert_eq!(
            build_request_body(&request, "openrouter")["response_format"],
            serde_json::json!({ "type": "json_object" })
        );
    }

    #[test]
    fn response_mime_type_alone_produces_json_object() {
        let mut request = GatewayRequest::new("m", vec![GatewayMessage::user("hi")]);
        request.response_mime_type = Some("application/json".to_string());
        assert_eq!(
            build_request_body(&request, "openrouter")["response_format"],
            serde_json::json!({ "type": "json_object" })
        );

        request.response_mime_type = Some("text/plain".to_string());
        assert!(build_request_body(&request, "openrouter")
            .get("response_format")
            .is_none());
    }

    /// The hard-coded provider list in `build.ts` differs from the unused
    /// constant: `opencode` is included here.
    #[test]
    fn reasoning_effort_reaches_openai_codex_and_opencode_only() {
        let mut request = GatewayRequest::new("m", vec![GatewayMessage::user("hi")]);
        request.reasoning_effort = Some(GatewayReasoningEffort::Medium);
        for provider in ["openai", "openai-codex"] {
            assert_eq!(
                build_request_body(&request, provider)["reasoning_effort"],
                "medium",
                "{provider}"
            );
        }
        assert!(build_request_body(&request, "kimi")
            .get("reasoning_effort")
            .is_none());

        let opencode = build_request_body(&request, "opencode");
        assert_eq!(opencode["reasoning_effort"], "medium");
        assert_eq!(
            opencode["chat_template_kwargs"],
            serde_json::json!({ "enable_thinking": true })
        );
    }

    #[test]
    fn enable_thinking_is_false_only_for_reasoning_effort_none() {
        let mut request = GatewayRequest::new("m", vec![GatewayMessage::user("hi")]);
        request.reasoning_effort = Some(GatewayReasoningEffort::None);
        let body = build_request_body(&request, "opencode");
        assert_eq!(body["reasoning_effort"], "none");
        assert_eq!(
            body["chat_template_kwargs"],
            serde_json::json!({ "enable_thinking": false })
        );
    }

    #[test]
    fn plain_messages_keep_string_content() {
        let messages = vec![
            GatewayMessage::new(GatewayRole::System, "be brief"),
            GatewayMessage::user("hi"),
            GatewayMessage::new(GatewayRole::Assistant, "hello"),
        ];
        let built = build_openai_compatible_messages(&StubAttachmentStore::default(), &messages);
        assert_eq!(
            serde_json::to_string(&built).expect("serialize"),
            r#"[{"role":"system","content":"be brief"},{"role":"user","content":"hi"},{"role":"assistant","content":"hello"}]"#
        );
    }

    /// Only the latest user message with attachments inlines binary data; an
    /// earlier one degrades to the placeholder text.
    #[test]
    fn only_the_latest_user_message_inlines_images() {
        let store = StubAttachmentStore::new(vec![
            ("a.png", "image/png", b"PNGDATA".to_vec()),
            ("b.png", "image/png", b"PNGB".to_vec()),
        ]);
        let with_attachment = |name: &str, size: i64, content: &str| GatewayMessage {
            role: GatewayRole::User,
            content: content.to_string(),
            attachments: Some(vec![attachment(name, "image/png", size, name)]),
        };
        let built = build_openai_compatible_messages(
            &store,
            &[
                with_attachment("a.png", 7, "old"),
                with_attachment("b.png", 4, "new"),
                GatewayMessage::user("plain"),
            ],
        );

        assert_eq!(
            built[0]["content"],
            serde_json::json!([{
                "type": "text",
                "text": "old\n\n[Attachment: a.png (image/png, 7 bytes)]"
            }])
        );
        assert_eq!(
            built[1]["content"],
            serde_json::json!([
                { "type": "text", "text": "new" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,UE5HQg==" } }
            ])
        );
        assert_eq!(built[2]["content"], "plain");
    }

    /// A text attachment on the latest user message becomes an inlined snippet
    /// after the message text.
    #[test]
    fn text_attachments_are_inlined_as_a_snippet() {
        let store = StubAttachmentStore::new(vec![(
            "notes.md",
            "text/markdown",
            b"# Title\n\nbody".to_vec(),
        )]);
        let message = GatewayMessage {
            role: GatewayRole::User,
            content: "look".to_string(),
            attachments: Some(vec![attachment(
                "notes.md",
                "text/markdown",
                14,
                "notes.md",
            )]),
        };
        let built = build_openai_compatible_messages(&store, &[message]);
        assert_eq!(
            built[0]["content"],
            serde_json::json!([{
                "type": "text",
                "text": "look\n\nAttachment notes.md (text/markdown):\n# Title\n\nbody"
            }])
        );
    }

    /// A missing file falls back to the placeholder, exactly as the `try/catch` in
    /// `readTextAttachmentSnippet` does.
    #[test]
    fn unreadable_attachments_degrade_to_placeholder_text() {
        let message = GatewayMessage {
            role: GatewayRole::User,
            content: String::new(),
            attachments: Some(vec![attachment("gone.png", "image/png", 9, "gone.png")]),
        };
        let built = build_openai_compatible_messages(&StubAttachmentStore::default(), &[message]);
        assert_eq!(
            built[0]["content"],
            serde_json::json!([{
                "type": "text",
                "text": "[Attachment: gone.png (image/png, 9 bytes)]"
            }])
        );
    }

    /// An empty attachment list on a user message keeps the plain string form.
    #[test]
    fn user_messages_without_attachments_stay_strings() {
        let message = GatewayMessage {
            role: GatewayRole::User,
            content: "hi".to_string(),
            attachments: Some(Vec::new()),
        };
        let built = build_openai_compatible_messages(&StubAttachmentStore::default(), &[message]);
        assert_eq!(built[0]["content"], "hi");
    }

    #[test]
    fn headers_follow_the_spread_order() {
        assert_eq!(
            build_request_headers("sk-test", &[]),
            vec![
                ("Content-Type".to_string(), "application/json".to_string()),
                ("Authorization".to_string(), "Bearer sk-test".to_string()),
            ]
        );
        assert_eq!(build_request_headers("", &[]).len(), 1);

        let extra = vec![
            ("HTTP-Referer".to_string(), "https://example".to_string()),
            ("X-Title".to_string(), "BetaClaw".to_string()),
        ];
        let headers = build_request_headers("sk-test", &extra);
        assert_eq!(headers[0].0, "Content-Type");
        assert_eq!(headers[1].0, "Authorization");
        assert_eq!(headers[2].0, "HTTP-Referer");
        assert_eq!(headers[3].0, "X-Title");
    }

    #[test]
    fn timeouts_match_the_golden_test_values() {
        assert_eq!(resolve_timeout_ms_with(true, None, None), 180_000);
        assert_eq!(resolve_timeout_ms_with(false, None, None), 60_000);
    }
}
