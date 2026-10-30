use super::*;
use betaclaw_core::{
    channels::ws::helpers::HandlerError,
    channels::ws::ports::{CommandResult, StartedSession},
    config::GatewayConfig,
    messages_store::{CreateAgentRoomSwarmInput, SwarmUnit},
    model_hub::http::BoxFuture,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

#[derive(Default)]
struct Sessions {
    commands: Mutex<Vec<SessionCommand>>,
    terminal: Mutex<Option<Value>>,
    failure: Mutex<Option<String>>,
    replay_fails: AtomicBool,
}
impl AgentV2Sessions for Sessions {
    fn start_session<'a>(
        &'a self,
        _: StartSession,
    ) -> BoxFuture<'a, Result<StartedSession, HandlerError>> {
        Box::pin(async {
            Ok(StartedSession {
                session: json!({"id":"session-fixture","lastSeq":0}),
                events: json!([]),
            })
        })
    }
    fn enqueue<'a>(
        &'a self,
        command: SessionCommand,
    ) -> BoxFuture<'a, Result<CommandResult, HandlerError>> {
        Box::pin(async move {
            if let Some(error) = self.failure.lock().unwrap().clone() {
                return Err(HandlerError::invalid(error));
            }
            let id = command.command_id.clone();
            self.commands.lock().unwrap().push(command);
            Ok(CommandResult {
                command: json!({ "id": id }),
                session: json!({"id":"session-fixture"}),
            })
        })
    }
    fn get_session(&self, _: &str, _: &str) -> Result<Option<Value>, HandlerError> {
        Ok(Some(json!({"id":"session-fixture","lastSeq":0})))
    }
    fn list_sessions(&self, _: &str, _: u64) -> Result<Vec<Value>, HandlerError> {
        Ok(vec![])
    }
    fn replay_events(&self, _: ReplayRequest) -> Result<Vec<Value>, HandlerError> {
        if self.replay_fails.load(Ordering::Relaxed) {
            Err(HandlerError::invalid("expired replay"))
        } else {
            Ok(self.terminal.lock().unwrap().iter().cloned().collect())
        }
    }
    fn get_command_result(&self, _: &str, _: &str, _: &str) -> Result<Option<Value>, HandlerError> {
        Ok(self.terminal.lock().unwrap().clone())
    }
}
/// Pins the command id the way the TS parity test pins `crypto.randomUUID`.
fn runtime() -> SwarmRuntime {
    SwarmRuntime {
        new_command_id: || "agent-command-fixture".into(),
        ..Default::default()
    }
}
async fn fixture() -> (SharedState, AgentRoomSwarmRecord) {
    let mut config = GatewayConfig::from_env().unwrap();
    config.logs_db_path = ":memory:".into();
    config.messages_db_path = ":memory:".into();
    config.personas_db_path = ":memory:".into();
    config.auth_db_path = ":memory:".into();
    let state = Arc::new(crate::state::AppState::new(config).unwrap());
    let swarm = {
        let store = state.messages.lock().await;
        let conversation = store
            .get_or_create_conversation("AgentRoom", "swarm-test", None, Some("swarm-user"))
            .unwrap();
        store
            .create_agent_room_swarm(&CreateAgentRoomSwarmInput {
                conversation_id: &conversation.id,
                user_id: "swarm-user",
                title: "Parity room",
                task: "Agree on a plan",
                lead_persona_id: "lead",
                units: vec![SwarmUnit {
                    persona_id: "lead".into(),
                    role: "Lead".into(),
                }],
                status: Some(AgentRoomSwarmStatus::Running),
                ..Default::default()
            })
            .unwrap()
    };
    (state, swarm)
}
async fn read(state: &SharedState, swarm: &AgentRoomSwarmRecord) -> AgentRoomSwarmRecord {
    state
        .messages
        .lock()
        .await
        .get_agent_room_swarm(&swarm.id, &swarm.user_id)
        .unwrap()
        .unwrap()
}
fn normalize(value: Value, initial: &AgentRoomSwarmRecord) -> Value {
    match value {
        Value::String(text) => Value::String(
            text.replace(&initial.id, "swarm-fixture")
                .replace(&initial.conversation_id, "conversation-fixture"),
        ),
        Value::Array(items) => {
            Value::Array(items.into_iter().map(|v| normalize(v, initial)).collect())
        }
        Value::Object(items) => Value::Object(
            items
                .into_iter()
                .map(|(key, value)| {
                    let value = if key == "createdAt" || key == "updatedAt" {
                        json!("2026-01-01T00:00:00.000Z")
                    } else {
                        normalize(value, initial)
                    };
                    (key, value)
                })
                .collect(),
        ),
        other => other,
    }
}
fn capture(swarm: &AgentRoomSwarmRecord, initial: &AgentRoomSwarmRecord) -> Value {
    let value = serde_json::to_value(swarm).unwrap();
    let keys = [
        "sessionId",
        "status",
        "currentPhase",
        "consensusScore",
        "holdFlag",
        "artifact",
        "artifactHistory",
        "friction",
        "lastSeq",
        "currentDeployCommandId",
        "phaseBuffer",
    ];
    normalize(
        Value::Object(
            keys.into_iter()
                .map(|key| (key.into(), value[key].clone()))
                .collect(),
        ),
        initial,
    )
}
#[tokio::test]
async fn real_tick_dispatches_and_completes_and_matches_the_committed_parity_trace() {
    let (state, initial) = fixture().await;
    let sessions = Sessions::default();
    let mut runtime = runtime();
    runtime.tick_with_sessions(&state, &sessions).await.unwrap();
    let dispatched = read(&state, &initial).await;
    assert_eq!(
        dispatched.current_deploy_command_id.as_deref(),
        Some("agent-command-fixture")
    );
    assert_eq!(sessions.commands.lock().unwrap().len(), 1);
    let terminal = json!({"commandId":"agent-command-fixture","type":"agent.v2.command.completed","seq":5,"payload":{"result":{"message":"**[lead]:** Agreed [VOTE:UP]"}}});
    *sessions.terminal.lock().unwrap() = Some(terminal.clone());
    runtime.tick_with_sessions(&state, &sessions).await.unwrap();
    let completed = read(&state, &initial).await;
    assert!(completed.current_deploy_command_id.is_none());
    assert_eq!(completed.current_phase, AgentRoomSwarmPhase::Research);
    assert_eq!(completed.consensus_score, 50);
    assert!(completed
        .phase_buffer
        .iter()
        .any(|e| matches!(e, PhaseBufferEntry::PhaseSummaryPending { .. })));
    let commands=sessions.commands.lock().unwrap().iter().map(|command|json!({"kind":match &command.kind{SessionCommandKind::Input(_)=>"input",_=>"follow_up"},"content":match &command.kind{SessionCommandKind::Input(text)|SessionCommandKind::FollowUp(text)=>text,_=>""},"idempotencyKey":command.idempotency_key})).collect::<Vec<_>>();
    let trace = json!({"input":normalize(serde_json::to_value(&initial).unwrap(),&initial),"dispatch":capture(&dispatched,&initial),"completion":capture(&completed,&initial),"commands":normalize(json!(commands),&initial),"terminal":terminal});
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/swarm-parity.json");
    if std::env::var("BETACLAW_WRITE_FIXTURES").as_deref() == Ok("1") {
        std::fs::write(path, serde_json::to_string_pretty(&trace).unwrap()).unwrap();
    } else {
        let committed: Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("committed swarm trace"))
                .unwrap();
        assert_eq!(trace, committed);
    }
    runtime.tick_with_sessions(&state, &sessions).await.unwrap();
    let commands = sessions.commands.lock().unwrap();
    assert!(
        matches!(&commands[1].kind,SessionCommandKind::FollowUp(prompt) if prompt.contains("phase has just concluded"))
    );
}
#[tokio::test]
async fn repeated_dispatch_failures_enter_error_but_rate_limits_do_not() {
    let (state, initial) = fixture().await;
    let sessions = Sessions::default();
    let mut runtime = runtime();
    *sessions.failure.lock().unwrap() = Some("429 too many requests".into());
    for _ in 0..4 {
        runtime.tick_with_sessions(&state, &sessions).await.unwrap();
    }
    assert_eq!(
        read(&state, &initial).await.status,
        AgentRoomSwarmStatus::Running
    );
    *sessions.failure.lock().unwrap() = Some("dispatch failed".into());
    for _ in 0..3 {
        runtime.tick_with_sessions(&state, &sessions).await.unwrap();
    }
    let swarm = read(&state, &initial).await;
    assert_eq!(swarm.status, AgentRoomSwarmStatus::Error);
    assert!(swarm.hold_flag);
}
#[tokio::test]
async fn expired_replay_uses_terminal_result_and_error_keeps_only_agent_sessions() {
    let (state, initial) = fixture().await;
    let sessions = Sessions::default();
    let mut runtime = runtime();
    runtime.tick_with_sessions(&state, &sessions).await.unwrap();
    sessions.replay_fails.store(true, Ordering::Relaxed);
    *sessions.terminal.lock().unwrap() = Some(
        json!({"commandId":"agent-command-fixture","type":"agent.v2.error","seq":9,"payload":{}}),
    );
    runtime.tick_with_sessions(&state, &sessions).await.unwrap();
    let swarm = read(&state, &initial).await;
    assert_eq!(swarm.status, AgentRoomSwarmStatus::Error);
    assert!(swarm.hold_flag);
    assert_eq!(swarm.last_seq, 9);
    assert!(swarm
        .phase_buffer
        .iter()
        .all(|e| matches!(e, PhaseBufferEntry::AgentSession { .. })));
}
#[tokio::test]
async fn dispatch_announces_command_and_speaker_like_turn_dispatch_ts() {
    use betaclaw_core::gateway::{client::Outbound, ClientHandle};
    let (state, _) = fixture().await;
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    state
        .registry
        .register(ClientHandle::new("c1", "swarm-user", "v2", 0, tx));
    runtime()
        .tick_with_sessions(&state, &Sessions::default())
        .await
        .unwrap();
    let Ok(Outbound::Text(frame)) = rx.try_recv() else {
        panic!("dispatch event missing");
    };
    let payload = &serde_json::from_str::<Value>(&frame).unwrap()["payload"];
    assert_eq!(payload["commandId"], "agent-command-fixture");
    assert_eq!(payload["sessionId"], "session-fixture");
    assert_eq!(payload["agentPersonaId"], "lead");
    assert_eq!(payload["leadPersonaId"], "lead");
    assert_eq!(payload["currentPhase"], "analysis");
    assert_eq!(
        payload["swarm"]["currentDeployCommandId"],
        "agent-command-fixture"
    );
}
#[tokio::test]
async fn failed_enqueue_releases_the_command_and_keeps_the_session() {
    let (state, initial) = fixture().await;
    let sessions = Sessions::default();
    *sessions.failure.lock().unwrap() = Some("dispatch failed".into());
    runtime()
        .tick_with_sessions(&state, &sessions)
        .await
        .unwrap();
    let swarm = read(&state, &initial).await;
    assert!(swarm.current_deploy_command_id.is_none());
    assert!(swarm.phase_buffer.iter().any(
        |e| matches!(e, PhaseBufferEntry::AgentSession { session_id, .. } if session_id == "session-fixture")
    ));
}
#[tokio::test]
async fn a_command_without_session_waits_instead_of_dispatching_again() {
    let (state, initial) = fixture().await;
    state
        .messages
        .lock()
        .await
        .update_agent_room_swarm(
            &initial.id,
            &initial.user_id,
            &AgentRoomSwarmPatch {
                current_deploy_command_id: Some(Some("orphan".into())),
                ..Default::default()
            },
        )
        .unwrap();
    let sessions = Sessions::default();
    runtime()
        .tick_with_sessions(&state, &sessions)
        .await
        .unwrap();
    assert!(sessions.commands.lock().unwrap().is_empty());
    assert_eq!(
        read(&state, &initial)
            .await
            .current_deploy_command_id
            .as_deref(),
        Some("orphan")
    );
}
