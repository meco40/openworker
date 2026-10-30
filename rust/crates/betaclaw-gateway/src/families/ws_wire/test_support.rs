//! In-memory test doubles for the WS method tests. One [`Fake`] implements every
//! port, so a test seeds what a handler reads and then inspects what it wrote.

use std::sync::{Arc, Mutex, MutexGuard};

use betaclaw_core::channels::messages::service::execution::ports::StreamSink;
use betaclaw_core::channels::ws::helpers::HandlerError;
use betaclaw_core::channels::ws::ports::{
    AgentV2Sessions, BoxFuture, ChannelBinding, ChannelBindingWrite, ChannelPairing, CommandResult,
    ConversationView, EventSink, IncomingAttachment, MessageService, MessageStore, PersonaRecord,
    PersonaStore, ReplayRequest, SessionCommand, StartSession, StartedSession, ToolApproval,
    WebUiMessage, WebUiResult,
};
use betaclaw_core::gateway::client::{ClientHandle, Outbound};
use betaclaw_core::gateway::protocol::FrameId;
use betaclaw_core::messages_store::{InboxListInput, InboxListResult};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;

use super::ports::{InboxRateLimit, InboxStore, SwarmStore};
use super::{method_table, WsCall, WsOutcome, WsServices};

/// What the fake has seen and what it should return.
#[derive(Default)]
pub struct State {
    /// Every port call, in order, by name.
    pub calls: Vec<String>,
    /// When set, the next port call fails with this error.
    pub fail: Option<HandlerError>,
    pub conversation: Option<ConversationView>,
    /// Persona ids that `find_persona` knows.
    pub personas: Vec<String>,
    /// Deltas that `handle_web_ui_message` streams.
    pub deltas: Vec<String>,
    pub aborted: bool,
    pub deleted: bool,
    pub messages: Vec<Value>,
    pub conversations: Vec<Value>,
    pub bindings: Vec<ChannelBinding>,
    pub bridge_accounts: Value,
    pub pair_result: Value,
    pub commands: Vec<SessionCommand>,
    pub sessions: Vec<Value>,
    pub replay: Vec<Value>,
    /// Broadcasts as `(event, payload)`.
    pub events: Vec<(String, Value)>,
    pub swarms: Vec<Value>,
    pub swarm_seq: u64,
    pub agent_room: bool,
    pub rate_denied: bool,
    pub inbox: Option<InboxListResult>,
    /// `(user_id, limit)` of the last `list_inbox` call.
    pub inbox_seen: Option<(String, Option<i64>)>,
}

#[derive(Default)]
pub struct Fake {
    pub state: Mutex<State>,
}

impl Fake {
    /// Records the call. Returns the state, or the seeded failure.
    fn step(&self, name: &str) -> Result<MutexGuard<'_, State>, HandlerError> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(name.to_string());
        match state.fail.clone() {
            Some(error) => Err(error),
            None => Ok(state),
        }
    }

    /// Records the call and returns the seeded failure, if there is one.
    fn check(&self, name: &str) -> Result<(), HandlerError> {
        self.step(name).map(|_| ())
    }

    pub fn seed_personas(&self, ids: &[&str]) {
        self.state.lock().unwrap().personas = ids.iter().map(|id| id.to_string()).collect();
    }

    pub fn seed_swarm(&self, record: Value) {
        self.state.lock().unwrap().swarms.push(record);
    }

    fn stream_deltas(&self, on_delta: Option<&StreamSink>) -> Result<WebUiResult, HandlerError> {
        let deltas = self.step("handle_web_ui_message")?.deltas.clone();
        if let Some(on_delta) = on_delta {
            for delta in &deltas {
                on_delta(delta.as_str());
            }
        }
        Ok(WebUiResult {
            user_msg_id: "u-1".into(),
            agent_msg_id: "a-1".into(),
            new_conversation_id: None,
        })
    }
}

fn is_owned(swarm: &Value, id: &str, user_id: &str) -> bool {
    swarm["id"].as_str() == Some(id) && swarm["userId"].as_str() == Some(user_id)
}

impl MessageService for Fake {
    fn get_conversation(
        &self,
        _conversation_id: &str,
        _user_id: &str,
    ) -> Result<Option<ConversationView>, HandlerError> {
        let state = self.step("get_conversation")?;
        Ok(state.conversation.clone())
    }

    fn set_persona_id(
        &self,
        _conversation_id: &str,
        _persona_id: &str,
        _user_id: &str,
    ) -> Result<(), HandlerError> {
        self.step("set_persona_id").map(|_| ())
    }

