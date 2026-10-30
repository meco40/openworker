//! Method wrappers for the handlers that `betaclaw_core::channels::ws` implements.
//!
//! Each wrapper passes the request to the core function and maps its result to a
//! [`WsOutcome`]. The core functions hold the validation and the wire shape. Only
//! `chat.stream` is handled here, because it writes frames itself.

use std::sync::Arc;

use betaclaw_core::channels::ws::channels;
use betaclaw_core::channels::ws::chat;
use betaclaw_core::channels::ws::helpers::HandlerError;
use betaclaw_core::channels::ws::session_methods;
use betaclaw_core::channels::ws::sessions;
use serde_json::Value;

use super::{WsCall, WsFuture, WsOutcome, WsServices};

// --- chat.* -----------------------------------------------------------------

pub fn chat_send(s: Arc<WsServices>, call: WsCall) -> WsFuture {
    Box::pin(async move {
        WsOutcome::from(chat::send(&*s.messages, &*s.personas, call.user_id(), &call.params).await)
    })
}

/// `chat.stream`: writes `stream` frames as deltas arrive and a final `done` frame.
/// A success sends no `res`. A failure sends the `res` error and no `done`.
pub fn chat_stream(s: Arc<WsServices>, call: WsCall) -> WsFuture {
    Box::pin(async move {
        let keepalive_ms = chat::resolve_stream_keepalive_ms(
            std::env::var("BETACLAW_CHAT_STREAM_KEEPALIVE_MS")
                .ok()
                .as_deref(),
        );
        let client = call.client.clone();
        // `ctx.sendRaw`: a frame that cannot be queued is dropped, as in TypeScript.
        let sink = Arc::new(move |frame: Value| {
            let _ = client.enqueue_text(frame.to_string());
        });
        match chat::stream(
            &*s.messages,
            &*s.personas,
            call.user_id(),
            &call.id,
            &call.params,
            keepalive_ms,
            sink,
        )
        .await
        {
            Ok(()) => WsOutcome::Streamed,
            Err(error) => WsOutcome::Failed(error),
        }
    })
}

pub fn chat_abort(s: &WsServices, call: &WsCall) -> Result<Value, HandlerError> {
    chat::abort(&*s.messages, &*s.events, call.user_id(), &call.params)
}

pub fn chat_history(s: &WsServices, call: &WsCall) -> Result<Value, HandlerError> {
    chat::history(&*s.store, call.user_id(), &call.params)
}

pub fn chat_conversations_list(s: &WsServices, call: &WsCall) -> Result<Value, HandlerError> {
    chat::conversations_list(&*s.store, call.user_id(), &call.params)
}

pub fn chat_approval_respond(s: Arc<WsServices>, call: WsCall) -> WsFuture {
    Box::pin(async move {
        WsOutcome::from(chat::approval_respond(&*s.messages, call.user_id(), &call.params).await)
    })
}

// --- sessions.* -------------------------------------------------------------

pub fn sessions_delete(s: &WsServices, call: &WsCall) -> Result<Value, HandlerError> {
    sessions::delete(&*s.messages, &*s.events, call.user_id(), &call.params)
}

pub fn sessions_reset(s: &WsServices, call: &WsCall) -> Result<Value, HandlerError> {
    sessions::reset(&*s.messages, &*s.events, call.user_id(), &call.params)
}

pub fn sessions_patch(s: &WsServices, call: &WsCall) -> Result<Value, HandlerError> {
    sessions::patch(&*s.messages, call.user_id(), &call.params)
}

// --- channels.* -------------------------------------------------------------

pub fn channels_list(s: &WsServices, call: &WsCall) -> Result<Value, HandlerError> {
    channels::list(&*s.store, &*s.pairing, call.user_id())
}

pub fn channels_pair(s: Arc<WsServices>, call: WsCall) -> WsFuture {
    Box::pin(async move {
        WsOutcome::from(
            channels::pair(
                &*s.store,
                &*s.pairing,
                &*s.events,
                call.user_id(),
                &call.params,
            )
            .await,
        )
    })
}

pub fn channels_unpair(s: Arc<WsServices>, call: WsCall) -> WsFuture {
    Box::pin(async move {
        WsOutcome::from(
            channels::unpair(
                &*s.store,
                &*s.pairing,
                &*s.events,
                call.user_id(),
                &call.params,
            )
            .await,
        )
    })
}

// --- agent.v2.session.* -----------------------------------------------------

