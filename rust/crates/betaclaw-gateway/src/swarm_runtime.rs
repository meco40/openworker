//! Runtime of `agent-room/swarmRuntime.ts`; turn effects use the shared Agent-v2 port.
use crate::{background::BackgroundTask, state::SharedState};
use betaclaw_core::agent_room::{
    orchestrator::Orchestrator,
    prompt::{phase_service::get_simple_swarm_max_turns, text_utils::count_structured_turns},
    services::{
        agent_session::{get_agent_session_entry, update_phase_buffer_sessions},
        swarm_resolution::{resolve_speaker_persona_id, resolve_swarm_units},
        turn_completion::{completion_patch, find_completion_event},
        turn_dispatch::plan_turn,
    },
    types::AgentSession,
};
use betaclaw_core::channels::ws::ports::{
    AgentV2Sessions, ReplayRequest, SessionCommand, SessionCommandKind, StartSession,
};
use betaclaw_core::messages_store::{
    AgentRoomSwarmPatch, AgentRoomSwarmPhase, AgentRoomSwarmRecord, AgentRoomSwarmStatus,
    PhaseBufferEntry,
};
use std::time::Duration;
pub const DEFAULT_SWARM_TICK_MS: u64 = 5_000;
pub type SwarmRuntimeHandle = BackgroundTask;