    fn get_or_create_conversation(
        &self,
        channel_type: &str,
        _external_id: &str,
        title: Option<&str>,
        _user_id: &str,
    ) -> Result<ConversationView, HandlerError> {
        self.check("get_or_create_conversation")?;
        Ok(ConversationView {
            id: "conv-new".into(),
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
        Ok(self.step("delete_conversation")?.deleted)
    }

    fn set_model_override(
        &self,
        _conversation_id: &str,
        _model_override: Option<&str>,
        _user_id: &str,
    ) -> Result<(), HandlerError> {
        self.step("set_model_override").map(|_| ())
    }

    fn abort_generation(&self, _conversation_id: &str) -> Result<bool, HandlerError> {
        Ok(self.step("abort_generation")?.aborted)
    }

    fn persist_incoming_attachment(
        &self,
        _attachment: IncomingAttachment,
    ) -> Result<Value, HandlerError> {
        self.check("persist_incoming_attachment")?;
        Ok(json!({ "id": "att-1" }))
    }

    fn handle_web_ui_message(
        &self,
        _message: WebUiMessage,
        on_delta: Option<StreamSink>,
    ) -> BoxFuture<'_, Result<WebUiResult, HandlerError>> {
        let result = self.stream_deltas(on_delta.as_ref());
        Box::pin(async move { result })
    }

    fn respond_tool_approval<'a>(
        &'a self,
        _approval: ToolApproval,
    ) -> BoxFuture<'a, Result<Value, HandlerError>> {
        let result = self
            .step("respond_tool_approval")
            .map(|_| json!({ "ok": true }));
        Box::pin(async move { result })
    }
}

impl MessageStore for Fake {
    fn list_messages(
        &self,
        _conversation_id: &str,
        _limit: i64,
        _before: Option<&str>,
        _user_id: &str,
    ) -> Result<Vec<Value>, HandlerError> {
        Ok(self.step("list_messages")?.messages.clone())
    }

    fn list_conversations(
        &self,
        _limit: usize,
        _user_id: &str,
    ) -> Result<Vec<Value>, HandlerError> {
        Ok(self.step("list_conversations")?.conversations.clone())
    }

    fn list_channel_bindings(&self, _user_id: &str) -> Result<Vec<ChannelBinding>, HandlerError> {
        Ok(self.step("list_channel_bindings")?.bindings.clone())
    }

    fn upsert_channel_binding(&self, _binding: ChannelBindingWrite) -> Result<(), HandlerError> {
        self.step("upsert_channel_binding").map(|_| ())
    }
}

impl PersonaStore for Fake {
    fn find_persona(
        &self,
        persona_id: &str,
        _user_id: &str,
    ) -> Result<Option<PersonaRecord>, HandlerError> {
        let state = self.step("find_persona")?;
        let known = state.personas.iter().any(|id| id.as_str() == persona_id);
        Ok(known.then(|| PersonaRecord {
            slug: Some(persona_id.to_string()),
        }))
    }
}

impl ChannelPairing for Fake {
    fn list_bridge_accounts(&self, _channel: &str) -> Result<Value, HandlerError> {
        Ok(self.step("list_bridge_accounts")?.bridge_accounts.clone())
    }

    fn pair_channel<'a>(
        &'a self,
        _channel: &'a str,
        _token: &'a str,
        _account_id: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Value, HandlerError>> {
        let result = self
            .step("pair_channel")
            .map(|state| state.pair_result.clone());
        Box::pin(async move { result })
    }

    fn unpair_channel<'a>(
        &'a self,
        _channel: &'a str,
        _account_id: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), HandlerError>> {
        let result = self.step("unpair_channel").map(|_| ());
        Box::pin(async move { result })
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
        let result = self.step("start_session").map(|_| StartedSession {
            session: json!({ "id": "s1", "title": input.title }),
            events: json!([]),
        });
        Box::pin(async move { result })
    }

    fn enqueue<'a>(
        &'a self,
        command: SessionCommand,
    ) -> BoxFuture<'a, Result<CommandResult, HandlerError>> {
        let result = self.step("enqueue").map(|mut state| {
            let session = json!({ "id": command.session_id });
            state.commands.push(command);
            CommandResult {
                command: json!("cmd-1"),
                session,
            }
        });
        Box::pin(async move { result })
    }

    fn get_session(&self, session_id: &str, _user_id: &str) -> Result<Option<Value>, HandlerError> {
        self.check("get_session")?;
        Ok(Some(json!({ "id": session_id })))
    }

    fn list_sessions(&self, _user_id: &str, _limit: u64) -> Result<Vec<Value>, HandlerError> {
        Ok(self.step("list_sessions")?.sessions.clone())
    }

    fn replay_events(&self, _request: ReplayRequest) -> Result<Vec<Value>, HandlerError> {
        Ok(self.step("replay_events")?.replay.clone())
    }
}

