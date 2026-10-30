//! Port of `src/server/gateway/methods/chat.ts` (S8).
//!
//! Covers `chat.send`, `chat.stream`, `chat.abort`, `chat.history`,
//! `chat.conversations.list` and `chat.approval.respond`.
//!
//! Wire contract from `method-router.ts` and `protocol.ts`: a handler that returns
//! `Ok(payload)` gets one `res` frame from the router, and one that returns `Err`
//! gets the frame from [`HandlerError::to_frame`]. `chat.stream` is the exception.
//! It writes `stream` frames through its sink and never sends a `res` on success.
//! On error it writes no `done` frame. The gateway integrator must honour this.
//! `MethodOutcome::Silent` in `betaclaw-gateway` would send an error frame instead.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::time::{interval_at, Instant};

use crate::channels::messages::service::execution::ports::StreamSink;
use crate::gateway::events::CHAT_ABORTED;
use crate::gateway::protocol::{make_stream, FrameId};

use super::helpers::{
    ensure_persona_exists, js_string_or, js_truthy, non_empty, parse_int_prefix, required_raw,
    str_param, HandlerError,
};
use super::ports::{
    EventSink, IncomingAttachment, MessageService, MessageStore, PersonaStore, ToolApproval,
    WebUiMessage,
};

const DEFAULT_KEEPALIVE_MS: u64 = 10_000;
const MIN_KEEPALIVE_MS: f64 = 1_000.0;
const MAX_KEEPALIVE_MS: f64 = 60_000.0;
const DEFAULT_HISTORY_LIMIT: i64 = 50;
const DEFAULT_CONVERSATIONS_LIMIT: usize = 50;
const MAX_CONVERSATIONS_LIMIT: usize = 200;

/// `resolveStreamKeepaliveMs()`. `raw` is the value of
/// `BETACLAW_CHAT_STREAM_KEEPALIVE_MS`. Invalid values give the default, and valid
/// ones are clamped to [1000, 60000].
pub fn resolve_stream_keepalive_ms(raw: Option<&str>) -> u64 {
    match raw.and_then(parse_int_prefix) {
        Some(ms) if ms.is_finite() && ms > 0.0 => {
            ms.clamp(MIN_KEEPALIVE_MS, MAX_KEEPALIVE_MS) as u64
        }
        _ => DEFAULT_KEEPALIVE_MS,
    }
}

/// `resolveConversationsListLimit()`: default 50, floored, and capped at 200.
fn conversations_list_limit(value: Option<&Value>) -> usize {
    let Some(raw) = value.and_then(Value::as_f64) else {
        return DEFAULT_CONVERSATIONS_LIMIT;
    };
    let normalized = raw.floor();
    if normalized < 1.0 {
        return DEFAULT_CONVERSATIONS_LIMIT;
    }
    (normalized as usize).min(MAX_CONVERSATIONS_LIMIT)
}

