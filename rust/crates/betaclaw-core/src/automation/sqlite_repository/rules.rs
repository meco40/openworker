//! Port of `src/server/automation/sqlite-automation-repository/rules.ts`.
//!
//! Same SQL as the TypeScript module. Every timestamp is written with `toISOString`
//! semantics, because the due-rule query compares them as strings.

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use uuid::Uuid;

use crate::automation::flow_types::FlowGraph;
use crate::automation::row_mappers::to_rule;
use crate::automation::types::{
    AutomationRule, CreateAutomationRuleInput, UpdateAutomationRuleInput,
};
use crate::stats::util::now_iso;

fn optional_text(value: &Option<String>) -> Value {
    match value {
        Some(text) => Value::Text(text.clone()),
        None => Value::Null,
    }
}

pub fn create_rule(
    connection: &Connection,
    input: &CreateAutomationRuleInput,
) -> rusqlite::Result<String> {
    let now = now_iso();
    let id = Uuid::new_v4().to_string();
    let next_run_at = input
        .next_run_at
        .clone()
        .flatten()
        .filter(|value| !value.is_empty());
    connection.execute(
        "INSERT INTO automation_rules (
            id, user_id, name, cron_expression, timezone, prompt, enabled,
            next_run_at, last_run_at, consecutive_failures, last_error, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, 0, NULL, ?9, ?10)",
        params![
            id,
            input.user_id,
            input.name,
            input.cron_expression,
            input.timezone,
            input.prompt,
            i64::from(input.enabled),
            next_run_at,
            now,
            now,
        ],
    )?;
    Ok(id)
}

/// `updateRule`. Fields left as `None` keep their stored value. An empty patch writes nothing,
/// so `updated_at` is not touched.
pub fn update_rule(
    connection: &Connection,
    rule_id: &str,
    user_id: &str,
    patch: &UpdateAutomationRuleInput,
) -> rusqlite::Result<()> {
    let mut sets: Vec<&str> = Vec::new();
    let mut values: Vec<Value> = Vec::new();

    if let Some(name) = &patch.name {
        sets.push("name = ?");
        values.push(Value::Text(name.clone()));
    }
    if let Some(cron_expression) = &patch.cron_expression {
        sets.push("cron_expression = ?");
        values.push(Value::Text(cron_expression.clone()));
    }
    if let Some(timezone) = &patch.timezone {
        sets.push("timezone = ?");
        values.push(Value::Text(timezone.clone()));
    }
    if let Some(prompt) = &patch.prompt {
        sets.push("prompt = ?");
        values.push(Value::Text(prompt.clone()));
    }
    if let Some(enabled) = patch.enabled {
        sets.push("enabled = ?");
        values.push(Value::Integer(i64::from(enabled)));
    }
    if let Some(next_run_at) = &patch.next_run_at {
        sets.push("next_run_at = ?");
        values.push(optional_text(next_run_at));
    }
    if let Some(last_run_at) = &patch.last_run_at {
        sets.push("last_run_at = ?");
        values.push(optional_text(last_run_at));
    }
    if let Some(consecutive_failures) = patch.consecutive_failures {
        sets.push("consecutive_failures = ?");
        values.push(Value::Integer(consecutive_failures));
    }
    if let Some(last_error) = &patch.last_error {
        sets.push("last_error = ?");
        values.push(optional_text(last_error));
    }

    if sets.is_empty() {
        return Ok(());
    }

    sets.push("updated_at = ?");
    values.push(Value::Text(now_iso()));
    values.push(Value::Text(rule_id.to_string()));
    values.push(Value::Text(user_id.to_string()));

    let sql = format!(
        "UPDATE automation_rules SET {} WHERE id = ? AND user_id = ?",
        sets.join(", ")
    );
    connection.execute(&sql, params_from_iter(values))?;
    Ok(())
}

pub fn delete_rule(connection: &Connection, rule_id: &str) -> rusqlite::Result<()> {
    connection.execute(
        "DELETE FROM automation_dead_letters WHERE rule_id = ?1",
        params![rule_id],
    )?;
    connection.execute(
        "DELETE FROM automation_runs WHERE rule_id = ?1",
        params![rule_id],
    )?;
    connection.execute(
        "DELETE FROM automation_rules WHERE id = ?1",
        params![rule_id],
    )?;
    Ok(())
}

pub fn get_rule(
    connection: &Connection,
    rule_id: &str,
    user_id: &str,
) -> rusqlite::Result<Option<AutomationRule>> {
    connection
        .query_row(
            "SELECT * FROM automation_rules WHERE id = ?1 AND user_id = ?2",
            params![rule_id, user_id],
            to_rule,
        )
        .optional()
}

pub fn get_rule_by_id(
    connection: &Connection,
    rule_id: &str,
) -> rusqlite::Result<Option<AutomationRule>> {
    connection
        .query_row(
            "SELECT * FROM automation_rules WHERE id = ?1",
            params![rule_id],
            to_rule,
        )
        .optional()
}

pub fn list_rules(connection: &Connection, user_id: &str) -> rusqlite::Result<Vec<AutomationRule>> {
    let mut statement = connection
        .prepare("SELECT * FROM automation_rules WHERE user_id = ?1 ORDER BY updated_at DESC")?;
    let rows = statement.query_map(params![user_id], to_rule)?;
    rows.collect()
}

pub fn list_due_rules(
    connection: &Connection,
    now_iso: &str,
    limit: i64,
) -> rusqlite::Result<Vec<AutomationRule>> {
    let mut statement = connection.prepare(
        "SELECT *
         FROM automation_rules
         WHERE enabled = 1
           AND next_run_at IS NOT NULL
           AND next_run_at <= ?1
         ORDER BY next_run_at ASC
         LIMIT ?2",
    )?;
    let rows = statement.query_map(params![now_iso, limit], to_rule)?;
    rows.collect()
}

pub fn save_flow_graph(
    connection: &Connection,
    rule_id: &str,
    user_id: &str,
    graph: &FlowGraph,
) -> rusqlite::Result<()> {
    let json = serde_json::to_string(graph)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    connection.execute(
        "UPDATE automation_rules SET flow_graph = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4",
        params![json, now_iso(), rule_id, user_id],
    )?;
    Ok(())
}
