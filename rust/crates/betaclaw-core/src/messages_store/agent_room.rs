//! Port of `src/server/channels/messages/repository/queries/agentRoom.ts`.
//!
//! | TypeScript member                    | Rust member                                            |
//! | ------------------------------------ | ----------------------------------------------------- |
//! | `createAgentRoomSwarm`               | [`AgentRoomQueries::create_agent_room_swarm`]         |
//! | `listAgentRoomSwarms`                | [`AgentRoomQueries::list_agent_room_swarms`]          |
//! | `getAgentRoomSwarm`                  | [`AgentRoomQueries::get_agent_room_swarm`]            |
//! | `isAgentRoomConversation`            | [`AgentRoomQueries::is_agent_room_conversation`]      |
//! | `updateAgentRoomSwarm`               | [`AgentRoomQueries::update_agent_room_swarm`]         |
//! | `listRunningSwarms`                  | [`AgentRoomQueries::list_running_swarms`]             |
//! | `recoverRunningSwarms`               | [`AgentRoomQueries::recover_running_swarms`]          |
//! | `deleteAgentRoomSwarm`               | [`AgentRoomQueries::delete_agent_room_swarm`]         |
//! | `getAgentRoomSwarmMetrics`           | [`AgentRoomQueries::get_agent_room_swarm_metrics`]    |
//! | `safeJsonParse`                      | [`safe_json_parse`]                                   |
//! | `parsePhaseBuffer`                   | [`parse_phase_buffer`]                                |
//! | `normalizeStatus` / `normalizePhase` | [`AgentRoomSwarmStatus::parse_or_idle`] / [`AgentRoomSwarmPhase::parse_or_analysis`] |
//! | `toRecord`                           | [`to_record`]                                         |
//!
//! The four `*_json` columns are hand-normalised on read: unparsable text falls
//! back to the type's empty value instead of failing the whole query, which is
//! what `safeJsonParse` does in the source.

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::de::DeserializeOwned;

use super::types::{
    normalize_user_id, now_iso, AgentRoomSwarmMetrics, AgentRoomSwarmPatch, AgentRoomSwarmPhase,
    AgentRoomSwarmRecord, AgentRoomSwarmStatus, CreateAgentRoomSwarmInput, MessageRepositoryError,
    PhaseBufferEntry, SwarmFriction, SwarmUnit,
};

/// `safeJsonParse` from `agentRoom.ts:21-30`.
fn safe_json_parse<T: DeserializeOwned + Default>(value: Option<&str>) -> T {
    let Some(value) = value.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return T::default();
    };
    serde_json::from_str(value).unwrap_or_default()
}

/// `parsePhaseBuffer` from `agentRoom.ts:36-65`.
///
/// Handles both the legacy string format (`agentsession:pid:sid:seq`,
/// `speaker:personaId`) and the typed object format. Unknown object shapes are
/// dropped with a debug log instead of being pushed through the unchecked
/// `item as PhaseBufferEntry` cast of the source.
pub fn parse_phase_buffer(value: Option<&str>) -> Vec<PhaseBufferEntry> {
    let raw: Vec<serde_json::Value> = safe_json_parse(value);
    let mut entries: Vec<PhaseBufferEntry> = Vec::new();

    for item in raw {
        if let Some(object) = item.as_object() {
            if object.contains_key("type") {
                match serde_json::from_value::<PhaseBufferEntry>(item.clone()) {
                    Ok(entry) => entries.push(entry),
                    Err(error) => tracing::debug!(
                        scope = "messages.agent_room",
                        error = %crate::safe_error_message(&error),
                        "dropping a phase buffer entry with an unknown type tag"
                    ),
                }
            }
        } else if let Some(text) = item.as_str() {
            // Legacy colon-delimited string format — migrate on read.
            if let Some(rest) = text.strip_prefix("agentsession:") {
                let parts: Vec<&str> = rest.split(':').collect();
                if parts.len() >= 3 {
                    entries.push(PhaseBufferEntry::AgentSession {
                        persona_id: parts[0].to_string(),
                        session_id: parts[1].to_string(),
                        last_seq: parts[2].parse::<i64>().unwrap_or(0),
                    });
                }
            } else if let Some(persona_id) = text.strip_prefix("speaker:") {
                let persona_id = persona_id.trim();
                if !persona_id.is_empty() {
                    entries.push(PhaseBufferEntry::Speaker {
                        persona_id: persona_id.to_string(),
                    });
                }
            }
        }
    }

    entries
}