/// `resolveWebUiMessageInput()`: validates the request, binds the persona, and
/// persists an attachment.
fn web_ui_message(
    service: &dyn MessageService,
    personas: &dyn PersonaStore,
    user_id: &str,
    params: &Value,
) -> Result<WebUiMessage, HandlerError> {
    let conversation_id = str_param(params, "conversationId").trim().to_string();
    let content = str_param(params, "content").to_string();
    let client_message_id = non_empty(str_param(params, "clientMessageId").trim());
    let persona_id = str_param(params, "personaId").trim().to_string();
    let attachment = params.get("attachment").filter(|value| value.is_object());
    let has_attachment = attachment
        .and_then(|value| value.get("url"))
        .and_then(Value::as_str)
        .is_some_and(|url| !url.trim().is_empty());

    if conversation_id.is_empty() || (content.trim().is_empty() && !has_attachment) {
        return Err(HandlerError::plain(
            "conversationId and content or attachment are required",
        ));
    }

    if !persona_id.is_empty() {
        // A persona of another user is never bound or read (see `PersonaStore::find_persona`).
        ensure_persona_exists(personas, &persona_id, user_id)?;
        if let Some(conversation) = service.get_conversation(&conversation_id, user_id)? {
            let bound = conversation
                .persona_id
                .unwrap_or_default()
                .trim()
                .to_string();
            if !bound.is_empty() && bound != persona_id {
                return Err(HandlerError::invalid(
                    "personaId mismatch: conversation is already bound to a different persona.",
                ));
            }
            if bound.is_empty() {
                service.set_persona_id(&conversation_id, &persona_id, user_id)?;
            }
        }
    }

    let after_bind = service.get_conversation(&conversation_id, user_id)?;
    let effective_persona = if persona_id.is_empty() {
        after_bind
            .and_then(|conversation| conversation.persona_id)
            .filter(|id| !id.is_empty())
    } else {
        Some(persona_id)
    };
    let persona_slug = match effective_persona {
        Some(id) => personas
            .find_persona(&id, user_id)?
            .and_then(|persona| persona.slug)
            .filter(|slug| !slug.is_empty()),
        None => None,
    };

    let attachments = match (has_attachment, attachment) {
        (true, Some(attachment)) => {
            let declared_size = attachment
                .get("size")
                .and_then(Value::as_f64)
                .filter(|size| size.is_finite())
                .map_or(0, |size| size.floor().max(0.0) as u64);
            let record = service.persist_incoming_attachment(IncomingAttachment {
                user_id: user_id.to_string(),
                conversation_id: conversation_id.clone(),
                persona_slug,
                name: js_string_or(attachment.get("name"), "attachment"),
                mime_type: js_string_or(attachment.get("type"), ""),
                size: declared_size,
                data_url: js_string_or(attachment.get("url"), ""),
            })?;
            Some(vec![record])
        }
        _ => None,
    };

    Ok(WebUiMessage {
        conversation_id,
        content,
        user_id: user_id.to_string(),
        client_message_id,
        attachments,
    })
}

/// `chat.send`: sends a message and returns the ids of the two messages.
pub async fn send(
    service: &dyn MessageService,
    personas: &dyn PersonaStore,
    user_id: &str,
    params: &Value,
) -> Result<Value, HandlerError> {
    let message = web_ui_message(service, personas, user_id, params)?;
    let result = service.handle_web_ui_message(message, None).await?;
    Ok(json!({
        "userMsgId": result.user_msg_id,
        "agentMsgId": result.agent_msg_id,
        "newConversationId": result.new_conversation_id,
    }))
}

/// `chat.stream`: sends a message and streams the native deltas as `stream`
/// frames through `sink`. A keepalive frame with an empty delta goes out every
/// `keepalive_ms` while the handler runs. The final `done` frame follows success.
/// The handler never sends a `res`.
pub async fn stream(
    service: &dyn MessageService,
    personas: &dyn PersonaStore,
    user_id: &str,
    request_id: &FrameId,
    params: &Value,
    keepalive_ms: u64,
    sink: Arc<dyn Fn(Value) + Send + Sync>,
) -> Result<(), HandlerError> {
    let message = web_ui_message(service, personas, user_id, params)?;
    let request_id = request_id.clone();
    let delta_request_id = request_id.clone();
    let delta_sink = sink.clone();
    let on_delta: StreamSink = Arc::new(move |delta: &str| {
        if !delta.is_empty() {
            delta_sink(make_stream(&delta_request_id, delta, false));
        }
    });

    let period = Duration::from_millis(keepalive_ms);
    let mut keepalive = interval_at(Instant::now() + period, period);
    let mut work = service.handle_web_ui_message(message, Some(on_delta));
    let result = loop {
        tokio::select! {
            result = &mut work => break result,
            _ = keepalive.tick() => sink(make_stream(&request_id, "", false)),
        }
    };
    result?;
    sink(make_stream(&request_id, "", true));
    Ok(())
}

