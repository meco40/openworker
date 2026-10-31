//! Port of `src/server/gateway/methods/agent-v2/registerSessionMethods.ts`: the nine
//! `agent.v2.session.*` handlers. Only the handler logic is here. Registration
//! belongs to the integrator. The TypeScript file sits under `agent-v2/`, and the
//! plan assigns agent-v2 to S12, so this port is in scope only because the S8
//! brief names it.
//!
//! Swarm methods (`registerSwarmMethods.ts`, Agent Room) are not ported here.

use serde_json::{json, Map, Value};

use super::helpers::{
    ensure_persona_exists, js_number, js_truthy, optional_bounded_string, optional_string,
    required_boolean, required_bounded_string, required_string, HandlerError, MAX_GUIDANCE_CHARS,
    MAX_TASK_CHARS, MAX_TITLE_CHARS,
};
use super::ports::{
    AgentV2Sessions, CommandResult, PersonaStore, ReplayRequest, SessionCommand,
    SessionCommandKind, StartSession,
};

/// `agent.v2.session.start`.
pub async fn start(
    sessions: &dyn AgentV2Sessions,
    personas: &dyn PersonaStore,
    user_id: &str,
    params: &Value,
) -> Result<Value, HandlerError> {
    let persona_id = optional_string(params, "personaId");
    if let Some(persona_id) = &persona_id {
        ensure_persona_exists(personas, persona_id, user_id)?;
    }
    let started = sessions
        .start_session(StartSession {
            user_id: user_id.to_string(),
            title: optional_bounded_string(params, "title", MAX_TITLE_CHARS)?,
            persona_id,
            conversation_id: optional_string(params, "conversationId"),
        })
        .await?;
    Ok(json!({ "session": started.session, "events": started.events }))
}

/// `agent.v2.session.input`.
pub async fn input(
    sessions: &dyn AgentV2Sessions,
    user_id: &str,
    params: &Value,
) -> Result<Value, HandlerError> {
    let session_id = required_string(params, "sessionId")?;
    let text = required_bounded_string(params, "content", MAX_TASK_CHARS)?;
    enqueue(
        sessions,
        session_id,
        user_id,
        SessionCommandKind::Input(text),
        params,
    )
    .await
}

/// `agent.v2.session.steer`.
pub async fn steer(
    sessions: &dyn AgentV2Sessions,
    user_id: &str,
    params: &Value,
) -> Result<Value, HandlerError> {
    let session_id = required_string(params, "sessionId")?;
    let text = required_bounded_string(params, "instruction", MAX_GUIDANCE_CHARS)?;
    enqueue(
        sessions,
        session_id,
        user_id,
        SessionCommandKind::Steer(text),
        params,
    )
    .await
}

/// `agent.v2.session.follow_up`.
pub async fn follow_up(
    sessions: &dyn AgentV2Sessions,
    user_id: &str,
    params: &Value,
) -> Result<Value, HandlerError> {
    let session_id = required_string(params, "sessionId")?;
    let text = required_bounded_string(params, "content", MAX_TASK_CHARS)?;
    enqueue(
        sessions,
        session_id,
        user_id,
        SessionCommandKind::FollowUp(text),
        params,
    )
    .await
}

/// `agent.v2.session.approval.respond`.
pub async fn approval_respond(
    sessions: &dyn AgentV2Sessions,
    user_id: &str,
    params: &Value,
) -> Result<Value, HandlerError> {
    let session_id = required_string(params, "sessionId")?;
    let approval_token = required_string(params, "approvalToken")?;
    let approved = required_boolean(params, "approved")?;
    let kind = SessionCommandKind::ApprovalResponse {
        approval_token,
        approved,
        approve_always: js_truthy(params.get("approveAlways")),
        tool_id: optional_string(params, "toolId"),
        tool_function_name: optional_string(params, "toolFunctionName"),
    };
    enqueue(sessions, session_id, user_id, kind, params).await
}

