//! Test double for the WS ports. One struct implements every port, so a test sets
//! the fields it needs and then reads back what the handler recorded.

use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

use super::helpers::HandlerError;
use super::ports::{
    AgentV2Sessions, BoxFuture, ChannelBinding, ChannelBindingWrite, ChannelPairing, CommandResult,
    ConversationView, EventSink, IncomingAttachment, MessageService, MessageStore, PersonaRecord,
    PersonaStore, ReplayRequest, SessionCommand, StartSession, StartedSession, ToolApproval,
    WebUiMessage, WebUiResult,
};
use crate::channels::messages::service::execution::ports::StreamSink;

#[derive(Default)]
pub struct Fake {
    pub state: Mutex<State>,
}

#[derive(Default)]
pub struct State {
    // MessageService
    pub conversation: Option<ConversationView>,
    pub persona_sets: Vec<(String, String)>,
    pub model_overrides: Vec<(String, Option<String>)>,
    pub created: Vec<(String, String, Option<String>)>,
    pub delete_result: bool,
    pub abort_result: bool,
    pub web_error: Option<HandlerError>,
    pub deltas: Vec<String>,
    pub handle_delay_ms: u64,
    pub handled: Vec<WebUiMessage>,
    pub approvals: Vec<ToolApproval>,
    pub attachments: Vec<IncomingAttachment>,
    // MessageStore
    pub messages: Vec<Value>,
    pub conversations: Vec<Value>,
    pub history_args: Option<(String, i64, Option<String>)>,
    pub list_limit: Option<usize>,
    pub bindings: Vec<ChannelBinding>,
    pub upserts: Vec<ChannelBindingWrite>,
    // PersonaStore
    pub personas: Vec<(String, Option<String>)>,
    // ChannelPairing
    pub pair_result: Value,
    pub pair_error: Option<HandlerError>,
    pub bridge_accounts: Value,
    pub pairs: Vec<(String, String, Option<String>)>,
    pub unpairs: Vec<(String, Option<String>)>,
    // AgentV2Sessions
    pub started: Vec<StartSession>,
    pub commands: Vec<SessionCommand>,
    pub session: Option<Value>,
    pub listed: Option<(String, u64)>,
    pub replay_events: Vec<Value>,
    pub replay_request: Option<ReplayRequest>,
    // EventSink
    pub broadcasts: Vec<(String, String, Value)>,
}

impl MessageService for Fake {
    fn get_conversation(
        &self,
        _conversation_id: &str,
        _user_id: &str,
    ) -> Result<Option<ConversationView>, HandlerError> {
        Ok(self.state.lock().unwrap().conversation.clone())
    }

    fn set_persona_id(
        &self,
        conversation_id: &str,
        persona_id: &str,
        _user_id: &str,
    ) -> Result<(), HandlerError> {
        self.state
            .lock()
            .unwrap()
            .persona_sets
            .push((conversation_id.into(), persona_id.into()));
        Ok(())
    }

    fn get_or_create_conversation(
        &self,
        channel_type: &str,
        external_id: &str,
        title: Option<&str>,
        _user_id: &str,
    ) -> Result<ConversationView, HandlerError> {
        self.state.lock().unwrap().created.push((
            channel_type.into(),
            external_id.into(),
            title.map(str::to_string),
        ));
        Ok(ConversationView {
            id: "c-new".into(),
            channel_type: channel_type.into(),
            title: title.unwrap_or("").into(),
            updated_at: "2026-01-01T00:00:00.000Z".into(),
            persona_id: None,
        })
    }

    fn delete_conversation(
        &self,
        _conversation_id: &str,
        _user_id: &str,
    ) -> Result<bool, HandlerError> {
        Ok(self.state.lock().unwrap().delete_result)
    }

    fn set_model_override(
        &self,
        conversation_id: &str,
        model_override: Option<&str>,
        _user_id: &str,
    ) -> Result<(), HandlerError> {
        self.state
            .lock()
            .unwrap()
            .model_overrides
            .push((conversation_id.into(), model_override.map(str::to_string)));
        Ok(())
    }

    fn abort_generation(&self, _conversation_id: &str) -> Result<bool, HandlerError> {
        Ok(self.state.lock().unwrap().abort_result)
    }

    fn persist_incoming_attachment(
        &self,
        attachment: IncomingAttachment,
    ) -> Result<Value, HandlerError> {
        self.state.lock().unwrap().attachments.push(attachment);
        Ok(json!({ "id": "att-1" }))
    }

    fn handle_web_ui_message(
        &self,
        message: WebUiMessage,
        on_delta: Option<StreamSink>,
    ) -> BoxFuture<'_, Result<WebUiResult, HandlerError>> {
        Box::pin(async move {
            let (delay, deltas) = {
                let state = self.state.lock().unwrap();
                (state.handle_delay_ms, state.deltas.clone())
            };
            if delay > 0 {
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
            if let Some(on_delta) = on_delta {
                for delta in &deltas {
                    on_delta(delta.as_str());
                }
            }
            let mut state = self.state.lock().unwrap();
            state.handled.push(message);
            match state.web_error.clone() {
                Some(error) => Err(error),
                None => Ok(WebUiResult {
                    user_msg_id: "u-1".into(),
                    agent_msg_id: "a-1".into(),
                    new_conversation_id: None,
                }),
            }
        })
    }