/// `chat.abort`: aborts the generation of one conversation. Broadcasts
/// `chat.aborted` only when something was aborted.
pub fn abort(
    service: &dyn MessageService,
    events: &dyn EventSink,
    user_id: &str,
    params: &Value,
) -> Result<Value, HandlerError> {
    let conversation_id = required_raw(params, "conversationId")?;
    // The active-request map is keyed by conversation id alone, so the owner check runs
    // first. A foreign conversation reports `aborted: false` and nothing is touched.
    let owned = service
        .get_conversation(&conversation_id, user_id)?
        .is_some();
    let aborted = owned && service.abort_generation(&conversation_id)?;
    if aborted {
        events.broadcast_to_user(
            user_id,
            CHAT_ABORTED,
            json!({ "conversationId": conversation_id }),
        );
    }
    Ok(json!({ "aborted": aborted }))
}

/// `chat.history`: a page of messages, newest first from the repository.
pub fn history(
    store: &dyn MessageStore,
    user_id: &str,
    params: &Value,
) -> Result<Value, HandlerError> {
    let conversation_id = required_raw(params, "conversationId")?;
    // `(params.limit as number) || 50`: zero and non-numbers give the default.
    let limit = params
        .get("limit")
        .and_then(Value::as_i64)
        .filter(|limit| *limit != 0)
        .unwrap_or(DEFAULT_HISTORY_LIMIT);
    let before = params.get("before").and_then(Value::as_str);
    let messages = store.list_messages(&conversation_id, limit, before, user_id)?;
    Ok(Value::Array(messages))
}

/// `chat.conversations.list`: the user's conversations, limited as above.
pub fn conversations_list(
    store: &dyn MessageStore,
    user_id: &str,
    params: &Value,
) -> Result<Value, HandlerError> {
    let limit = conversations_list_limit(params.get("limit"));
    Ok(Value::Array(store.list_conversations(limit, user_id)?))
}

