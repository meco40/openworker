//! Wire helpers of the task family: JSON replies, body decoding in the style of
//! `parseJsonBody` and the Zod schemas, row-to-JSON conversion, and the failure
//! type that lets a handler use `?` and still answer with the route's own message.
//!
//! Validation messages are Zod's default English texts. The custom texts of the
//! schemas are not copied, so `details` is close to, not equal to, the TypeScript one.

use axum::body::Bytes;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use betaclaw_core::gateway::broadcast::broadcast;
use betaclaw_core::tasks::validation::is_uuid;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, Params, Row};
use serde_json::{json, Map, Number, Value};

use crate::state::AppState;

/// A failure inside a handler. The text goes to the log, and the route answers
/// with its own message.
#[derive(Debug)]
pub struct Fault(pub String);

impl<E: std::fmt::Display> From<E> for Fault {
    fn from(error: E) -> Self {
        Fault(error.to_string())
    }
}

pub type Outcome = Result<Response, Fault>;

pub fn reply(status: u16, body: Value) -> Response {
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, Json(body)).into_response()
}

/// `{ error: message }` with the given status.
pub fn error(status: u16, message: &str) -> Response {
    reply(status, json!({ "error": message }))
}

/// A 500 that carries the route's message. The cause is logged, not sent.
pub fn internal(message: &str, fault: Fault) -> Response {
    tracing::error!(error = %fault.0, "{message}");
    error(500, message)
}

/// `parseJsonBody`: a body that is not JSON reads as `null`, which the schema rejects.
pub fn body_or_null(bytes: &Bytes) -> Value {
    serde_json::from_slice(bytes).unwrap_or(Value::Null)
}

/// `await request.json()` without a catch of its own: invalid JSON is an error.
pub fn body_strict(bytes: &Bytes) -> Result<Value, Fault> {
    Ok(serde_json::from_slice(bytes)?)
}

/// Sends a `notify` event to every connected client, as `broadcast({ type, payload })`.
pub fn notify(state: &AppState, event: &str, payload: Value) {
    broadcast(&state.registry, event, Some(payload));
}

/// One schema violation: the field (empty for the body itself) and the message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub path: String,
    pub message: String,
}

impl From<betaclaw_core::tasks::validation::ValidationIssue> for Issue {
    fn from(issue: betaclaw_core::tasks::validation::ValidationIssue) -> Self {
        Issue {
            path: issue.field.to_string(),
            message: issue.message,
        }
    }
}

/// `parseJsonBody`'s failure response: `{ error: 'Validation failed', details }`.
pub fn validation_failed(issues: &[Issue]) -> Response {
    let details: Vec<Value> = issues
        .iter()
        .map(|issue| {
            let path = if issue.path.is_empty() {
                json!([])
            } else {
                json!([issue.path])
            };
            json!({
                "expected": "string",
                "code": "invalid_type",
                "path": path,
                "message": issue.message,
            })
        })
        .collect();
    reply(
        400,
        json!({ "error": "Validation failed", "details": details }),
    )
}

/// The rule of one text field: `z.string()` with the modifiers the schema uses.
#[derive(Debug, Clone, Copy)]
pub struct TextRule {
    required: bool,
    nullable: bool,
    trim: bool,
    min: usize,
    max: usize,
}

impl TextRule {
    /// `z.string()`: the key must be present.
    pub const fn required() -> Self {
        Self {
            required: true,
            nullable: false,
            trim: false,
            min: 0,
            max: usize::MAX,
        }
    }

    /// `z.string().optional()`.
    pub const fn optional() -> Self {
        Self {
            required: false,
            ..Self::required()
        }
    }

    pub const fn nullable(self) -> Self {
        Self {
            nullable: true,
            ..self
        }
    }

    pub const fn trimmed(self) -> Self {
        Self { trim: true, ..self }
    }

    pub const fn length(self, min: usize, max: usize) -> Self {
        Self { min, max, ..self }
    }
}

/// A field after the schema has been applied. `Null` is an explicit `null`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Field<T> {
    Absent,
    Null,
    Value(T),
}

impl<T> Field<T> {
    pub fn into_option(self) -> Option<T> {
        match self {
            Field::Value(value) => Some(value),
            Field::Absent | Field::Null => None,
        }
    }
}

/// Reads the fields of one body and collects the issues.
#[derive(Default)]
pub struct Fields {
    issues: Vec<Issue>,
}

impl Fields {
    fn push(&mut self, path: &str, message: impl Into<String>) {
        self.issues.push(Issue {
            path: path.to_string(),
            message: message.into(),
        });
    }

