//! Port of `src/server/world-model/services/standingIntentCompiler.ts:1-118` —
//! the deterministic rule-based compiler for `Wenn … dann …` statements.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `standingIntentCompiler.ts:13-17` (`CompiledStandingIntent`) | [`CompiledStandingIntent`] |
//! | `standingIntentCompiler.ts:19-22` (`TRIGGER_CONSOLIDATED`) | [`TRIGGER_CONSOLIDATED`] |
//! | `standingIntentCompiler.ts:24` (`COMPILER_ENABLED`) | [`COMPILER_ENABLED`] |
//! | `standingIntentCompiler.ts:26-63` (`compileStandingIntent`) | [`compile_standing_intent`] |
//! | `standingIntentCompiler.ts:65-79` (`nullableIntent`) | [`nullable_intent`] |
//! | `standingIntentCompiler.ts:81-83` (`isStandingIntentCompilerAvailable`) | [`is_standing_intent_compiler_available`] |
//! | `standingIntentCompiler.ts:93-118` (`processIncomingStandingIntents`) | [`process_incoming_standing_intents`] |
//!
//! # Deviations
//!
//! 1. **The config is a parameter.** `:82` and `:99` read
//!    `getWorldModelConfig()`; the port takes `&WorldModelConfig`, so a test does
//!    not depend on the process environment.
//! 2. **`processIncomingStandingIntents` keeps the source's swallow.** `:114-117`
//!    logs the persistence error and answers `null`; the port answers `None` for
//!    the same three cases (disabled, no template, persistence failure) and
//!    documents the third one here, because the ported module has no logger. The
//!    SQL error itself is dropped exactly like `console.error` drops it.
//! 3. **The regex is compiled once.** `:35` builds the literal per call; the port
//!    holds one [`regex::Regex`] for the process. JavaScript `.`/`\s` operate on
//!    UTF-16 code units, Rust on `char`s; for a statement of the Basic
//!    Multilingual Plane the match set is the same.
//! 4. **`Object.entries` order is preserved.** `:42-44` takes the *first*
//!    consolidated trigger list whose key is a substring of the subject, so
//!    [`TRIGGER_CONSOLIDATED`] is an ordered slice, not a map.

use std::sync::LazyLock;

use regex::Regex;

use crate::world_model::config::WorldModelConfig;
use crate::world_model::db::{PgError, PgExecutor};
use crate::world_model::repositories::prospective_repository::insert_standing_intent;
use crate::world_model::scope::WorldModelScope;
use crate::world_model::types::{StandingIntentInput, StandingIntentRecord};

/// `standingIntentCompiler.ts:24`.
pub const COMPILER_ENABLED: bool = true;

/// `TRIGGER_CONSOLIDATED` from `standingIntentCompiler.ts:19-22`, in the
/// property order of the source object literal.
pub const TRIGGER_CONSOLIDATED: &[(&str, &[&str])] = &[
    ("mike", &["mike", "mike antwortet"]),
    ("christina", &["christina"]),
];

/// `standingIntentCompiler.ts:35`.
static IF_WHEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"wenn\s+(.+?)\s+(antwortet|wieder da ist|zurück ist|melde)").unwrap()
});

/// `CompiledStandingIntent` from `standingIntentCompiler.ts:13-17`.
#[derive(Debug, Clone, PartialEq)]
pub struct CompiledStandingIntent {
    pub input: StandingIntentInput,
    /// `'if_when_subject' | 'always_trigger' | 'none'`.
    pub matched_template: &'static str,
    pub confidence: f64,
}

/// The `{ userId, personaId, workspaceId?, statement }` argument of `:26-31`.
#[derive(Debug, Clone, PartialEq)]
pub struct CompileStandingIntentInput {
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: Option<String>,
    pub statement: String,
}