/// `chat.approval.respond`: answers a tool approval request.
pub async fn approval_respond(
    service: &dyn MessageService,
    user_id: &str,
    params: &Value,
) -> Result<Value, HandlerError> {
    let conversation_id = str_param(params, "conversationId").trim().to_string();
    let approval_token = str_param(params, "approvalToken").trim().to_string();
    let approved = js_truthy(params.get("approved"));
    let approve_always = js_truthy(params.get("approveAlways"));
    let tool_id = non_empty(str_param(params, "toolId").trim());
    let tool_function_name = non_empty(str_param(params, "toolFunctionName").trim());

    if conversation_id.is_empty() {
        return Err(HandlerError::plain("conversationId is required"));
    }
    if approval_token.is_empty() {
        return Err(HandlerError::plain("approvalToken is required"));
    }

    service
        .respond_tool_approval(ToolApproval {
            conversation_id,
            user_id: user_id.to_string(),
            approval_token,
            approved,
            approve_always,
            tool_id,
            tool_function_name,
        })
        .await
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::super::ports::ConversationView;
    use super::super::test_support::Fake;
    use super::*;
    use crate::gateway::protocol::ErrorCode;

    fn message_params() -> Value {
        json!({"conversationId": "c1", "content": "hi"})
    }

    fn conversation(persona_id: Option<&str>) -> ConversationView {
        ConversationView {
            id: "c1".into(),
            channel_type: "WebChat".into(),
            title: "t".into(),
            updated_at: "2026-01-01T00:00:00.000Z".into(),
            persona_id: persona_id.map(str::to_string),
        }
    }

    #[test]
    fn keepalive_env_is_parsed_and_clamped() {
        assert_eq!(resolve_stream_keepalive_ms(None), 10_000);
        assert_eq!(resolve_stream_keepalive_ms(Some("abc")), 10_000);
        assert_eq!(resolve_stream_keepalive_ms(Some("-3")), 10_000);
        assert_eq!(resolve_stream_keepalive_ms(Some("500")), 1_000);
        assert_eq!(resolve_stream_keepalive_ms(Some("5000ms")), 5_000);
        assert_eq!(resolve_stream_keepalive_ms(Some("90000")), 60_000);
    }

    #[test]
    fn conversations_limit_defaults_and_caps() {
        assert_eq!(conversations_list_limit(None), 50);
        assert_eq!(conversations_list_limit(Some(&json!(0))), 50);
        assert_eq!(conversations_list_limit(Some(&json!("7"))), 50);
        assert_eq!(conversations_list_limit(Some(&json!(7.9))), 7);
        assert_eq!(conversations_list_limit(Some(&json!(500))), 200);
    }

    #[tokio::test]
    async fn send_returns_both_message_ids_and_keeps_the_content() {
        let fake = Fake::default();
        let payload = send(
            &fake,
            &fake,
            "u1",
            &json!({"conversationId": "c1", "content": " hi "}),
        )
        .await
        .unwrap();
        assert_eq!(
            payload,
            json!({"userMsgId": "u-1", "agentMsgId": "a-1", "newConversationId": null})
        );
        assert_eq!(fake.state.lock().unwrap().handled[0].content, " hi ");
    }

    #[tokio::test]
    async fn send_needs_content_or_an_attachment() {
        let fake = Fake::default();
        let err = send(
            &fake,
            &fake,
            "u1",
            &json!({"conversationId": "c1", "content": "   "}),
        )
        .await
        .unwrap_err();
        assert_eq!(
            err,
            HandlerError::plain("conversationId and content or attachment are required")
        );
        assert!(fake.state.lock().unwrap().handled.is_empty());
    }

    #[tokio::test]
    async fn send_rejects_a_persona_that_differs_from_the_binding() {
        let fake = Fake::default();
        {
            let mut state = fake.state.lock().unwrap();
            state.conversation = Some(conversation(Some("p1")));
            state.personas = vec![("p2".into(), None)];
        }
        let err = send(
            &fake,
            &fake,
            "u1",
            &json!({"conversationId": "c1", "content": "hi", "personaId": "p2"}),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidRequest);
        assert!(err.message.starts_with("personaId mismatch"));
    }

    #[tokio::test]
    async fn an_unbound_conversation_takes_the_persona_and_stores_the_attachment() {
        let fake = Fake::default();
        {
            let mut state = fake.state.lock().unwrap();
            state.conversation = Some(conversation(None));
            state.personas = vec![("p2".into(), Some("ana".into()))];
        }
        let params = json!({
            "conversationId": "c1",
            "content": "",
            "personaId": "p2",
            "attachment": {"url": "data:text/plain;base64,aGk=", "size": 10.7},
        });
        send(&fake, &fake, "u1", &params).await.unwrap();

        let state = fake.state.lock().unwrap();
        assert_eq!(
            state.persona_sets,
            vec![("c1".to_string(), "p2".to_string())]
        );
        assert_eq!(
            state.attachments,
            vec![IncomingAttachment {
                user_id: "u1".into(),
                conversation_id: "c1".into(),
                persona_slug: Some("ana".into()),
                name: "attachment".into(),
                mime_type: String::new(),
                size: 10,
                data_url: "data:text/plain;base64,aGk=".into(),
            }]
        );
        assert_eq!(
            state.handled[0].attachments,
            Some(vec![json!({"id": "att-1"})])
        );
    }

    #[tokio::test]
    async fn stream_emits_deltas_then_done_and_no_response() {
        let fake = Fake::default();
        fake.state.lock().unwrap().deltas = vec!["He".into(), String::new(), "llo".into()];
        let frames = Arc::new(Mutex::new(Vec::new()));
        let frame_sink = frames.clone();
        let sink = Arc::new(move |frame| frame_sink.lock().unwrap().push(frame));
        let id = FrameId::number(7);

        stream(&fake, &fake, "u1", &id, &message_params(), 10_000, sink)
            .await
            .unwrap();

        assert_eq!(
            std::mem::take(&mut *frames.lock().unwrap()),
            vec![
                make_stream(&id, "He", false),
                make_stream(&id, "llo", false),
                make_stream(&id, "", true),
            ]
        );
    }

    #[tokio::test]
    async fn stream_sends_keepalive_frames_while_the_handler_is_slow() {
        let fake = Fake::default();
        {
            let mut state = fake.state.lock().unwrap();
            state.handle_delay_ms = 1_200;
            state.deltas = vec!["x".into()];
        }
        let frames = Arc::new(Mutex::new(Vec::new()));
        let frame_sink = frames.clone();
        let sink = Arc::new(move |frame| frame_sink.lock().unwrap().push(frame));
        let id = FrameId::number(9);

        stream(&fake, &fake, "u1", &id, &message_params(), 1_000, sink)
            .await
            .unwrap();

        assert_eq!(
            std::mem::take(&mut *frames.lock().unwrap()),
            vec![
                make_stream(&id, "", false),
                make_stream(&id, "x", false),
                make_stream(&id, "", true),
            ]
        );
    }

    #[tokio::test]
    async fn stream_error_returns_the_error_and_writes_no_done_frame() {
        let fake = Fake::default();
        fake.state.lock().unwrap().web_error = Some(HandlerError::plain("boom"));
        let frames = Arc::new(Mutex::new(Vec::new()));
        let frame_sink = frames.clone();
        let sink = Arc::new(move |frame| frame_sink.lock().unwrap().push(frame));

        let err = stream(
            &fake,
            &fake,
            "u1",
            &FrameId::number(1),
            &message_params(),
            10_000,
            sink,
        )
        .await
        .unwrap_err();

        assert_eq!(err, HandlerError::plain("boom"));
        assert!(frames.lock().unwrap().is_empty());
    }

    #[test]
    fn abort_broadcasts_only_when_something_was_aborted() {
        let fake = Fake::default();
        {
            let mut state = fake.state.lock().unwrap();
            state.conversation = Some(conversation(None));
            state.abort_result = true;
        }
        let payload = abort(&fake, &fake, "u1", &json!({"conversationId": "c1"})).unwrap();
        assert_eq!(payload, json!({"aborted": true}));
        {
            let state = fake.state.lock().unwrap();
            assert_eq!(state.broadcasts.len(), 1);
            assert_eq!(state.broadcasts[0].0, "u1");
            assert_eq!(state.broadcasts[0].1, CHAT_ABORTED);
            assert_eq!(state.broadcasts[0].2, json!({"conversationId": "c1"}));
        }

        fake.state.lock().unwrap().abort_result = false;
        let payload = abort(&fake, &fake, "u1", &json!({"conversationId": "c1"})).unwrap();
        assert_eq!(payload, json!({"aborted": false}));
        assert_eq!(fake.state.lock().unwrap().broadcasts.len(), 1);
    }

    #[test]
    fn history_defaults_the_limit_and_requires_a_conversation() {
        let fake = Fake::default();
        let err = history(&fake, "u1", &json!({})).unwrap_err();
        assert_eq!(err, HandlerError::plain("conversationId is required"));

        fake.state.lock().unwrap().messages = vec![json!({"id": "m1"})];
        let payload = history(
            &fake,
            "u1",
            &json!({"conversationId": "c1", "limit": 0, "before": "m9"}),
        )
        .unwrap();
        assert_eq!(payload, json!([{"id": "m1"}]));
        assert_eq!(
            fake.state.lock().unwrap().history_args,
            Some(("c1".to_string(), 50, Some("m9".to_string())))
        );
    }

    #[tokio::test]
    async fn approval_flags_follow_truthiness_and_optional_ids_are_trimmed() {
        let fake = Fake::default();
        let params = json!({
            "conversationId": " c1 ",
            "approvalToken": "tok",
            "approved": "yes",
            "approveAlways": 0,
            "toolId": "   ",
            "toolFunctionName": "fn",
        });
        approval_respond(&fake, "u1", &params).await.unwrap();
        let approval = fake.state.lock().unwrap().approvals[0].clone();
        assert_eq!(
            approval,
            ToolApproval {
                conversation_id: "c1".into(),
                user_id: "u1".into(),
                approval_token: "tok".into(),
                approved: true,
                approve_always: false,
                tool_id: None,
                tool_function_name: Some("fn".into()),
            }
        );
    }

    #[tokio::test]
    async fn approval_requires_a_token() {
        let fake = Fake::default();
        let err = approval_respond(&fake, "u1", &json!({"conversationId": "c1"}))
            .await
            .unwrap_err();
        assert_eq!(err, HandlerError::plain("approvalToken is required"));
    }
}
