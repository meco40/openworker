//! Port of `src/server/stats/prompt-dispatch-repository/helpers.ts`.

use rusqlite::types::Value as SqlValue;
use rusqlite::Row;

use super::types::{
    DispatchKind, DispatchStatus, PromptDispatchEntry, PromptDispatchFilter, RiskFilter, RiskLevel,
    TokensSource,
};
use crate::stats::util::js_parse_int;

/// `toPositiveInt`: a parse failure or a value of 0 or less gives the fallback.
pub fn to_positive_int(raw: Option<&str>, fallback: i64) -> i64 {
    js_parse_int(raw.unwrap_or(""))
        .filter(|parsed| *parsed > 0)
        .unwrap_or(fallback)
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

fn non_empty_str(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|text| !text.is_empty())
}

fn decode_error(index: usize, message: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message,
        )),
    )
}

/// Reads a closed-set column. An unknown value is a decode error, not a silent
/// fallback, because the rows are only ever written by this code.
fn parse_column<T>(
    row: &Row<'_>,
    column: &str,
    parse: fn(&str) -> Option<T>,
) -> rusqlite::Result<T> {
    let raw: String = row.get(column)?;
    parse(&raw).ok_or_else(|| {
        let index = row.as_ref().column_index(column).unwrap_or(0);
        decode_error(index, format!("unknown {column} value {raw}"))
    })
}

/// `toEntry(row)`.
pub fn row_to_entry(row: &Row<'_>) -> rusqlite::Result<PromptDispatchEntry> {
    let risk_reasons_json: Option<String> = row.get("risk_reasons_json")?;
    let risk_reasons = match non_empty(risk_reasons_json) {
        Some(raw) => serde_json::from_str::<Vec<String>>(&raw).map_err(|error| {
            let index = row.as_ref().column_index("risk_reasons_json").unwrap_or(0);
            decode_error(index, error.to_string())
        })?,
        None => Vec::new(),
    };
    Ok(PromptDispatchEntry {
        id: row.get("id")?,
        provider_id: row.get("provider_id")?,
        model_name: row.get("model_name")?,
        account_id: non_empty(row.get("account_id")?),
        dispatch_kind: parse_column(row, "dispatch_kind", DispatchKind::parse)?,
        prompt_tokens: row.get("prompt_tokens")?,
        prompt_tokens_source: parse_column(row, "prompt_tokens_source", TokensSource::parse)?,
        completion_tokens: row.get("completion_tokens")?,
        total_tokens: row.get("total_tokens")?,
        status: parse_column(row, "status", DispatchStatus::parse)?,
        error_message: non_empty(row.get("error_message")?),
        risk_level: parse_column(row, "risk_level", RiskLevel::parse)?,
        risk_score: row.get("risk_score")?,
        risk_reasons,
        prompt_preview: row.get("prompt_preview")?,
        prompt_payload_json: row.get("prompt_payload_json")?,
        prompt_cost_usd: row.get("prompt_cost_usd")?,
        completion_cost_usd: row.get("completion_cost_usd")?,
        total_cost_usd: row.get("total_cost_usd")?,
        created_at: row.get("created_at")?,
        conversation_id: non_empty(row.get("conversation_id")?),
        turn_seq: row.get("turn_seq")?,
        latency_ms: row.get("latency_ms")?,
        tool_calls_json: row
            .get::<_, Option<String>>("tool_calls_json")?
            .unwrap_or_else(|| "[]".to_string()),
        memory_context_json: non_empty(row.get("memory_context_json")?),
    })
}

/// `buildWhere(filter)`: the WHERE clause and its bound values, in order.
pub fn build_where(filter: &PromptDispatchFilter) -> (String, Vec<SqlValue>) {
    let mut conditions: Vec<&str> = Vec::new();
    let mut params: Vec<SqlValue> = Vec::new();

    if let Some(from) = non_empty_str(&filter.from) {
        conditions.push("created_at >= ?");
        params.push(SqlValue::Text(from.to_string()));
    }
    if let Some(to) = non_empty_str(&filter.to) {
        conditions.push("created_at <= ?");
        params.push(SqlValue::Text(to.to_string()));
    }
    if let Some(before) = non_empty_str(&filter.before) {
        conditions.push("created_at < ?");
        params.push(SqlValue::Text(before.to_string()));
    }
    if let Some(turn_seq) = filter.before_turn_seq {
        conditions.push("turn_seq < ?");
        params.push(SqlValue::Integer(turn_seq));
    }
    if let Some(provider) = non_empty_str(&filter.provider) {
        conditions.push("provider_id = ?");
        params.push(SqlValue::Text(provider.to_string()));
    }
    if let Some(model) = non_empty_str(&filter.model) {
        conditions.push("model_name = ?");
        params.push(SqlValue::Text(model.to_string()));
    }
    match filter.risk {
        Some(RiskFilter::Flagged) => conditions.push("risk_level IN ('medium', 'high')"),
        Some(RiskFilter::Level(level)) => {
            conditions.push("risk_level = ?");
            params.push(SqlValue::Text(level.as_str().to_string()));
        }
        None => {}
    }
    if let Some(search) = non_empty_str(&filter.search) {
        conditions.push(
            "(prompt_preview LIKE ? OR prompt_payload_json LIKE ? OR COALESCE(error_message, '') LIKE ?)",
        );
        let like = format!("%{search}%");
        for _ in 0..3 {
            params.push(SqlValue::Text(like.clone()));
        }
    }
    if let Some(conversation_id) = non_empty_str(&filter.conversation_id) {
        conditions.push("conversation_id = ?");
        params.push(SqlValue::Text(conversation_id.to_string()));
    }

    let clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    (clause, params)
}