pub fn session_start(s: Arc<WsServices>, call: WsCall) -> WsFuture {
    Box::pin(async move {
        WsOutcome::from(
            session_methods::start(&*s.sessions, &*s.personas, call.user_id(), &call.params).await,
        )
    })
}

pub fn session_input(s: Arc<WsServices>, call: WsCall) -> WsFuture {
    Box::pin(async move {
        WsOutcome::from(session_methods::input(&*s.sessions, call.user_id(), &call.params).await)
    })
}

pub fn session_steer(s: Arc<WsServices>, call: WsCall) -> WsFuture {
    Box::pin(async move {
        WsOutcome::from(session_methods::steer(&*s.sessions, call.user_id(), &call.params).await)
    })
}

pub fn session_follow_up(s: Arc<WsServices>, call: WsCall) -> WsFuture {
    Box::pin(async move {
        WsOutcome::from(
            session_methods::follow_up(&*s.sessions, call.user_id(), &call.params).await,
        )
    })
}

pub fn session_approval_respond(s: Arc<WsServices>, call: WsCall) -> WsFuture {
    Box::pin(async move {
        WsOutcome::from(
            session_methods::approval_respond(&*s.sessions, call.user_id(), &call.params).await,
        )
    })
}

pub fn session_abort(s: Arc<WsServices>, call: WsCall) -> WsFuture {
    Box::pin(async move {
        WsOutcome::from(session_methods::abort(&*s.sessions, call.user_id(), &call.params).await)
    })
}

pub fn session_get(s: &WsServices, call: &WsCall) -> Result<Value, HandlerError> {
    session_methods::get(&*s.sessions, call.user_id(), &call.params)
}

pub fn session_list(s: &WsServices, call: &WsCall) -> Result<Value, HandlerError> {
    session_methods::list(&*s.sessions, call.user_id(), &call.params)
}

pub fn session_replay(s: &WsServices, call: &WsCall) -> Result<Value, HandlerError> {
    session_methods::replay(&*s.sessions, call.user_id(), &call.params)
}

#[cfg(test)]
mod tests {
    use betaclaw_core::channels::ws::ports::SessionCommandKind;
    use betaclaw_core::gateway::client::Outbound;
    use betaclaw_core::gateway::events::{
        CHANNELS_STATUS, CHAT_ABORTED, CONVERSATION_DELETED, CONVERSATION_RESET,
    };
    use betaclaw_core::gateway::protocol::FrameId;
    use serde_json::json;

    use super::super::test_support::{failure, fixture, invoke, payload, test_client};
    use super::super::WsOutcome;
    use super::*;

    fn sent_frames(rx: &mut tokio::sync::mpsc::Receiver<Outbound>) -> Vec<Value> {
        let mut frames = Vec::new();
        while let Ok(Outbound::Text(text)) = rx.try_recv() {
            frames.push(serde_json::from_str(&text).unwrap());
        }
        frames
    }

