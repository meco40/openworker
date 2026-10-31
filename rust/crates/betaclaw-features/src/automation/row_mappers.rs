//! Port of `src/server/automation/automationRowMappers.ts`.
//!
//! Column names are the TypeScript ones, so `.local/automation.db` stays readable by both
//! sides. The TypeScript casts become typed reads. A blank text in a nullable column becomes
//! `None`, as `value || null` does. An unreadable `flow_graph` becomes `None`, as the
//! corrupt-JSON branch does.

use rusqlite::types::Type;
use rusqlite::Row;

use super::flow_types::FlowGraph;
use super::types::{
    AutomationDeadLetter, AutomationRule, AutomationRun, AutomationRunStatus,
    AutomationTriggerSource, SchedulerLeaseState,
};

fn blank_to_none(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

/// Unknown enum text cannot be mapped. TypeScript passes it through, this port rejects it.
fn unknown_value(column: &str, value: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("unknown {column} {value}"),
        )),
    )
}

pub fn to_rule(row: &Row<'_>) -> rusqlite::Result<AutomationRule> {
    let flow_graph = blank_to_none(row.get::<_, Option<String>>("flow_graph")?)
        .and_then(|raw| serde_json::from_str::<FlowGraph>(&raw).ok());
    Ok(AutomationRule {
        id: row.get("id")?,
        user_id: row.get("user_id")?,
        name: row.get("name")?,
        cron_expression: row.get("cron_expression")?,
        timezone: row.get("timezone")?,
        prompt: row.get("prompt")?,
        enabled: row.get::<_, i64>("enabled")? == 1,
        next_run_at: blank_to_none(row.get("next_run_at")?),
        last_run_at: blank_to_none(row.get("last_run_at")?),
        consecutive_failures: row
            .get::<_, Option<i64>>("consecutive_failures")?
            .unwrap_or(0),
        last_error: blank_to_none(row.get("last_error")?),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        flow_graph,
    })
}

pub fn to_run(row: &Row<'_>) -> rusqlite::Result<AutomationRun> {
    let trigger_source: String = row.get("trigger_source")?;
    let status: String = row.get("status")?;
    Ok(AutomationRun {
        id: row.get("id")?,
        rule_id: row.get("rule_id")?,
        user_id: row.get("user_id")?,
        trigger_source: AutomationTriggerSource::parse(&trigger_source)
            .ok_or_else(|| unknown_value("trigger_source", &trigger_source))?,
        scheduled_for: row.get("scheduled_for")?,
        run_key: row.get("run_key")?,
        status: AutomationRunStatus::parse(&status)
            .ok_or_else(|| unknown_value("status", &status))?,
        attempt: row.get::<_, Option<i64>>("attempt")?.unwrap_or(0),
        next_attempt_at: blank_to_none(row.get("next_attempt_at")?),
        error_message: blank_to_none(row.get("error_message")?),
        result_summary: blank_to_none(row.get("result_summary")?),
        started_at: blank_to_none(row.get("started_at")?),
        finished_at: blank_to_none(row.get("finished_at")?),
        created_at: row.get("created_at")?,
    })
}

pub fn to_dead_letter(row: &Row<'_>) -> rusqlite::Result<AutomationDeadLetter> {
    Ok(AutomationDeadLetter {
        id: row.get("id")?,
        run_id: row.get("run_id")?,
        rule_id: row.get("rule_id")?,
        reason: row.get("reason")?,
        payload: blank_to_none(row.get("payload")?),
        created_at: row.get("created_at")?,
    })
}

pub fn to_lease(row: &Row<'_>) -> rusqlite::Result<SchedulerLeaseState> {
    Ok(SchedulerLeaseState {
        singleton_key: row.get("singleton_key")?,
        instance_id: row.get("instance_id")?,
        heartbeat_at: row.get("heartbeat_at")?,
        updated_at: row.get("updated_at")?,
    })
}