pub struct SwarmRuntime {
    orchestrator: Orchestrator,
    /// `agent-command-${crypto.randomUUID()}` in `turnDispatch.service.ts`; tests pin it.
    new_command_id: fn() -> String,
}
impl Default for SwarmRuntime {
    fn default() -> Self {
        Self {
            orchestrator: Orchestrator::default(),
            new_command_id: || format!("agent-command-{}", uuid::Uuid::new_v4()),
        }
    }
}
impl SwarmRuntime {
    pub fn should_run_for_role(role: &str) -> bool {
        Self::parse_should_run(
            std::env::var("SWARM_RUNNER").ok().as_deref(),
            std::env::var("BETACLAW_SWARM_RUNNER").ok().as_deref(),
            role,
        )
    }
    pub fn parse_should_run(runner: Option<&str>, owner: Option<&str>, role: &str) -> bool {
        owner.is_some_and(|v| v.trim().eq_ignore_ascii_case("rust"))
            && if runner
                .unwrap_or("server")
                .trim()
                .eq_ignore_ascii_case("scheduler")
            {
                role == "scheduler"
            } else {
                role == "server"
            }
    }
    pub fn parse_tick_ms(value: Option<&str>) -> u64 {
        value
            .and_then(|v| v.parse().ok())
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_SWARM_TICK_MS)
    }
    pub fn resolve_tick_ms() -> u64 {
        Self::parse_tick_ms(std::env::var("SWARM_ORCHESTRATOR_TICK_MS").ok().as_deref())
    }
    pub async fn start(state: SharedState, instance_id: String) -> SwarmRuntimeHandle {
        if let Err(error) = state.messages.lock().await.recover_running_swarms() {
            tracing::warn!(%error,"Swarm recovery failed");
        }
        let (stop, mut signal) = tokio::sync::watch::channel(false);
        let task = tokio::spawn(async move {
            let mut runtime = Self::default();
            let mut interval =
                tokio::time::interval(Duration::from_millis(Self::resolve_tick_ms()));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            tracing::info!(%instance_id,"[swarm-runtime] started");
            loop {
                tokio::select! {_ = signal.changed()=>break,_ = interval.tick()=>{}}
                if *signal.borrow() {
                    break;
                }
                if let Err(error) = runtime.tick_once(&state).await {
                    tracing::warn!(%error,"Swarm tick failed");
                }
            }
        });
        BackgroundTask { stop, task }
    }
    pub async fn tick_once(&mut self, state: &SharedState) -> Result<(), String> {
        let sessions = crate::families::wiring::ws_services(state).sessions;
        self.tick_with_sessions(state, &*sessions).await
    }
    pub async fn tick_with_sessions(
        &mut self,
        state: &SharedState,
        sessions: &dyn AgentV2Sessions,
    ) -> Result<(), String> {
        let swarms = state
            .messages
            .lock()
            .await
            .list_running_swarms(50)
            .map_err(|e| e.to_string())?;
        for swarm in swarms {
            if !self.orchestrator.begin(&swarm.id) {
                continue;
            }
            let result = self.process_tick(state, &swarm, sessions).await;
            let hold = self
                .orchestrator
                .finish(&swarm.id, result.as_ref().err().map(String::as_str));
            if let Err(error) = result {
                tracing::warn!(swarm_id=%swarm.id,%error,"[swarm-runtime] turn failed");
                if hold {
                    // Best effort as in TS: one failed write must not stop the other swarms.
                    if let Err(error) = save(
                        state,
                        &swarm,
                        AgentRoomSwarmPatch {
                            status: Some(AgentRoomSwarmStatus::Error),
                            hold_flag: Some(true),
                            ..Default::default()
                        },
                    )
                    .await
                    {
                        tracing::warn!(swarm_id=%swarm.id,%error,"[swarm-runtime] error state not saved");
                    }
                }
            }
        }
        Ok(())
    }
    async fn process_tick(
        &self,
        state: &SharedState,
        listed: &AgentRoomSwarmRecord,
        sessions: &dyn AgentV2Sessions,
    ) -> Result<(), String> {
        let Some(swarm) = state
            .messages
            .lock()
            .await
            .get_agent_room_swarm(&listed.id, &listed.user_id)
            .map_err(|e| e.to_string())?
        else {
            return Ok(());
        };
        if swarm.status != AgentRoomSwarmStatus::Running {
            return Ok(());
        }
        let personas = state.personas.lock().await;
        let units = resolve_swarm_units(&swarm, |id| {
            personas
                .get_persona(id)
                .ok()
                .flatten()
                .filter(|p| p.user_id == swarm.user_id)
                .map(|p| (p.name, p.emoji))
        });
        drop(personas);
        if let Some(command) = &swarm.current_deploy_command_id {
            // `checkTurnCompletion` returns without a session; it never dispatches again.
            let Some(session) = &swarm.session_id else {
                return Ok(());
            };
            let mut events = match sessions.replay_events(ReplayRequest {
                session_id: session.clone(),
                user_id: swarm.user_id.clone(),
                from_seq: swarm.last_seq as f64,
                limit: Some(2000),
            }) {
                Ok(events) => events,
                Err(error) => {
                    tracing::warn!(error = %error.message,"Swarm replay failed; checking terminal result");
                    vec![]
                }
            };
            if events.is_empty() {
                if let Some(event) = sessions
                    .get_command_result(command, session, &swarm.user_id)
                    .map_err(|e| e.message)?
                {
                    events.push(event);
                }
            }
            let Some(event) = find_completion_event(&events, command) else {
                return Ok(());
            };
            let seq = events
                .last()
                .and_then(|v| v["seq"].as_i64())
                .unwrap_or(swarm.last_seq);
            let conversation = state
                .messages
                .lock()
                .await
                .get_conversation(&swarm.conversation_id, Some(&swarm.user_id))
                .map_err(|e| e.to_string())?;
            let speaker = resolve_speaker_persona_id(
                &swarm,
                conversation.as_ref().and_then(|c| c.persona_id.as_deref()),
            );
            return save(
                state,
                &swarm,
                completion_patch(
                    &swarm,
                    event,
                    seq,
                    &units,
                    &speaker,
                    &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                ),
            )
            .await;
        }
        if units.is_empty() {
            tracing::warn!(swarm_id=%swarm.id,"[swarm-orchestrator] swarm has no units, skipping turn dispatch");
            return Ok(());
        }
        if count_structured_turns(&swarm.artifact) >= get_simple_swarm_max_turns() as usize {
            return save(
                state,
                &swarm,
                AgentRoomSwarmPatch {
                    status: Some(AgentRoomSwarmStatus::Completed),
                    current_phase: Some(AgentRoomSwarmPhase::Result),
                    hold_flag: Some(false),
                    current_deploy_command_id: Some(None),
                    ..Default::default()
                },
            )
            .await;
        }
        let Some(turn) = plan_turn(&swarm, &units) else {
            return Ok(());
        };
        let existing = get_agent_session_entry(&swarm.phase_buffer, &turn.speaker_id);
        let is_new = existing.is_none();
        let (session_id, last_seq) = if let Some(entry) = existing {
            let seq = sessions
                .get_session(&entry.session_id, &swarm.user_id)
                .ok()
                .flatten()
                .and_then(|s| s["lastSeq"].as_i64())
                .unwrap_or(entry.last_seq);
            (entry.session_id, seq)
        } else {
            let started = sessions
                .start_session(StartSession {
                    user_id: swarm.user_id.clone(),
                    title: Some(swarm.title.clone()),
                    persona_id: Some(turn.speaker_id.clone()),
                    conversation_id: Some(swarm.conversation_id.clone()),
                })
                .await
                .map_err(|e| e.message)?;
            (
                started.session["id"]
                    .as_str()
                    .ok_or("Agent session has no id")?
                    .to_string(),
                started.session["lastSeq"].as_i64().unwrap_or(0),
            )
        };
        state
            .messages
            .lock()
            .await
            .update_persona_id(
                &swarm.conversation_id,
                Some(&turn.speaker_id),
                &swarm.user_id,
            )
            .map_err(|e| e.to_string())?;
        let command = (self.new_command_id)();
        let mut buffer = update_phase_buffer_sessions(
            &swarm
                .phase_buffer
                .iter()
                .filter(|e| {
                    !matches!(
                        e,
                        PhaseBufferEntry::Speaker { .. }
                            | PhaseBufferEntry::SpeakerOverride { .. }
                            | PhaseBufferEntry::PhaseSummaryPending { .. }
                    )
                })
                .cloned()
                .collect::<Vec<_>>(),
            &AgentSession {
                persona_id: turn.speaker_id.clone(),
                session_id: session_id.clone(),
                last_seq,
            },
        );
        buffer.push(PhaseBufferEntry::Speaker {
            persona_id: turn.speaker_id.clone(),
        });
        // TS stores and announces the command before enqueueing it, so the UI maps
        // `agent.v2.command.started` to the speaker (`useSwarmConnection.ts`).
        save_with(
            state,
            &swarm,
            AgentRoomSwarmPatch {
                current_deploy_command_id: Some(Some(command.clone())),
                session_id: Some(Some(session_id.clone())),
                last_seq: Some(last_seq),
                phase_buffer: Some(buffer),
                ..Default::default()
            },
            serde_json::json!({
                "sessionId": session_id,
                "commandId": command,
                "currentPhase": swarm.current_phase,
                "leadPersonaId": swarm.lead_persona_id,
                "agentPersonaId": turn.speaker_id,
            }),
        )
        .await?;
        let enqueued = sessions
            .enqueue(SessionCommand {
                session_id: session_id.clone(),
                user_id: swarm.user_id.clone(),
                kind: if is_new {
                    SessionCommandKind::Input(turn.prompt)
                } else {
                    SessionCommandKind::FollowUp(turn.prompt)
                },
                idempotency_key: Some(format!("swarm-{}:turn-{}", swarm.id, turn.turn_count)),
                command_id: Some(command),
            })
            .await;
        if let Err(error) = enqueued {
            // Deliberate deviation from TS: release the command that never started, so
            // the next tick dispatches again and the retry counter can reach error/hold
            // instead of waiting forever for a completion. The started session stays
            // registered so a retry does not open another one.
            save(
                state,
                &swarm,
                AgentRoomSwarmPatch {
                    current_deploy_command_id: Some(None),
                    phase_buffer: Some(update_phase_buffer_sessions(
                        &swarm.phase_buffer,
                        &AgentSession {
                            persona_id: turn.speaker_id,
                            session_id,
                            last_seq,
                        },
                    )),
                    ..Default::default()
                },
            )
            .await?;
            return Err(error.message);
        }
        Ok(())
    }
}
async fn save(
    state: &SharedState,
    swarm: &AgentRoomSwarmRecord,
    patch: AgentRoomSwarmPatch,
) -> Result<(), String> {
    save_with(state, swarm, patch, serde_json::json!({})).await
}
/// Writes the patch and broadcasts `AGENT_ROOM_SWARM` with `extra` merged into the payload.
async fn save_with(
    state: &SharedState,
    swarm: &AgentRoomSwarmRecord,
    patch: AgentRoomSwarmPatch,
    extra: serde_json::Value,
) -> Result<(), String> {
    let updated = state
        .messages
        .lock()
        .await
        .update_agent_room_swarm(&swarm.id, &swarm.user_id, &patch)
        .map_err(|e| e.to_string())?;
    betaclaw_core::gateway::broadcast::broadcast_to_user(
        &state.registry,
        &swarm.user_id,
        betaclaw_core::gateway::events::AGENT_ROOM_SWARM,
        Some(swarm_event(&swarm.id, updated, extra)),
    );
    Ok(())
}
fn swarm_event(
    swarm_id: &str,
    updated: impl serde::Serialize,
    extra: serde_json::Value,
) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "swarmId": swarm_id,
        "status": "updated",
        "swarm": updated,
        "updatedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    });
    if let (Some(payload), serde_json::Value::Object(extra)) = (payload.as_object_mut(), extra) {
        payload.extend(extra);
    }
    payload
}
#[cfg(test)]
#[path = "swarm_runtime_tests.rs"]
mod flow_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_swarm_role_selection() {
        // Default (None) is inactive for Rust because default is node ownership
        assert!(!SwarmRuntime::parse_should_run(None, None, "server"));
        assert!(!SwarmRuntime::parse_should_run(None, None, "scheduler"));
        assert!(!SwarmRuntime::parse_should_run(
            Some("server"),
            Some("node"),
            "server"
        ));
        assert!(!SwarmRuntime::parse_should_run(
            Some("server"),
            Some("off"),
            "server"
        ));
        assert!(!SwarmRuntime::parse_should_run(
            Some("server"),
            Some("false"),
            "server"
        ));

        // When BETACLAW_SWARM_RUNNER=rust
        assert!(SwarmRuntime::parse_should_run(None, Some("rust"), "server"));
        assert!(SwarmRuntime::parse_should_run(
            Some("server"),
            Some("RUST"),
            "server"
        ));
        assert!(SwarmRuntime::parse_should_run(
            Some("server"),
            Some("  rust  "),
            "server"
        ));
        assert!(!SwarmRuntime::parse_should_run(
            Some("server"),
            Some("rust"),
            "scheduler"
        ));

        assert!(SwarmRuntime::parse_should_run(
            Some("scheduler"),
            Some("rust"),
            "scheduler"
        ));
        assert!(!SwarmRuntime::parse_should_run(
            Some("scheduler"),
            Some("rust"),
            "server"
        ));
    }

    #[test]
    fn test_resolve_tick_ms() {
        assert_eq!(SwarmRuntime::parse_tick_ms(Some("12000")), 12_000);
        assert_eq!(SwarmRuntime::parse_tick_ms(None), DEFAULT_SWARM_TICK_MS);
        assert_eq!(
            SwarmRuntime::parse_tick_ms(Some("0")),
            DEFAULT_SWARM_TICK_MS
        );
    }
}