/// `compileStandingIntent(input)` — `standingIntentCompiler.ts:26-63`.
pub fn compile_standing_intent(input: &CompileStandingIntentInput) -> CompiledStandingIntent {
    let text = input.statement.to_lowercase();

    if let Some(captures) = IF_WHEN.captures(&text) {
        let subject = captures
            .get(1)
            .map(|group| group.as_str().trim().to_string())
            .unwrap_or_default();
        let trigger_terms = TRIGGER_CONSOLIDATED
            .iter()
            .find(|(key, _)| subject.contains(*key))
            .map(|(_, terms)| terms.iter().map(|term| term.to_string()).collect())
            .unwrap_or_else(|| vec![subject]);
        return CompiledStandingIntent {
            matched_template: "if_when_subject",
            confidence: 0.8,
            input: StandingIntentInput {
                user_id: input.user_id.clone(),
                persona_id: input.persona_id.clone(),
                workspace_id: Some(input.workspace_id.clone().unwrap_or_default()),
                description: input.statement.clone(),
                trigger_terms,
                event_type: None,
                subject_scope: None,
                channel_scope: None,
                sender_scope: None,
                expires_at: None,
                cooldown_ms: Some(0),
                max_fires: Some(1),
                deduplication_key: compiled_deduplication_key(&input.statement),
            },
        };
    }

    CompiledStandingIntent {
        matched_template: "none",
        confidence: 0.0,
        input: nullable_intent(input),
    }
}

/// `nullableIntent(input)` — `standingIntentCompiler.ts:65-79`.
fn nullable_intent(input: &CompileStandingIntentInput) -> StandingIntentInput {
    StandingIntentInput {
        user_id: input.user_id.clone(),
        persona_id: input.persona_id.clone(),
        workspace_id: Some(input.workspace_id.clone().unwrap_or_default()),
        description: input.statement.clone(),
        trigger_terms: Vec::new(),
        event_type: None,
        subject_scope: None,
        channel_scope: None,
        sender_scope: None,
        expires_at: None,
        cooldown_ms: None,
        max_fires: None,
        deduplication_key: compiled_deduplication_key(&input.statement),
    }
}

/// `` `compiled:${statement.trim().toLowerCase()}` `` — `:55` and `:77`.
fn compiled_deduplication_key(statement: &str) -> String {
    format!("compiled:{}", statement.trim().to_lowercase())
}

/// `isStandingIntentCompilerAvailable()` — `standingIntentCompiler.ts:81-83`.
pub fn is_standing_intent_compiler_available(config: &WorldModelConfig) -> bool {
    COMPILER_ENABLED && config.enabled
}