    fn respond_tool_approval<'a>(
        &'a self,
        approval: ToolApproval,
    ) -> BoxFuture<'a, Result<Value, HandlerError>> {
        Box::pin(async move {
            self.state.lock().unwrap().approvals.push(approval);
            Ok(json!({ "ok": true }))
        })
    }
}

impl MessageStore for Fake {
    fn list_messages(
        &self,
        conversation_id: &str,
        limit: i64,
        before: Option<&str>,
        _user_id: &str,
    ) -> Result<Vec<Value>, HandlerError> {
        let mut state = self.state.lock().unwrap();
        state.history_args = Some((conversation_id.into(), limit, before.map(str::to_string)));
        Ok(state.messages.clone())
    }

    fn list_conversations(&self, limit: usize, _user_id: &str) -> Result<Vec<Value>, HandlerError> {
        let mut state = self.state.lock().unwrap();
        state.list_limit = Some(limit);
        Ok(state.conversations.clone())
    }

    fn list_channel_bindings(&self, _user_id: &str) -> Result<Vec<ChannelBinding>, HandlerError> {
        Ok(self.state.lock().unwrap().bindings.clone())
    }

    fn upsert_channel_binding(&self, binding: ChannelBindingWrite) -> Result<(), HandlerError> {
        self.state.lock().unwrap().upserts.push(binding);
        Ok(())
    }
}

impl PersonaStore for Fake {
    fn find_persona(
        &self,
        persona_id: &str,
        _user_id: &str,
    ) -> Result<Option<PersonaRecord>, HandlerError> {
        let state = self.state.lock().unwrap();
        Ok(state
            .personas
            .iter()
            .find(|(id, _)| id.as_str() == persona_id)
            .map(|(_, slug)| PersonaRecord { slug: slug.clone() }))
    }
}

impl ChannelPairing for Fake {
    fn list_bridge_accounts(&self, _channel: &str) -> Result<Value, HandlerError> {
        Ok(self.state.lock().unwrap().bridge_accounts.clone())
    }

    fn pair_channel<'a>(
        &'a self,
        channel: &'a str,
        token: &'a str,
        account_id: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Value, HandlerError>> {
        Box::pin(async move {
            let mut state = self.state.lock().unwrap();
            state
                .pairs
                .push((channel.into(), token.into(), account_id.map(str::to_string)));
            match state.pair_error.clone() {
                Some(error) => Err(error),
                None => Ok(state.pair_result.clone()),
            }
        })
    }

    fn unpair_channel<'a>(
        &'a self,
        channel: &'a str,
        account_id: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), HandlerError>> {
        Box::pin(async move {
            self.state
                .lock()
                .unwrap()
                .unpairs
                .push((channel.into(), account_id.map(str::to_string)));
            Ok(())
        })
    }
}

impl AgentV2Sessions for Fake {
    fn get_command_result(&self, _: &str, _: &str, _: &str) -> Result<Option<Value>, HandlerError> {
        Ok(None)
    }
    fn start_session<'a>(
        &'a self,
        input: StartSession,
    ) -> BoxFuture<'a, Result<StartedSession, HandlerError>> {
        Box::pin(async move {
            self.state.lock().unwrap().started.push(input);
            Ok(StartedSession {
                session: json!({ "id": "s1" }),
                events: json!([]),
            })
        })
    }

    fn enqueue<'a>(
        &'a self,
        command: SessionCommand,
    ) -> BoxFuture<'a, Result<CommandResult, HandlerError>> {
        Box::pin(async move {
            let session = json!({ "id": command.session_id.clone() });
            self.state.lock().unwrap().commands.push(command);
            Ok(CommandResult {
                command: json!("cmd-1"),
                session,
            })
        })
    }

    fn get_session(
        &self,
        _session_id: &str,
        _user_id: &str,
    ) -> Result<Option<Value>, HandlerError> {
        Ok(self.state.lock().unwrap().session.clone())
    }

    fn list_sessions(&self, user_id: &str, limit: u64) -> Result<Vec<Value>, HandlerError> {
        self.state.lock().unwrap().listed = Some((user_id.into(), limit));
        Ok(vec![json!({ "id": "s1" })])
    }

    fn replay_events(&self, request: ReplayRequest) -> Result<Vec<Value>, HandlerError> {
        let mut state = self.state.lock().unwrap();
        let events = state.replay_events.clone();
        state.replay_request = Some(request);
        Ok(events)
    }
}

impl EventSink for Fake {
    fn broadcast_to_user(&self, user_id: &str, event: &str, payload: Value) {
        self.state
            .lock()
            .unwrap()
            .broadcasts
            .push((user_id.into(), event.into(), payload));
    }
}