/// `toRecord` from `agentRoom.ts:95-123`.
fn to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentRoomSwarmRecord> {
    let status: String = row.get("status")?;
    let current_phase: String = row.get("current_phase")?;
    let units_json: Option<String> = row.get("units_json")?;
    let artifact_history_json: Option<String> = row.get("artifact_history_json")?;
    let friction_json: Option<String> = row.get("friction_json")?;
    let phase_buffer_json: Option<String> = row.get("phase_buffer_json")?;

    // `safeJsonParse` cannot express "absent -> the module constant", so the
    // friction fallback is resolved here.
    let friction: SwarmFriction = match friction_json.as_deref().map(str::trim) {
        Some(raw) if !raw.is_empty() => {
            serde_json::from_str(raw).unwrap_or_else(|_| SwarmFriction::default_friction())
        }
        _ => SwarmFriction::default_friction(),
    };

    Ok(AgentRoomSwarmRecord {
        id: row.get("id")?,
        conversation_id: row.get("conversation_id")?,
        user_id: row.get("user_id")?,
        session_id: row
            .get::<_, Option<String>>("session_id")?
            .filter(|value| !value.is_empty()),
        title: row.get("title")?,
        task: row.get("task")?,
        lead_persona_id: row.get("lead_persona_id")?,
        units: safe_json_parse::<Vec<SwarmUnit>>(units_json.as_deref()),
        status: AgentRoomSwarmStatus::parse_or_idle(&status),
        current_phase: AgentRoomSwarmPhase::parse_or_analysis(&current_phase),
        consensus_score: row.get::<_, Option<i64>>("consensus_score")?.unwrap_or(0),
        hold_flag: row.get::<_, Option<i64>>("hold_flag")?.unwrap_or(0) == 1,
        artifact: row
            .get::<_, Option<String>>("artifact_json")?
            .unwrap_or_default(),
        artifact_history: safe_json_parse::<Vec<String>>(artifact_history_json.as_deref()),
        friction,
        last_seq: row.get::<_, Option<i64>>("last_seq")?.unwrap_or(0),
        current_deploy_command_id: row
            .get::<_, Option<String>>("current_deploy_command_id")?
            .filter(|value| !value.is_empty()),
        search_enabled: row.get::<_, Option<i64>>("search_enabled")?.unwrap_or(0) == 1,
        swarm_template: row
            .get::<_, Option<String>>("swarm_template")?
            .filter(|value| !value.is_empty()),
        pause_between_phases: row
            .get::<_, Option<i64>>("pause_between_phases")?
            .unwrap_or(0)
            == 1,
        phase_buffer: parse_phase_buffer(phase_buffer_json.as_deref()),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// `AgentRoomQueries` from `agentRoom.ts:125`.
pub struct AgentRoomQueries<'a> {
    db: &'a Connection,
}

impl<'a> AgentRoomQueries<'a> {
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }

    /// `createAgentRoomSwarm` from `agentRoom.ts:131-202`.
    #[allow(clippy::too_many_arguments)]
    pub fn create_agent_room_swarm(
        &self,
        input: &CreateAgentRoomSwarmInput<'_>,
    ) -> Result<AgentRoomSwarmRecord, MessageRepositoryError> {
        let id = format!("swarm-{}", uuid::Uuid::new_v4());
        let now = now_iso();
        let normalized_user_id = normalize_user_id(Some(input.user_id));
        let status = input.status.unwrap_or(AgentRoomSwarmStatus::Idle);
        let current_phase = input.current_phase.unwrap_or(AgentRoomSwarmPhase::Analysis);
        // `Number.isFinite(Number(input.consensusScore))` — a non-finite value
        // falls back to 0 instead of poisoning the column.
        let consensus_score = input
            .consensus_score
            .filter(|value| value.is_finite())
            .map(|value| value as i64)
            .unwrap_or(0);
        let hold_flag = if input.hold_flag.unwrap_or(false) {
            1
        } else {
            0
        };
        let friction = input.friction.clone().unwrap_or_else(|| SwarmFriction {
            updated_at: now.clone(),
            ..SwarmFriction::default_friction()
        });

        self.db.execute(
            "
            INSERT INTO agent_room_swarms (
              id, conversation_id, user_id, session_id, title, task, lead_persona_id, units_json,
              status, current_phase, consensus_score, hold_flag, artifact_json, artifact_history_json,
              friction_json, last_seq, search_enabled, swarm_template, pause_between_phases,
              created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
          ",
            params![
                id,
                input.conversation_id,
                normalized_user_id,
                input.session_id.filter(|value| !value.is_empty()),
                input.title,
                input.task,
                input.lead_persona_id,
                serde_json::to_string(&input.units)
                    .map_err(|error| MessageRepositoryError::Json(error.to_string()))?,
                status.as_str(),
                current_phase.as_str(),
                consensus_score,
                hold_flag,
                input.artifact.unwrap_or_default(),
                serde_json::to_string(&input.artifact_history)
                    .map_err(|error| MessageRepositoryError::Json(error.to_string()))?,
                serde_json::to_string(&friction)
                    .map_err(|error| MessageRepositoryError::Json(error.to_string()))?,
                input
                    .last_seq
                    .filter(|value| value.is_finite())
                    .map(|value| value as i64)
                    .unwrap_or(0),
                if input.search_enabled.unwrap_or(false) { 1 } else { 0 },
                input.swarm_template.filter(|value| !value.is_empty()),
                if input.pause_between_phases.unwrap_or(false) { 1 } else { 0 },
                now,
                now
            ],
        )?;

        self.get_agent_room_swarm(&id, &normalized_user_id)?.ok_or(
            MessageRepositoryError::MissingRow {
                context: "agent_room_swarms.create",
            },
        )
    }

    /// `listAgentRoomSwarms` from `agentRoom.ts:204-218`.
    pub fn list_agent_room_swarms(
        &self,
        user_id: &str,
        limit: i64,
    ) -> Result<Vec<AgentRoomSwarmRecord>, MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(Some(user_id));
        let safe_limit = clamp_limit(limit, 50);
        let mut statement = self.db.prepare(
            "
            SELECT * FROM agent_room_swarms
            WHERE user_id = ?1
            ORDER BY updated_at DESC
            LIMIT ?2
          ",
        )?;
        let rows = statement.query_map(params![normalized_user_id, safe_limit], to_record)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// `getAgentRoomSwarm` from `agentRoom.ts:220-232`.
    pub fn get_agent_room_swarm(
        &self,
        id: &str,
        user_id: &str,
    ) -> Result<Option<AgentRoomSwarmRecord>, MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(Some(user_id));
        self.db
            .query_row(
                "
                SELECT * FROM agent_room_swarms
                WHERE id = ?1 AND user_id = ?2
                LIMIT 1
              ",
                params![id, normalized_user_id],
                to_record,
            )
            .optional()
            .map_err(Into::into)
    }

    /// `isAgentRoomConversation` from `agentRoom.ts:234-264`.
    pub fn is_agent_room_conversation(
        &self,
        conversation_id: &str,
        user_id: Option<&str>,
    ) -> Result<bool, MessageRepositoryError> {
        let normalized_conversation_id = conversation_id.trim();
        if normalized_conversation_id.is_empty() {
            return Ok(false);
        }

        let found: Option<i64> = match user_id {
            Some(user_id) => {
                let normalized_user_id = normalize_user_id(Some(user_id));
                self.db
                    .query_row(
                        "
                        SELECT 1
                        FROM agent_room_swarms
                        WHERE conversation_id = ?1 AND user_id = ?2
                        LIMIT 1
                      ",
                        params![normalized_conversation_id, normalized_user_id],
                        |row| row.get(0),
                    )
                    .optional()?
            }
            None => self
                .db
                .query_row(
                    "
                    SELECT 1
                    FROM agent_room_swarms
                    WHERE conversation_id = ?1
                    LIMIT 1
                  ",
                    params![normalized_conversation_id],
                    |row| row.get(0),
                )
                .optional()?,
        };
        Ok(found.is_some())
    }

    /// `updateAgentRoomSwarm` from `agentRoom.ts:266-384`.
    ///
    /// Builds the `SET` list from the patch. A `None` field is left untouched; an
    /// `Option<Option<T>>` field can distinguish "not supplied" from "supplied as
    /// null", which is how `sessionId`, `currentDeployCommandId` and
    /// `swarmTemplate` are cleared.
    pub fn update_agent_room_swarm(
        &self,
        id: &str,
        user_id: &str,
        patch: &AgentRoomSwarmPatch,
    ) -> Result<Option<AgentRoomSwarmRecord>, MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(Some(user_id));
        if self
            .get_agent_room_swarm(id, &normalized_user_id)?
            .is_none()
        {
            return Ok(None);
        }

        let mut updates: Vec<&'static str> = Vec::new();
        let mut values: Vec<SqlValue> = Vec::new();

        if let Some(session_id) = &patch.session_id {
            updates.push("session_id");
            values.push(session_id.clone().into());
        }
        if let Some(title) = &patch.title {
            updates.push("title");
            values.push(title.as_str().to_owned().into());
        }
        if let Some(task) = &patch.task {
            updates.push("task");
            values.push(task.as_str().to_owned().into());
        }
        if let Some(lead_persona_id) = &patch.lead_persona_id {
            updates.push("lead_persona_id");
            values.push(lead_persona_id.as_str().to_owned().into());
        }
        if let Some(units) = &patch.units {
            updates.push("units_json");
            values.push(json_text(units)?.into());
        }
        if let Some(status) = patch.status {
            updates.push("status");
            values.push(status.as_str().to_owned().into());
        }
        if let Some(current_phase) = patch.current_phase {
            updates.push("current_phase");
            values.push(current_phase.as_str().to_owned().into());
        }
        if let Some(consensus_score) = patch.consensus_score {
            updates.push("consensus_score");
            values.push(consensus_score.into());
        }
        if let Some(hold_flag) = patch.hold_flag {
            updates.push("hold_flag");
            values.push(if hold_flag { 1 } else { 0 }.into());
        }
        if let Some(artifact) = &patch.artifact {
            updates.push("artifact_json");
            values.push(artifact.as_str().to_owned().into());
        }
        if let Some(artifact_history) = &patch.artifact_history {
            updates.push("artifact_history_json");
            values.push(json_text(artifact_history)?.into());
        }
        if let Some(friction) = &patch.friction {
            updates.push("friction_json");
            values.push(json_text(friction)?.into());
        }
        if let Some(last_seq) = patch.last_seq {
            updates.push("last_seq");
            values.push(last_seq.into());
        }
        if let Some(current_deploy_command_id) = &patch.current_deploy_command_id {
            updates.push("current_deploy_command_id");
            values.push(current_deploy_command_id.clone().into());
        }
        if let Some(search_enabled) = patch.search_enabled {
            updates.push("search_enabled");
            values.push(if search_enabled { 1 } else { 0 }.into());
        }
        if let Some(swarm_template) = &patch.swarm_template {
            updates.push("swarm_template");
            values.push(swarm_template.clone().into());
        }
        if let Some(pause_between_phases) = patch.pause_between_phases {
            updates.push("pause_between_phases");
            values.push(if pause_between_phases { 1 } else { 0 }.into());
        }
        if let Some(phase_buffer) = &patch.phase_buffer {
            updates.push("phase_buffer_json");
            values.push(json_text(phase_buffer)?.into());
        }

        updates.push("updated_at");
        values.push(now_iso().into());
        values.push(id.to_owned().into());
        values.push(normalized_user_id.to_owned().into());

        let assignments: Vec<String> = updates
            .iter()
            .map(|column| format!("{column} = ?"))
            .collect();
        let sql = format!(
            "UPDATE agent_room_swarms SET {} WHERE id = ? AND user_id = ?",
            assignments.join(", ")
        );
        self.db
            .execute(&sql, params_from_iter(values.iter()))
            .map_err(MessageRepositoryError::Database)?;

        self.get_agent_room_swarm(id, &normalized_user_id)
    }

    /// `listRunningSwarms` from `agentRoom.ts:386-395` — admin query, no userId
    /// guard, used by the server-side orchestrator only.
    pub fn list_running_swarms(
        &self,
        limit: i64,
    ) -> Result<Vec<AgentRoomSwarmRecord>, MessageRepositoryError> {
        let safe_limit = clamp_limit(limit, 50);
        let mut statement = self.db.prepare(
            "SELECT * FROM agent_room_swarms WHERE status = 'running' ORDER BY updated_at ASC LIMIT ?1",
        )?;
        let rows = statement.query_map(params![safe_limit], to_record)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// `recoverRunningSwarms` from `agentRoom.ts:397-409`.
    ///
    /// Admin recovery — sets all running swarms to 'hold' on server restart.
    /// Returns the number of swarms affected.
    pub fn recover_running_swarms(&self) -> Result<usize, MessageRepositoryError> {
        let changed = self.db.execute(
            "UPDATE agent_room_swarms SET status = 'hold', hold_flag = 1, updated_at = ?1 WHERE status = 'running'",
            params![now_iso()],
        )?;
        Ok(changed)
    }

    /// `deleteAgentRoomSwarm` from `agentRoom.ts:411-417`.
    pub fn delete_agent_room_swarm(
        &self,
        id: &str,
        user_id: &str,
    ) -> Result<bool, MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(Some(user_id));
        let changed = self.db.execute(
            "DELETE FROM agent_room_swarms WHERE id = ?1 AND user_id = ?2",
            params![id, normalized_user_id],
        )?;
        Ok(changed > 0)
    }

    /// `getAgentRoomSwarmMetrics` from `agentRoom.ts:419-447`.
    pub fn get_agent_room_swarm_metrics(
        &self,
        user_id: &str,
    ) -> Result<AgentRoomSwarmMetrics, MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(Some(user_id));

        let running_swarms: i64 = self.db.query_row(
            "SELECT COUNT(*) AS count FROM agent_room_swarms WHERE user_id = ?1 AND status = 'running'",
            params![normalized_user_id],
            |row| row.get(0),
        )?;
        let hold_swarms: i64 = self.db.query_row(
            "SELECT COUNT(*) AS count FROM agent_room_swarms WHERE user_id = ?1 AND hold_flag = 1",
            params![normalized_user_id],
            |row| row.get(0),
        )?;
        let last_error_at: Option<String> = self
            .db
            .query_row(
                "
                SELECT updated_at
                FROM agent_room_swarms
                WHERE user_id = ?1 AND status = 'error'
                ORDER BY updated_at DESC
                LIMIT 1
              ",
                params![normalized_user_id],
                |row| row.get::<_, String>("updated_at"),
            )
            .optional()?
            .filter(|value| !value.is_empty());

        Ok(AgentRoomSwarmMetrics {
            running_swarms,
            hold_swarms,
            last_error_at,
        })
    }
}