/// `agent.v2.session.abort`.
pub async fn abort(
    sessions: &dyn AgentV2Sessions,
    user_id: &str,
    params: &Value,
) -> Result<Value, HandlerError> {
    let session_id = required_string(params, "sessionId")?;
    let reason = optional_bounded_string(params, "reason", MAX_GUIDANCE_CHARS)?;
    enqueue(
        sessions,
        session_id,
        user_id,
        SessionCommandKind::Abort { reason },
        params,
    )
    .await
}

/// `agent.v2.session.get`. The `session` key is omitted when there is none.
pub fn get(
    sessions: &dyn AgentV2Sessions,
    user_id: &str,
    params: &Value,
) -> Result<Value, HandlerError> {
    let session_id = required_string(params, "sessionId")?;
    let mut payload = Map::new();
    if let Some(session) = sessions.get_session(&session_id, user_id)? {
        payload.insert("session".into(), session);
    }
    Ok(Value::Object(payload))
}

/// `agent.v2.session.list`. The limit is at least 1 and defaults to 50.
pub fn list(
    sessions: &dyn AgentV2Sessions,
    user_id: &str,
    params: &Value,
) -> Result<Value, HandlerError> {
    let raw = js_number(params.get("limit"));
    let limit = if raw.is_finite() {
        raw.floor().max(1.0) as u64
    } else {
        50
    };
    Ok(json!({ "sessions": sessions.list_sessions(user_id, limit)? }))
}

/// `agent.v2.session.replay`. `nextSeq` is the last event's `seq`, or `fromSeq`
/// when the page is empty.
pub fn replay(
    sessions: &dyn AgentV2Sessions,
    user_id: &str,
    params: &Value,
) -> Result<Value, HandlerError> {
    let session_id = required_string(params, "sessionId")?;
    let from_seq = js_number(params.get("fromSeq"));
    if !from_seq.is_finite() || from_seq < 0.0 {
        return Err(HandlerError::invalid(
            "fromSeq must be a non-negative number",
        ));
    }
    let raw_limit = js_number(params.get("limit"));
    let limit = raw_limit
        .is_finite()
        .then(|| raw_limit.floor().max(1.0) as u64);

    let events = sessions.replay_events(ReplayRequest {
        session_id,
        user_id: user_id.to_string(),
        from_seq,
        limit,
    })?;
    let next_seq = match events.last() {
        Some(last) => last.get("seq").cloned(),
        None => Some(number_value(from_seq)),
    };

    let mut payload = Map::new();
    if let Some(next_seq) = next_seq {
        payload.insert("nextSeq".into(), next_seq);
    }
    payload.insert("events".into(), Value::Array(events));
    Ok(Value::Object(payload))
}

/// Writes whole numbers as JSON integers, so `3` does not come out as `3.0`.
fn number_value(number: f64) -> Value {
    if number.fract() == 0.0 && number.abs() < 9.0e15 {
        json!(number as i64)
    } else {
        json!(number)
    }
}

async fn enqueue(
    sessions: &dyn AgentV2Sessions,
    session_id: String,
    user_id: &str,
    kind: SessionCommandKind,
    params: &Value,
) -> Result<Value, HandlerError> {
    let result: CommandResult = sessions
        .enqueue(SessionCommand {
            session_id,
            user_id: user_id.to_string(),
            kind,
            idempotency_key: optional_string(params, "idempotencyKey"),
            command_id: None,
        })
        .await?;
    Ok(json!({ "command": result.command, "session": result.session }))
}

#[cfg(test)]
mod tests {
    use super::super::test_support::Fake;
    use super::*;

    #[tokio::test]
    async fn start_checks_the_persona_and_forwards_trimmed_fields() {
        let fake = Fake::default();
        let err = start(&fake, &fake, "u1", &json!({"personaId": "p9"}))
            .await
            .unwrap_err();
        assert_eq!(err, HandlerError::invalid("Persona not found: p9"));

        fake.state.lock().unwrap().personas = vec![("p9".into(), None)];
        let payload = start(
            &fake,
            &fake,
            "u1",
            &json!({"personaId": " p9 ", "title": "T", "conversationId": "c1"}),
        )
        .await
        .unwrap();
        assert_eq!(payload["session"]["id"], "s1");
        let started = fake.state.lock().unwrap().started[0].clone();
        assert_eq!(
            started,
            StartSession {
                user_id: "u1".into(),
                title: Some("T".into()),
                persona_id: Some("p9".into()),
                conversation_id: Some("c1".into()),
            }
        );
    }