    #[tokio::test]
    async fn chat_send_returns_both_message_ids_and_rejects_empty_content() {
        let (_fake, services) = fixture();
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "chat.send",
                json!({"conversationId": "c1", "content": "hi"}),
                &client,
            )
            .await,
        );
        assert_eq!(
            body,
            json!({"userMsgId": "u-1", "agentMsgId": "a-1", "newConversationId": null})
        );
        let err = failure(
            invoke(
                &services,
                "chat.send",
                json!({"conversationId": "c1", "content": "   "}),
                &client,
            )
            .await,
        );
        assert_eq!(
            err,
            HandlerError::plain("conversationId and content or attachment are required")
        );
    }

    #[tokio::test]
    async fn chat_stream_writes_stream_frames_and_no_response_on_success() {
        let (fake, services) = fixture();
        fake.state.lock().unwrap().deltas = vec!["He".into(), "llo".into()];
        let (client, mut rx) = test_client();
        let outcome = invoke(
            &services,
            "chat.stream",
            json!({"conversationId": "c1", "content": "hi"}),
            &client,
        )
        .await;
        assert_eq!(outcome, WsOutcome::Streamed);
        assert_eq!(outcome.into_frame(&FrameId::number(1)), None);

        let frames = sent_frames(&mut rx);
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0]["type"], "stream");
        assert_eq!(frames[0]["delta"], "He");
        assert_eq!(frames[1]["delta"], "llo");
        assert_eq!(frames[2]["done"], true);
    }

    #[tokio::test]
    async fn chat_stream_failure_gives_a_res_error_and_no_done_frame() {
        let (_fake, services) = fixture();
        let (client, mut rx) = test_client();
        let err =
            failure(invoke(&services, "chat.stream", json!({"content": "hi"}), &client).await);
        assert_eq!(
            err,
            HandlerError::plain("conversationId and content or attachment are required")
        );
        assert!(sent_frames(&mut rx).is_empty());
    }

    #[tokio::test]
    async fn chat_abort_broadcasts_only_when_something_was_aborted() {
        let (fake, services) = fixture();
        {
            let mut state = fake.state.lock().unwrap();
            state.conversation = Some(betaclaw_core::channels::ws::ports::ConversationView {
                id: "c1".into(),
                channel_type: "WebChat".into(),
                title: "t".into(),
                updated_at: "2026-01-01T00:00:00.000Z".into(),
                persona_id: None,
            });
            state.aborted = true;
        }
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "chat.abort",
                json!({"conversationId": "c1"}),
                &client,
            )
            .await,
        );
        assert_eq!(body, json!({"aborted": true}));
        assert_eq!(fake.state.lock().unwrap().events[0].0, CHAT_ABORTED);

        let err = failure(invoke(&services, "chat.abort", json!({}), &client).await);
        assert_eq!(err, HandlerError::plain("conversationId is required"));
    }

    #[tokio::test]
    async fn chat_history_pages_messages_and_requires_a_conversation() {
        let (fake, services) = fixture();
        fake.state.lock().unwrap().messages = vec![json!({"id": "m1"})];
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "chat.history",
                json!({"conversationId": "c1"}),
                &client,
            )
            .await,
        );
        assert_eq!(body, json!([{"id": "m1"}]));

        let err = failure(invoke(&services, "chat.history", json!({}), &client).await);
        assert_eq!(err, HandlerError::plain("conversationId is required"));
    }

    #[tokio::test]
    async fn chat_conversations_list_returns_the_store_page_and_passes_store_errors() {
        let (fake, services) = fixture();
        fake.state.lock().unwrap().conversations = vec![json!({"id": "c1"})];
        let (client, _rx) = test_client();
        let body = payload(invoke(&services, "chat.conversations.list", json!({}), &client).await);
        assert_eq!(body, json!([{"id": "c1"}]));

        fake.state.lock().unwrap().fail = Some(HandlerError::plain("boom"));
        let err = failure(invoke(&services, "chat.conversations.list", json!({}), &client).await);
        assert_eq!(err, HandlerError::plain("boom"));
    }

    #[tokio::test]
    async fn chat_approval_respond_returns_the_service_result() {
        let (fake, services) = fixture();
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "chat.approval.respond",
                json!({"conversationId": "c1", "approvalToken": "tok", "approved": true}),
                &client,
            )
            .await,
        );
        assert_eq!(body, json!({"ok": true}));
        assert!(fake
            .state
            .lock()
            .unwrap()
            .calls
            .contains(&"respond_tool_approval".to_string()));

        let err = failure(
            invoke(
                &services,
                "chat.approval.respond",
                json!({"conversationId": "c1"}),
                &client,
            )
            .await,
        );
        assert_eq!(err, HandlerError::plain("approvalToken is required"));
    }

    #[tokio::test]
    async fn sessions_delete_announces_a_real_deletion_only() {
        let (fake, services) = fixture();
        fake.state.lock().unwrap().deleted = true;
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "sessions.delete",
                json!({"conversationId": "c1"}),
                &client,
            )
            .await,
        );
        assert_eq!(body, json!({"deleted": true}));
        assert_eq!(fake.state.lock().unwrap().events[0].0, CONVERSATION_DELETED);

        let err = failure(invoke(&services, "sessions.delete", json!({}), &client).await);
        assert_eq!(err, HandlerError::plain("conversationId is required"));
    }

    #[tokio::test]
    async fn sessions_reset_opens_a_conversation_and_passes_store_errors() {
        let (fake, services) = fixture();
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "sessions.reset",
                json!({"title": "New"}),
                &client,
            )
            .await,
        );
        assert_eq!(body, json!({"conversationId": "conv-new"}));
        assert_eq!(fake.state.lock().unwrap().events[0].0, CONVERSATION_RESET);

        fake.state.lock().unwrap().fail = Some(HandlerError::plain("boom"));
        let err = failure(invoke(&services, "sessions.reset", json!({}), &client).await);
        assert_eq!(err, HandlerError::plain("boom"));
    }

    #[tokio::test]
    async fn sessions_patch_sets_the_override_and_requires_a_conversation() {
        let (fake, services) = fixture();
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "sessions.patch",
                json!({"conversationId": "c1", "modelOverride": "gpt"}),
                &client,
            )
            .await,
        );
        assert_eq!(body, json!({"ok": true}));
        assert!(fake
            .state
            .lock()
            .unwrap()
            .calls
            .contains(&"set_model_override".to_string()));

        let err = failure(invoke(&services, "sessions.patch", json!({}), &client).await);
        assert_eq!(err, HandlerError::plain("conversationId is required"));
    }

    #[tokio::test]
    async fn channels_list_reports_every_channel_and_passes_store_errors() {
        let (fake, services) = fixture();
        fake.state.lock().unwrap().bridge_accounts = json!([{"id": "acc"}]);
        let (client, _rx) = test_client();
        let body = payload(invoke(&services, "channels.list", json!({}), &client).await);
        let channels = body["channels"].as_array().unwrap();
        assert_eq!(channels.len(), 7);
        assert_eq!(channels[0]["channel"], "webchat");
        assert_eq!(channels[3]["accounts"], json!([{"id": "acc"}]));

        fake.state.lock().unwrap().fail = Some(HandlerError::plain("boom"));
        let err = failure(invoke(&services, "channels.list", json!({}), &client).await);
        assert_eq!(err, HandlerError::plain("boom"));
    }

    #[tokio::test]
    async fn channels_pair_stores_the_binding_and_rejects_unknown_channels() {
        let (fake, services) = fixture();
        fake.state.lock().unwrap().pair_result =
            json!({"status": "connected", "transport": "polling", "peerName": "bot"});
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "channels.pair",
                json!({"channel": " Telegram ", "token": "t0"}),
                &client,
            )
            .await,
        );
        assert_eq!(body["ok"], true);
        assert_eq!(body["channel"], "telegram");
        assert_eq!(body["status"], "connected");
        assert_eq!(fake.state.lock().unwrap().events[0].0, CHANNELS_STATUS);

        let err = failure(
            invoke(
                &services,
                "channels.pair",
                json!({"channel": "matrix"}),
                &client,
            )
            .await,
        );
        assert_eq!(err, HandlerError::plain("Unsupported channel: matrix"));
    }

    #[tokio::test]
    async fn channels_unpair_marks_the_channel_disconnected() {
        let (fake, services) = fixture();
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "channels.unpair",
                json!({"channel": "slack", "accountId": "ws1"}),
                &client,
            )
            .await,
        );
        assert_eq!(body["ok"], true);
        assert_eq!(body["status"], "disconnected");
        assert!(fake
            .state
            .lock()
            .unwrap()
            .calls
            .contains(&"unpair_channel".to_string()));

        let err = failure(
            invoke(
                &services,
                "channels.unpair",
                json!({"channel": "matrix"}),
                &client,
            )
            .await,
        );
        assert_eq!(err, HandlerError::plain("Unsupported channel: matrix"));
    }

    #[tokio::test]
    async fn session_start_returns_the_session_and_checks_the_persona() {
        let (fake, services) = fixture();
        fake.seed_personas(&["p1"]);
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "agent.v2.session.start",
                json!({"personaId": "p1", "title": "T"}),
                &client,
            )
            .await,
        );
        assert_eq!(body["session"]["id"], "s1");

        let err = failure(
            invoke(
                &services,
                "agent.v2.session.start",
                json!({"personaId": "p9"}),
                &client,
            )
            .await,
        );
        assert_eq!(err, HandlerError::invalid("Persona not found: p9"));
    }

    #[tokio::test]
    async fn session_input_enqueues_the_content() {
        let (fake, services) = fixture();
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "agent.v2.session.input",
                json!({"sessionId": "s1", "content": " go ", "idempotencyKey": "k1"}),
                &client,
            )
            .await,
        );
        assert_eq!(body, json!({"command": "cmd-1", "session": {"id": "s1"}}));
        let command = fake.state.lock().unwrap().commands[0].clone();
        assert_eq!(command.kind, SessionCommandKind::Input("go".into()));
        assert_eq!(command.idempotency_key, Some("k1".into()));

        let err = failure(
            invoke(
                &services,
                "agent.v2.session.input",
                json!({"content": "go"}),
                &client,
            )
            .await,
        );
        assert_eq!(err, HandlerError::invalid("sessionId is required"));
    }

    #[tokio::test]
    async fn session_steer_enqueues_the_instruction() {
        let (fake, services) = fixture();
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "agent.v2.session.steer",
                json!({"sessionId": "s1", "instruction": "slower"}),
                &client,
            )
            .await,
        );
        assert_eq!(body["command"], "cmd-1");
        let command = fake.state.lock().unwrap().commands[0].clone();
        assert_eq!(command.kind, SessionCommandKind::Steer("slower".into()));

        let err = failure(
            invoke(
                &services,
                "agent.v2.session.steer",
                json!({"sessionId": "s1"}),
                &client,
            )
            .await,
        );
        assert_eq!(err, HandlerError::invalid("instruction is required"));
    }

    #[tokio::test]
    async fn session_follow_up_enqueues_the_content() {
        let (fake, services) = fixture();
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "agent.v2.session.follow_up",
                json!({"sessionId": "s1", "content": "next"}),
                &client,
            )
            .await,
        );
        assert_eq!(body["command"], "cmd-1");
        let command = fake.state.lock().unwrap().commands[0].clone();
        assert_eq!(command.kind, SessionCommandKind::FollowUp("next".into()));

        let err = failure(
            invoke(
                &services,
                "agent.v2.session.follow_up",
                json!({"content": "next"}),
                &client,
            )
            .await,
        );
        assert_eq!(err, HandlerError::invalid("sessionId is required"));
    }

    #[tokio::test]
    async fn session_approval_respond_enqueues_the_decision() {
        let (fake, services) = fixture();
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "agent.v2.session.approval.respond",
                json!({"sessionId": "s1", "approvalToken": "t", "approved": true}),
                &client,
            )
            .await,
        );
        assert_eq!(body["command"], "cmd-1");
        let command = fake.state.lock().unwrap().commands[0].clone();
        assert_eq!(
            command.kind,
            SessionCommandKind::ApprovalResponse {
                approval_token: "t".into(),
                approved: true,
                approve_always: false,
                tool_id: None,
                tool_function_name: None,
            }
        );

        let err = failure(
            invoke(
                &services,
                "agent.v2.session.approval.respond",
                json!({"sessionId": "s1", "approvalToken": "t"}),
                &client,
            )
            .await,
        );
        assert_eq!(err, HandlerError::invalid("approved is required"));
    }

    #[tokio::test]
    async fn session_abort_enqueues_an_abort_command() {
        let (fake, services) = fixture();
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "agent.v2.session.abort",
                json!({"sessionId": "s1", "reason": "user"}),
                &client,
            )
            .await,
        );
        assert_eq!(body["command"], "cmd-1");
        let command = fake.state.lock().unwrap().commands[0].clone();
        assert_eq!(
            command.kind,
            SessionCommandKind::Abort {
                reason: Some("user".into())
            }
        );

        let err = failure(invoke(&services, "agent.v2.session.abort", json!({}), &client).await);
        assert_eq!(err, HandlerError::invalid("sessionId is required"));
    }

    #[tokio::test]
    async fn session_get_returns_the_session_and_requires_an_id() {
        let (_fake, services) = fixture();
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "agent.v2.session.get",
                json!({"sessionId": "s1"}),
                &client,
            )
            .await,
        );
        assert_eq!(body["session"]["id"], "s1");

        let err = failure(invoke(&services, "agent.v2.session.get", json!({}), &client).await);
        assert_eq!(err, HandlerError::invalid("sessionId is required"));
    }

    #[tokio::test]
    async fn session_list_returns_the_sessions_and_passes_store_errors() {
        let (fake, services) = fixture();
        fake.state.lock().unwrap().sessions = vec![json!({"id": "s1"})];
        let (client, _rx) = test_client();
        let body = payload(invoke(&services, "agent.v2.session.list", json!({}), &client).await);
        assert_eq!(body["sessions"][0]["id"], "s1");

        fake.state.lock().unwrap().fail = Some(HandlerError::plain("boom"));
        let err = failure(invoke(&services, "agent.v2.session.list", json!({}), &client).await);
        assert_eq!(err, HandlerError::plain("boom"));
    }

    #[tokio::test]
    async fn session_replay_reports_the_last_seq_and_rejects_a_negative_from_seq() {
        let (fake, services) = fixture();
        fake.state.lock().unwrap().replay = vec![json!({"seq": 4})];
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "agent.v2.session.replay",
                json!({"sessionId": "s1", "fromSeq": 3}),
                &client,
            )
            .await,
        );
        assert_eq!(body["nextSeq"], 4);

        let err = failure(
            invoke(
                &services,
                "agent.v2.session.replay",
                json!({"sessionId": "s1", "fromSeq": -1}),
                &client,
            )
            .await,
        );
        assert_eq!(
            err,
            HandlerError::invalid("fromSeq must be a non-negative number")
        );
    }
}