/// `Math.max(1, Math.min(200, Math.floor(limit || 50)))` — shared by
/// `listAgentRoomSwarms` and `listRunningSwarms`.
fn clamp_limit(limit: i64, fallback: i64) -> i64 {
    if limit == 0 {
        return fallback;
    }
    limit.clamp(1, 200)
}

fn json_text<T: serde::Serialize>(value: &T) -> Result<String, MessageRepositoryError> {
    serde_json::to_string(value).map_err(|error| MessageRepositoryError::Json(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_typed_phase_buffer_format() {
        let entries = parse_phase_buffer(Some(
            r#"[{"type":"agentsession","personaId":"p-1","sessionId":"s-1","lastSeq":9},
                {"type":"speaker","personaId":"p-2"},
                {"type":"speakerOverride","personaId":"p-3"},
                {"type":"phaseSummaryPending","fromPhase":"critique"}]"#,
        ));
        assert_eq!(entries.len(), 4);
        assert_eq!(
            entries[0],
            PhaseBufferEntry::AgentSession {
                persona_id: "p-1".into(),
                session_id: "s-1".into(),
                last_seq: 9,
            }
        );
        assert_eq!(
            entries[3],
            PhaseBufferEntry::PhaseSummaryPending {
                from_phase: "critique".into(),
            }
        );
    }

    #[test]
    fn upgrades_the_legacy_colon_delimited_format() {
        let entries = parse_phase_buffer(Some(
            r#"["agentsession:p-1:s-1:12","speaker:p-2","agentsession:short","speaker:  ","garbage"]"#,
        ));
        assert_eq!(
            entries,
            vec![
                PhaseBufferEntry::AgentSession {
                    persona_id: "p-1".into(),
                    session_id: "s-1".into(),
                    last_seq: 12,
                },
                PhaseBufferEntry::Speaker {
                    persona_id: "p-2".into(),
                },
            ]
        );
    }

    #[test]
    fn falls_back_to_an_empty_buffer_for_unusable_values() {
        assert!(parse_phase_buffer(None).is_empty());
        assert!(parse_phase_buffer(Some("")).is_empty());
        assert!(parse_phase_buffer(Some("{not json")).is_empty());
        assert!(parse_phase_buffer(Some(r#"{"not":"an array"}"#)).is_empty());
        assert!(parse_phase_buffer(Some(r#"[1,2,3]"#)).is_empty());
    }

    #[test]
    fn limits_are_clamped_like_the_source() {
        assert_eq!(clamp_limit(0, 50), 50);
        assert_eq!(clamp_limit(-5, 50), 1);
        assert_eq!(clamp_limit(5_000, 50), 200);
        assert_eq!(clamp_limit(10, 50), 10);
    }
}