impl EventSink for Fake {
    fn broadcast_to_user(&self, _user_id: &str, event: &str, payload: Value) {
        self.state
            .lock()
            .unwrap()
            .events
            .push((event.to_string(), payload));
    }
}

impl SwarmStore for Fake {
    fn is_agent_room_conversation(
        &self,
        _conversation_id: &str,
        _user_id: &str,
    ) -> Result<bool, HandlerError> {
        Ok(self.step("is_agent_room_conversation")?.agent_room)
    }

    fn create(&self, mut input: Value) -> Result<Value, HandlerError> {
        let mut state = self.step("swarm_create")?;
        state.swarm_seq += 1;
        input["id"] = json!(format!("sw-{}", state.swarm_seq));
        input["updatedAt"] = json!("2026-01-01T00:00:00.000Z");
        state.swarms.push(input.clone());
        Ok(input)
    }

    fn list(&self, user_id: &str, limit: u64) -> Result<Vec<Value>, HandlerError> {
        let state = self.step("swarm_list")?;
        Ok(state
            .swarms
            .iter()
            .filter(|swarm| swarm["userId"].as_str() == Some(user_id))
            .take(limit as usize)
            .cloned()
            .collect())
    }

    fn get(&self, id: &str, user_id: &str) -> Result<Option<Value>, HandlerError> {
        let state = self.step("swarm_get")?;
        Ok(state
            .swarms
            .iter()
            .find(|swarm| is_owned(swarm, id, user_id))
            .cloned())
    }

    fn update(
        &self,
        id: &str,
        user_id: &str,
        patch: Map<String, Value>,
    ) -> Result<Option<Value>, HandlerError> {
        let mut state = self.step("swarm_update")?;
        let Some(swarm) = state
            .swarms
            .iter_mut()
            .find(|swarm| is_owned(swarm, id, user_id))
        else {
            return Ok(None);
        };
        if let Some(object) = swarm.as_object_mut() {
            for (key, value) in patch {
                object.insert(key, value);
            }
        }
        Ok(Some(swarm.clone()))
    }

    fn delete(&self, id: &str, user_id: &str) -> Result<bool, HandlerError> {
        let mut state = self.step("swarm_delete")?;
        let before = state.swarms.len();
        state.swarms.retain(|swarm| !is_owned(swarm, id, user_id));
        Ok(state.swarms.len() < before)
    }
}

impl InboxStore for Fake {
    fn list_inbox(&self, input: InboxListInput<'_>) -> Result<InboxListResult, HandlerError> {
        let mut state = self.step("list_inbox")?;
        state.inbox_seen = Some((input.user_id.to_string(), input.limit));
        Ok(state.inbox.clone().unwrap_or(InboxListResult {
            items: Vec::new(),
            limit: 50,
            has_more: false,
            next_cursor: None,
            total_matched: 0,
        }))
    }
}

impl InboxRateLimit for Fake {
    fn allow(&self, _transport: &str, _key: &str) -> bool {
        !self.state.lock().unwrap().rate_denied
    }
}

/// A fresh fake and the services that wrap it.
pub fn fixture() -> (Arc<Fake>, Arc<WsServices>) {
    let fake = Arc::new(Fake::default());
    let services = Arc::new(WsServices {
        messages: fake.clone(),
        store: fake.clone(),
        personas: fake.clone(),
        pairing: fake.clone(),
        sessions: fake.clone(),
        events: fake.clone(),
        swarms: fake.clone(),
        inbox: fake.clone(),
        inbox_rate_limit: fake.clone(),
    });
    (fake, services)
}

/// A client for user `u1`, and the receiver of the frames it is sent.
pub fn test_client() -> (ClientHandle, mpsc::Receiver<Outbound>) {
    let (sender, receiver) = mpsc::channel(64);
    (ClientHandle::new("c0", "u1", "v2", 0, sender), receiver)
}

/// Looks up `method` in the table and runs it.
pub async fn invoke(
    services: &Arc<WsServices>,
    method: &str,
    params: Value,
    client: &ClientHandle,
) -> WsOutcome {
    let (_, handler) = method_table(Arc::clone(services))
        .into_iter()
        .find(|(name, _)| *name == method)
        .unwrap_or_else(|| panic!("no handler for {method}"));
    (*handler)(WsCall {
        id: FrameId::number(1),
        params,
        client: client.clone(),
    })
    .await
}

/// The payload of a successful outcome.
pub fn payload(outcome: WsOutcome) -> Value {
    match outcome {
        WsOutcome::Payload(value) => value,
        other => panic!("expected a payload, got {other:?}"),
    }
}

/// The error of a failed outcome.
pub fn failure(outcome: WsOutcome) -> HandlerError {
    match outcome {
        WsOutcome::Failed(error) => error,
        other => panic!("expected a failure, got {other:?}"),
    }
}