    #[tokio::test]
    async fn input_checks_the_session_and_the_task_size() {
        let fake = Fake::default();
        let err = input(&fake, "u1", &json!({"content": "x"}))
            .await
            .unwrap_err();
        assert_eq!(err, HandlerError::invalid("sessionId is required"));

        let too_long = "a".repeat(MAX_TASK_CHARS + 1);
        let err = input(
            &fake,
            "u1",
            &json!({"sessionId": "s1", "content": too_long}),
        )
        .await
        .unwrap_err();
        assert_eq!(
            err,
            HandlerError::invalid("content exceeds max size (8000).")
        );

        let payload = input(
            &fake,
            "u1",
            &json!({"sessionId": "s1", "content": "  go  ", "idempotencyKey": "k1"}),
        )
        .await
        .unwrap();
        assert_eq!(
            payload,
            json!({"command": "cmd-1", "session": {"id": "s1"}})
        );
        let command = fake.state.lock().unwrap().commands[0].clone();
        assert_eq!(command.kind, SessionCommandKind::Input("go".into()));
        assert_eq!(command.idempotency_key, Some("k1".into()));
    }

    #[tokio::test]
    async fn approval_respond_requires_the_approved_key_and_reads_null_as_false() {
        let fake = Fake::default();
        let err = approval_respond(
            &fake,
            "u1",
            &json!({"sessionId": "s1", "approvalToken": "t"}),
        )
        .await
        .unwrap_err();
        assert_eq!(err, HandlerError::invalid("approved is required"));

        approval_respond(
            &fake,
            "u1",
            &json!({"sessionId": "s1", "approvalToken": "t", "approved": null}),
        )
        .await
        .unwrap();
        let kind = fake.state.lock().unwrap().commands[0].kind.clone();
        assert_eq!(
            kind,
            SessionCommandKind::ApprovalResponse {
                approval_token: "t".into(),
                approved: false,
                approve_always: false,
                tool_id: None,
                tool_function_name: None,
            }
        );
    }

    #[test]
    fn list_defaults_and_clamps_the_limit() {
        let fake = Fake::default();
        for (params, expected) in [
            (json!({}), 50),
            (json!({"limit": null}), 1),
            (json!({"limit": "7"}), 7),
            (json!({"limit": 0.4}), 1),
        ] {
            list(&fake, "u1", &params).unwrap();
            assert_eq!(
                fake.state.lock().unwrap().listed.clone(),
                Some(("u1".to_string(), expected))
            );
        }
    }

    #[test]
    fn replay_rejects_a_negative_from_seq_and_reports_the_last_seq() {
        let fake = Fake::default();
        let err = replay(&fake, "u1", &json!({"sessionId": "s1", "fromSeq": -1})).unwrap_err();
        assert_eq!(
            err,
            HandlerError::invalid("fromSeq must be a non-negative number")
        );

        fake.state.lock().unwrap().replay_events = vec![json!({"seq": 4}), json!({"seq": 9})];
        let payload = replay(
            &fake,
            "u1",
            &json!({"sessionId": "s1", "fromSeq": 3, "limit": "0"}),
        )
        .unwrap();
        assert_eq!(payload["nextSeq"], 9);
        assert_eq!(
            fake.state.lock().unwrap().replay_request.clone(),
            Some(ReplayRequest {
                session_id: "s1".into(),
                user_id: "u1".into(),
                from_seq: 3.0,
                limit: Some(1),
            })
        );

        fake.state.lock().unwrap().replay_events.clear();
        let payload = replay(&fake, "u1", &json!({"sessionId": "s1", "fromSeq": 3})).unwrap();
        assert_eq!(payload, json!({"events": [], "nextSeq": 3}));
    }

    #[test]
    fn get_omits_the_session_key_when_there_is_none() {
        let fake = Fake::default();
        let payload = get(&fake, "u1", &json!({"sessionId": "s1"})).unwrap();
        assert_eq!(payload, json!({}));
    }
}