    /// The body must be an object. Anything else is one issue at the root.
    pub fn object<'a>(&mut self, body: &'a Value) -> Option<&'a Map<String, Value>> {
        let map = body.as_object();
        if map.is_none() {
            self.push("", "Invalid input: expected object");
        }
        map
    }

    pub fn text(&mut self, map: &Map<String, Value>, key: &str, rule: TextRule) -> Field<String> {
        match map.get(key) {
            None => {
                if rule.required {
                    self.push(key, "Invalid input: expected string, received undefined");
                }
                Field::Absent
            }
            Some(Value::Null) => {
                if rule.nullable {
                    Field::Null
                } else {
                    self.push(key, "Invalid input: expected string, received null");
                    Field::Absent
                }
            }
            Some(Value::String(raw)) => {
                let text = if rule.trim { raw.trim() } else { raw.as_str() };
                let length = utf16_len(text);
                if length < rule.min {
                    self.push(
                        key,
                        format!(
                            "Too small: expected string to have >={} characters",
                            rule.min
                        ),
                    );
                    Field::Absent
                } else if length > rule.max {
                    self.push(
                        key,
                        format!("Too big: expected string to have <={} characters", rule.max),
                    );
                    Field::Absent
                } else {
                    Field::Value(text.to_string())
                }
            }
            Some(other) => {
                self.push(
                    key,
                    format!(
                        "Invalid input: expected string, received {}",
                        json_type(other)
                    ),
                );
                Field::Absent
            }
        }
    }

    /// `z.enum([...])`.
    pub fn one_of(
        &mut self,
        map: &Map<String, Value>,
        key: &str,
        options: &[&str],
        rule: TextRule,
    ) -> Field<String> {
        match self.text(map, key, rule) {
            Field::Value(value) if options.contains(&value.as_str()) => Field::Value(value),
            Field::Value(_) => {
                let quoted: Vec<String> = options.iter().map(|o| format!("\"{o}\"")).collect();
                self.push(
                    key,
                    format!("Invalid option: expected one of {}", quoted.join("|")),
                );
                Field::Absent
            }
            other => other,
        }
    }

    /// `z.boolean()`.
    pub fn boolean(&mut self, map: &Map<String, Value>, key: &str) -> Field<bool> {
        match map.get(key) {
            None => Field::Absent,
            Some(Value::Bool(flag)) => Field::Value(*flag),
            Some(other) => {
                self.push(
                    key,
                    format!(
                        "Invalid input: expected boolean, received {}",
                        json_type(other)
                    ),
                );
                Field::Absent
            }
        }
    }

    /// `z.string().uuid()`, optionally nullable.
    pub fn uuid(&mut self, map: &Map<String, Value>, key: &str, nullable: bool) -> Field<String> {
        let rule = if nullable {
            TextRule::optional().nullable()
        } else {
            TextRule::optional()
        };
        match self.text(map, key, rule) {
            Field::Value(value) if is_uuid(&value) => Field::Value(value),
            Field::Value(_) => {
                self.push(key, "Invalid UUID");
                Field::Absent
            }
            other => other,
        }
    }

    pub fn into_issues(self) -> Vec<Issue> {
        self.issues
    }

    /// The decoded value when no field was rejected, otherwise the issues.
    pub fn finish<T>(self, value: T) -> Result<T, Vec<Issue>> {
        if self.issues.is_empty() {
            Ok(value)
        } else {
            Err(self.issues)
        }
    }
}

fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// `String.length`: UTF-16 code units.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// JavaScript truthiness of an optional JSON value.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `value[key]` as a non-empty string.
pub fn text_key<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str().filter(|text| !text.is_empty())
}

/// `String(value)` for the scalars a request can carry.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        Value::Array(_) | Value::Object(_) => "[object Object]".to_string(),
    }
}

/// Runs `sql` and returns each row as an object keyed by column name, as `SELECT *`
/// through better-sqlite3 does. A duplicate column name keeps its last value.
pub fn query_rows<P: Params>(
    connection: &Connection,
    sql: &str,
    params: P,
) -> rusqlite::Result<Vec<Value>> {
    let mut statement = connection.prepare(sql)?;
    let names: Vec<String> = statement.column_names().map(str::to_string).collect();
    let rows = statement.query_map(params, |row| row_object(row, &names))?;
    rows.collect()
}

/// The first row of `query_rows`, if any.
pub fn query_first<P: Params>(
    connection: &Connection,
    sql: &str,
    params: P,
) -> rusqlite::Result<Option<Value>> {
    Ok(query_rows(connection, sql, params)?.into_iter().next())
}

fn row_object(row: &Row<'_>, names: &[String]) -> rusqlite::Result<Value> {
    let mut object = Map::new();
    for (index, name) in names.iter().enumerate() {
        object.insert(name.clone(), value_json(row.get_ref(index)?));
    }
    Ok(Value::Object(object))
}

fn value_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null | ValueRef::Blob(_) => Value::Null,
        ValueRef::Integer(number) => Value::from(number),
        ValueRef::Real(number) => Number::from_f64(number).map_or(Value::Null, Value::Number),
        ValueRef::Text(bytes) => Value::String(String::from_utf8_lossy(bytes).into_owned()),
    }
}

/// `crypto.randomUUID()`.
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// `new Date().toISOString()`: UTC with milliseconds.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_length_counts_code_units() {
        assert_eq!(utf16_len("ab"), 2);
        assert_eq!(utf16_len("😀"), 2);
    }

    #[test]
    fn javascript_truthiness_matches_the_source_checks() {
        assert!(!truthy(None));
        assert!(!truthy(Some(&json!(""))));
        assert!(!truthy(Some(&json!(0))));
        assert!(truthy(Some(&json!("x"))));
        assert!(truthy(Some(&json!([]))));
    }

    #[test]
    fn text_rule_reports_length_and_type() {
        let mut fields = Fields::default();
        let map = json!({ "name": "   ", "count": 3 });
        let map = map.as_object().unwrap();
        let name = fields.text(map, "name", TextRule::required().trimmed().length(1, 5));
        assert_eq!(name, Field::Absent);
        let count = fields.text(map, "count", TextRule::optional());
        assert_eq!(count, Field::Absent);
        assert_eq!(fields.into_issues().len(), 2);
    }

    #[test]
    fn query_rows_maps_columns_to_json() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE t (id TEXT, n INTEGER, r REAL, z TEXT); INSERT INTO t VALUES ('a', 2, 1.5, NULL);")
            .unwrap();
        let rows = query_rows(&connection, "SELECT * FROM t", []).unwrap();
        assert_eq!(
            rows,
            vec![json!({ "id": "a", "n": 2, "r": 1.5, "z": null })]
        );
    }
}