/// `processIncomingStandingIntents(input)` — `standingIntentCompiler.ts:93-118`.
pub async fn process_incoming_standing_intents(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    config: &WorldModelConfig,
    input: &CompileStandingIntentInput,
) -> Option<Vec<StandingIntentRecord>> {
    if !config.enabled && !config.e2e_enabled {
        return None;
    }
    if !COMPILER_ENABLED {
        return None;
    }

    let compiled = compile_standing_intent(input);
    if compiled.matched_template == "none" {
        return None;
    }

    match insert_standing_intent::<PgError>(executor, scope, &compiled.input).await {
        Ok(record) => Some(vec![record]),
        Err(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::RecordingExecutor;
    use crate::world_model::db::{drive_sync, PgQueryResult, PgRow};
    use serde_json::json;

    fn row(value: serde_json::Value) -> PgRow {
        value.as_object().expect("row").clone()
    }

    fn intent_row() -> PgQueryResult {
        PgQueryResult::from_rows(vec![row(json!({
            "id": "si1", "user_id": "u1", "persona_id": "p1", "workspace_id": "",
            "description": "Wenn Mike antwortet, erinnere mich an das Angebot",
            "trigger_terms": ["mike", "mike antwortet"], "event_type": null,
            "subject_scope": null, "channel_scope": null, "sender_scope": null,
            "status": "armed", "expires_at": null, "cooldown_until": null,
            "cooldown_ms": 0, "fire_count": 0, "max_fires": 1, "last_fired_at": null,
            "deduplication_key": "compiled:wenn mike antwortet, erinnere mich an das angebot",
            "note": null, "created_at": "2026-10-10T10:00:00.000Z",
            "updated_at": "2026-10-10T10:00:00.000Z"
        }))])
    }

    fn input(statement: &str) -> CompileStandingIntentInput {
        CompileStandingIntentInput {
            user_id: "u1".to_string(),
            persona_id: "p1".to_string(),
            workspace_id: None,
            statement: statement.to_string(),
        }
    }

    #[test]
    fn a_known_subject_takes_the_consolidated_trigger_list() {
        let compiled =
            compile_standing_intent(&input("Wenn Mike antwortet, erinnere mich an das Angebot"));
        assert_eq!(compiled.matched_template, "if_when_subject");
        assert_eq!(compiled.confidence, 0.8);
        assert_eq!(
            compiled.input.trigger_terms,
            vec!["mike".to_string(), "mike antwortet".to_string()]
        );
        assert_eq!(compiled.input.max_fires, Some(1));
        assert_eq!(compiled.input.cooldown_ms, Some(0));
        assert_eq!(compiled.input.workspace_id.as_deref(), Some(""));
        assert_eq!(
            compiled.input.deduplication_key,
            "compiled:wenn mike antwortet, erinnere mich an das angebot"
        );
    }

    #[test]
    fn an_unknown_subject_keeps_the_subject_itself() {
        let compiled = compile_standing_intent(&input("Wenn Anna melde, sag mir Bescheid"));
        assert_eq!(compiled.matched_template, "if_when_subject");
        assert_eq!(compiled.input.trigger_terms, vec!["anna".to_string()]);
    }

    #[test]
    fn a_statement_without_the_template_is_not_matched() {
        let compiled = compile_standing_intent(&input("Erinnere mich an das Angebot"));
        assert_eq!(compiled.matched_template, "none");
        assert_eq!(compiled.confidence, 0.0);
        assert!(compiled.input.trigger_terms.is_empty());
        assert_eq!(compiled.input.max_fires, None);
        assert_eq!(compiled.input.cooldown_ms, None);
    }

    #[test]
    fn the_compiler_flag_follows_the_world_model_switch() {
        assert!(is_standing_intent_compiler_available(&WorldModelConfig {
            enabled: true,
            ..Default::default()
        }));
        assert!(!is_standing_intent_compiler_available(
            &WorldModelConfig::default()
        ));
    }

    #[test]
    fn a_matched_statement_is_persisted_once_and_a_disabled_model_answers_none() {
        let executor = RecordingExecutor::new(vec![Ok(intent_row())]);
        let stored = drive_sync(process_incoming_standing_intents(
            &executor,
            None,
            &WorldModelConfig {
                enabled: true,
                ..Default::default()
            },
            &input("Wenn Mike antwortet, erinnere mich an das Angebot"),
        ))
        .expect("bridge");
        let stored = stored.expect("one record");
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].id, "si1");
        assert!(executor.calls()[0]
            .sql()
            .starts_with("INSERT INTO world_model_standing_intents"));
        // The shared column list of the repository is projected back.
        assert!(executor.calls()[0].sql().contains("trigger_terms"));
        assert!(executor.calls()[0]
            .sql()
            .contains("ON CONFLICT (user_id, persona_id, workspace_id, deduplication_key)"));

        let disabled = RecordingExecutor::new(vec![Ok(intent_row())]);
        let none = drive_sync(process_incoming_standing_intents(
            &disabled,
            None,
            &WorldModelConfig::default(),
            &input("Wenn Mike antwortet, erinnere mich an das Angebot"),
        ))
        .expect("bridge");
        assert!(none.is_none());
        assert!(disabled.calls().is_empty());
    }
}
