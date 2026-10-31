//! Port of `src/server/master/capabilities/understandingLoop.ts:1-119`.
//!
//! The daily capability-understanding cycle: at 03:00 UTC it walks every
//! capability score and bumps its confidence, either by a fixed heuristic or, if
//! the AI runtime is on, by a model-recommended delta.
//!
//! # The runtime persona and the model hub are seams
//!
//! `understandingLoop.ts:3,42-73` reaches for two process-wide singletons:
//! `getMasterRuntimePersonaConfig` (which needs a `PersonaRepository`) and
//! `getModelHubService().dispatchWithFallback(...)`. The cycle is reached through
//! [`CapabilityUnderstandingCycle`], whose signature carries only the master
//! repository, the scope and the instant, so neither dependency can travel as an
//! argument. They are therefore held by [`UnderstandingLoop`]:
//!
//! * the model dispatch is the OP-S9-8 [`MasterModelDispatch`] entry, stored as
//!   `Arc<dyn MasterModelDispatch + Send + Sync>` so the loop stays `Send + Sync`
//!   as [`CapabilityUnderstandingCycle`] requires;
//! * the persona resolution is the [`CapabilityRuntimePersona`] seam (OP-S9-16),
//!   because the concrete `getMasterRuntimePersonaConfig` needs a
//!   `PersonaRepository` this module deliberately does not depend on.
//!
//! # JavaScript number coercion is explicit
//!
//! `Number(parsed?.delta)` is reproduced by [`js_number`], including the cases
//! that surprise: `null` and `""` are `0`, an absent key is `NaN`, and
//! `evidenceCount` is filtered by `Number.isFinite` — so only a finite,
//! non-negative value is kept.

use std::sync::Arc;

use chrono::{DateTime, Local, SecondsFormat, Timelike, Utc};
use serde_json::Value;

use crate::master::execution::runtime::execution_plan::{
    MasterModelDispatch, MasterModelMessage, MasterModelRequest,
};
use crate::master::feature_flags::MasterEnv;
use crate::master::learning::{CapabilityUnderstandingCycle, CapabilityUnderstandingCycleOutcome};
use crate::master::repository::MasterRepository;
use crate::master::runtime_persona::MasterRuntimePersonaConfig;
use crate::master::types::WorkspaceScope;

/// Seam for `getMasterRuntimePersonaConfig(input.scope)` (OP-S9-16).
///
/// The concrete implementation wraps `runtimePersona.ts` together with the
/// process-wide `PersonaRepository`; the gateway owns the wiring.
pub trait CapabilityRuntimePersona: Send + Sync {
    fn runtime_persona_config(
        &self,
        scope: &WorkspaceScope,
    ) -> Result<MasterRuntimePersonaConfig, String>;
}

/// `{ delta, evidenceCount }` — the return of `parseAiDelta`
/// (`understandingLoop.ts:22`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AiConfidenceAdjustment {
    pub delta: Option<f64>,
    pub evidence_count: Option<f64>,
}

impl AiConfidenceAdjustment {
    /// `{ delta: null, evidenceCount: null }`.
    pub const NONE: AiConfidenceAdjustment = AiConfidenceAdjustment {
        delta: None,
        evidence_count: None,
    };
}

/// `shouldRunLearningCycleAt` — `understandingLoop.ts:6-8`.
///
/// `date.getUTCHours() === 3 && date.getUTCMinutes() === 0`.
pub fn should_run_learning_cycle_at(date: DateTime<Utc>) -> bool {
    date.hour() == 3 && date.minute() == 0
}

/// `parseJsonObject` — `understandingLoop.ts:10-20`.
///
/// Only a JSON object qualifies; an array, a scalar or a parse failure is `None`.
fn parse_json_object(payload: &str) -> Option<Value> {
    match serde_json::from_str::<Value>(payload) {
        Ok(value @ Value::Object(_)) => Some(value),
        _ => None,
    }
}

/// `Number(value)` for an optional JSON value.
///
/// * absent → `NaN`, `null` → `0`, `true`/`false` → `1`/`0`;
/// * a string is coerced like JavaScript's `Number(string)`, so `""` is `0` and
///   a non-numeric string is `NaN`;
/// * an array or object is `NaN` (the source only ever feeds scalars here).
fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => js_string_to_number(text),
        Some(_) => f64::NAN,
    }
}

/// `Number(string)`.
fn js_string_to_number(input: &str) -> f64 {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        "NaN" => return f64::NAN,
        _ => {}
    }

    let (sign, unsigned) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let lower = unsigned.to_ascii_lowercase();
    let radix = lower
        .strip_prefix("0x")
        .map(|digits| (16, digits))
        .or_else(|| lower.strip_prefix("0b").map(|digits| (2, digits)))
        .or_else(|| lower.strip_prefix("0o").map(|digits| (8, digits)));
    if let Some((radix, digits)) = radix {
        return match u64::from_str_radix(digits, radix) {
            Ok(parsed) => sign * parsed as f64,
            Err(_) => f64::NAN,
        };
    }

    let numeric = trimmed
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | 'e' | 'E'))
        && trimmed.chars().any(|c| c.is_ascii_digit());
    if !numeric {
        return f64::NAN;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

/// `parseAiDelta` — `understandingLoop.ts:22-30`.
pub fn parse_ai_delta(payload: &str) -> AiConfidenceAdjustment {
    let parsed = parse_json_object(payload);
    let delta_raw = js_number(parsed.as_ref().and_then(|object| object.get("delta")));
    let evidence_raw = js_number(
        parsed
            .as_ref()
            .and_then(|object| object.get("evidenceCount")),
    );
    let delta = if delta_raw.is_finite() && (-0.05..=0.05).contains(&delta_raw) {
        Some(delta_raw)
    } else {
        None
    };
    let evidence_count = if evidence_raw.is_finite() && evidence_raw >= 0.0 {
        Some(evidence_raw)
    } else {
        None
    };
    AiConfidenceAdjustment {
        delta,
        evidence_count,
    }
}

/// `JSON.stringify` of the rewritten `benchmarkSummary`
/// (`understandingLoop.ts:103-108`).
///
/// The key order is the source's object-literal order, and `evidenceCount` uses
/// the JavaScript number spelling (`3`, not `3.0`).
fn benchmark_summary_json(ai: &AiConfidenceAdjustment, previous: &str) -> String {
    let (source, version) = if ai.delta.is_none() {
        ("heuristic", "v1")
    } else {
        ("ai", "v2")
    };
    let evidence_count = ai.evidence_count.unwrap_or(0.0);
    let previous_json = serde_json::to_string(previous).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "{{\"source\":\"{source}\",\"version\":\"{version}\",\"evidenceCount\":{},\"previous\":{previous_json}}}",
        js_number_to_string(evidence_count)
    )
}

/// `String(number)` for a finite, non-negative value — `3` stays `3`.
fn js_number_to_string(value: f64) -> String {
    format!("{value}")
}

/// `computeAiConfidenceAdjustment` — `understandingLoop.ts:32-81`.
///
/// Off unless `MASTER_AI_RUNTIME_V2` trims to `1`; every failure (persona
/// resolution, dispatch error, `response.ok === false`) yields
/// [`AiConfidenceAdjustment::NONE`], exactly like the bare `catch`.
fn compute_ai_confidence_adjustment(
    persona: &dyn CapabilityRuntimePersona,
    env: &MasterEnv,
    model: &(dyn MasterModelDispatch + Send + Sync),
    capability: &str,
    confidence: f64,
    benchmark_summary: &str,
    scope: &WorkspaceScope,
) -> AiConfidenceAdjustment {
    if env
        .get("MASTER_AI_RUNTIME_V2")
        .map(String::as_str)
        .unwrap_or("")
        .trim()
        != "1"
    {
        return AiConfidenceAdjustment::NONE;
    }

    let Ok(runtime_persona) = persona.runtime_persona_config(scope) else {
        return AiConfidenceAdjustment::NONE;
    };

    let mut parts: Vec<String> = Vec::new();
    if let Some(instruction) = &runtime_persona.system_instruction {
        if !instruction.is_empty() {
            parts.push(instruction.clone());
        }
    }
    parts.push("You evaluate capability confidence updates.".to_string());
    parts.push("Return JSON only with keys:".to_string());
    parts.push("- delta: number between -0.05 and 0.05".to_string());
    parts.push("- evidenceCount: integer >= 0".to_string());

    let request = MasterModelRequest {
        messages: vec![
            MasterModelMessage {
                role: "system".to_string(),
                content: parts.join("\n\n"),
            },
            MasterModelMessage {
                role: "user".to_string(),
                content: format!(
                    "capability={capability}\nconfidence={confidence}\nbenchmarkSummary={benchmark_summary}"
                ),
            },
        ],
        temperature: 0.1,
        max_tokens: 120,
        audit_context: serde_json::json!({ "kind": "worker_planner" }),
    };

    let Ok(response) =
        model.dispatch_with_fallback(&runtime_persona.model_hub_profile_id, &request)
    else {
        return AiConfidenceAdjustment::NONE;
    };
    if !response.ok {
        return AiConfidenceAdjustment::NONE;
    }
    parse_ai_delta(&response.text)
}

/// `runCapabilityUnderstandingCycle` — `understandingLoop.ts:83-119`.
///
/// Outside the 03:00 UTC window it reports `{ updated: 0, executed: false }`
/// without touching the repository; inside it every score is bumped by the
/// model delta (or `0.01`), clamped to `[0, 1]`, and rewritten with the new
/// benchmark summary and `lastVerifiedAt = now.toISOString()`.
pub fn run_capability_understanding_cycle(
    persona: &dyn CapabilityRuntimePersona,
    env: &MasterEnv,
    model: &(dyn MasterModelDispatch + Send + Sync),
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
    now: DateTime<Local>,
) -> rusqlite::Result<CapabilityUnderstandingCycleOutcome> {
    if !should_run_learning_cycle_at(now.with_timezone(&Utc)) {
        return Ok(CapabilityUnderstandingCycleOutcome {
            updated: 0,
            executed: false,
        });
    }
    let scores = repo.list_capability_scores(scope)?;
    let mut updated = 0usize;
    for score in scores {
        let ai = compute_ai_confidence_adjustment(
            persona,
            env,
            model,
            &score.capability,
            score.confidence,
            &score.benchmark_summary,
            scope,
        );
        let delta = ai.delta.unwrap_or(0.01);
        let boosted = (score.confidence + delta).clamp(0.0, 1.0);
        let benchmark_summary = benchmark_summary_json(&ai, &score.benchmark_summary);
        let verified_at = now
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        repo.upsert_capability_score(
            scope,
            &score.capability,
            boosted,
            &benchmark_summary,
            Some(&verified_at),
        )?;
        updated += 1;
    }
    Ok(CapabilityUnderstandingCycleOutcome {
        updated,
        executed: true,
    })
}

/// The concrete [`CapabilityUnderstandingCycle`] (OP-S9-16).
///
/// Holds the two seams and the environment snapshot the source read globally.
pub struct UnderstandingLoop {
    persona: Arc<dyn CapabilityRuntimePersona>,
    env: MasterEnv,
    model: Arc<dyn MasterModelDispatch + Send + Sync>,
}

impl UnderstandingLoop {
    pub fn new(
        persona: Arc<dyn CapabilityRuntimePersona>,
        env: MasterEnv,
        model: Arc<dyn MasterModelDispatch + Send + Sync>,
    ) -> Self {
        Self {
            persona,
            env,
            model,
        }
    }
}

impl CapabilityUnderstandingCycle for UnderstandingLoop {
    fn should_run_learning_cycle_at(&self, date: DateTime<Utc>) -> bool {
        should_run_learning_cycle_at(date)
    }

    fn run_capability_understanding_cycle(
        &self,
        repo: &dyn MasterRepository,
        scope: &WorkspaceScope,
        now: DateTime<Local>,
    ) -> rusqlite::Result<CapabilityUnderstandingCycleOutcome> {
        run_capability_understanding_cycle(
            self.persona.as_ref(),
            &self.env,
            self.model.as_ref(),
            repo,
            scope,
            now,
        )
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use chrono::TimeZone;

    use super::*;
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    /// A deterministic persona resolver.
    struct StubPersona {
        instruction: Option<String>,
        fail: bool,
    }

    impl CapabilityRuntimePersona for StubPersona {
        fn runtime_persona_config(
            &self,
            _scope: &WorkspaceScope,
        ) -> Result<MasterRuntimePersonaConfig, String> {
            if self.fail {
                return Err("no persona".to_string());
            }
            Ok(MasterRuntimePersonaConfig {
                persona_id: "p".to_string(),
                model_hub_profile_id: "p1".to_string(),
                preferred_model_id: None,
                system_instruction: self.instruction.clone(),
                allowed_tool_function_names: Vec::new(),
            })
        }
    }

    /// Records the requests and answers with scripted text.
    struct StubModel {
        text: String,
        ok: bool,
        calls: Mutex<Vec<MasterModelRequest>>,
    }

    impl StubModel {
        fn new(text: &str, ok: bool) -> Arc<Self> {
            Arc::new(Self {
                text: text.to_string(),
                ok,
                calls: Mutex::new(Vec::new()),
            })
        }
    }

    impl MasterModelDispatch for StubModel {
        fn dispatch_with_fallback(
            &self,
            _profile_id: &str,
            request: &MasterModelRequest,
        ) -> Result<crate::master::execution::runtime::execution_plan::MasterModelResponse, String>
        {
            self.calls.lock().unwrap().push(request.clone());
            Ok(
                crate::master::execution::runtime::execution_plan::MasterModelResponse {
                    ok: self.ok,
                    error: None,
                    text: self.text.clone(),
                },
            )
        }
    }

    fn enabled_env() -> MasterEnv {
        let mut env = MasterEnv::new();
        env.insert("MASTER_AI_RUNTIME_V2".to_string(), "1".to_string());
        env
    }

    fn three_am_local() -> DateTime<Local> {
        Utc.with_ymd_and_hms(2026, 3, 4, 3, 0, 0)
            .single()
            .expect("unambiguous utc instant")
            .with_timezone(&Local)
    }

    fn seed_score(repo: &SqliteMasterRepository, summary: &str, confidence: f64) {
        repo.upsert_capability_score(&scope(), "notes", confidence, summary, None)
            .unwrap();
    }

    #[test]
    fn the_window_is_three_am_utc() {
        assert!(should_run_learning_cycle_at(
            Utc.with_ymd_and_hms(2026, 3, 4, 3, 0, 0).unwrap()
        ));
        assert!(!should_run_learning_cycle_at(
            Utc.with_ymd_and_hms(2026, 3, 4, 3, 1, 0).unwrap()
        ));
        assert!(!should_run_learning_cycle_at(
            Utc.with_ymd_and_hms(2026, 3, 4, 4, 0, 0).unwrap()
        ));
    }

    #[test]
    fn parse_ai_delta_reads_the_bounded_delta_and_evidence() {
        let parsed = parse_ai_delta("{\"delta\":0.05,\"evidenceCount\":7}");
        assert_eq!(parsed.delta, Some(0.05));
        assert_eq!(parsed.evidence_count, Some(7.0));
    }

    #[test]
    fn parse_ai_delta_rejects_out_of_range_and_non_numeric() {
        assert_eq!(parse_ai_delta("{\"delta\":0.2}").delta, None);
        assert_eq!(parse_ai_delta("{\"delta\":-0.06}").delta, None);
        assert_eq!(parse_ai_delta("not json").delta, None);
        assert_eq!(parse_ai_delta("[1]").delta, None);
        // `Number(null)` and `Number("")` are both `0`, inside the range.
        assert_eq!(parse_ai_delta("{\"delta\":null}").delta, Some(0.0));
        assert_eq!(parse_ai_delta("{\"delta\":\"\"}").delta, Some(0.0));
        assert_eq!(
            parse_ai_delta("{\"evidenceCount\":-1}").evidence_count,
            None
        );
    }

    #[test]
    fn outside_the_window_nothing_is_written() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        seed_score(&repo, "seed", 0.5);
        let persona = StubPersona {
            instruction: None,
            fail: false,
        };
        let model = StubModel::new("{}", true);
        let now = Utc
            .with_ymd_and_hms(2026, 3, 4, 4, 0, 0)
            .unwrap()
            .with_timezone(&Local);
        let outcome = run_capability_understanding_cycle(
            &persona,
            &MasterEnv::new(),
            model.as_ref(),
            &repo,
            &scope(),
            now,
        )
        .unwrap();
        assert!(!outcome.executed);
        assert_eq!(outcome.updated, 0);
        let scores = repo.list_capability_scores(&scope()).unwrap();
        assert_eq!(scores[0].confidence, 0.5);
        assert_eq!(scores[0].benchmark_summary, "seed");
    }

    #[test]
    fn the_heuristic_bump_rewrites_the_summary() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        seed_score(&repo, "seed", 0.5);
        let persona = StubPersona {
            instruction: None,
            fail: false,
        };
        let model = StubModel::new("{}", true);
        let outcome = run_capability_understanding_cycle(
            &persona,
            &MasterEnv::new(),
            model.as_ref(),
            &repo,
            &scope(),
            three_am_local(),
        )
        .unwrap();
        assert!(outcome.executed);
        assert_eq!(outcome.updated, 1);
        let scores = repo.list_capability_scores(&scope()).unwrap();
        assert!((scores[0].confidence - 0.51).abs() < 1e-12);
        assert_eq!(
            scores[0].benchmark_summary,
            "{\"source\":\"heuristic\",\"version\":\"v1\",\"evidenceCount\":0,\"previous\":\"seed\"}"
        );
        assert_eq!(
            scores[0].last_verified_at.as_deref(),
            Some("2026-03-04T03:00:00.000Z")
        );
    }

    #[test]
    fn the_ai_bump_uses_the_scripted_delta() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        seed_score(&repo, "seed", 0.5);
        let persona = StubPersona {
            instruction: Some("persona".to_string()),
            fail: false,
        };
        let model = StubModel::new("{\"delta\":0.05,\"evidenceCount\":7}", true);
        let outcome = run_capability_understanding_cycle(
            &persona,
            &enabled_env(),
            model.as_ref(),
            &repo,
            &scope(),
            three_am_local(),
        )
        .unwrap();
        assert_eq!(outcome.updated, 1);
        let scores = repo.list_capability_scores(&scope()).unwrap();
        assert!((scores[0].confidence - 0.55).abs() < 1e-12);
        assert_eq!(
            scores[0].benchmark_summary,
            "{\"source\":\"ai\",\"version\":\"v2\",\"evidenceCount\":7,\"previous\":\"seed\"}"
        );
        let calls = model.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].messages[0].content.starts_with("persona\n\n"));
        assert_eq!(
            calls[0].audit_context,
            serde_json::json!({ "kind": "worker_planner" })
        );
    }

    #[test]
    fn the_bump_is_clamped_to_one() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        seed_score(&repo, "seed", 0.99);
        let persona = StubPersona {
            instruction: None,
            fail: false,
        };
        let model = StubModel::new("{\"delta\":0.05}", true);
        run_capability_understanding_cycle(
            &persona,
            &enabled_env(),
            model.as_ref(),
            &repo,
            &scope(),
            three_am_local(),
        )
        .unwrap();
        assert_eq!(
            repo.list_capability_scores(&scope()).unwrap()[0].confidence,
            1.0
        );
    }

    #[test]
    fn a_failed_dispatch_falls_back_to_the_heuristic() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        seed_score(&repo, "seed", 0.5);
        let persona = StubPersona {
            instruction: None,
            fail: false,
        };
        let model = StubModel::new("{\"delta\":0.05}", false);
        run_capability_understanding_cycle(
            &persona,
            &enabled_env(),
            model.as_ref(),
            &repo,
            &scope(),
            three_am_local(),
        )
        .unwrap();
        let scores = repo.list_capability_scores(&scope()).unwrap();
        assert!((scores[0].confidence - 0.51).abs() < 1e-12);
        assert!(scores[0]
            .benchmark_summary
            .contains("\"source\":\"heuristic\""));
    }

    #[test]
    fn a_persona_failure_falls_back_to_the_heuristic() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        seed_score(&repo, "seed", 0.5);
        let persona = StubPersona {
            instruction: None,
            fail: true,
        };
        let model = StubModel::new("{\"delta\":0.05}", true);
        run_capability_understanding_cycle(
            &persona,
            &enabled_env(),
            model.as_ref(),
            &repo,
            &scope(),
            three_am_local(),
        )
        .unwrap();
        assert!(repo.list_capability_scores(&scope()).unwrap()[0]
            .benchmark_summary
            .contains("\"source\":\"heuristic\""));
    }

    #[test]
    fn the_concrete_loop_drives_the_daily_scheduler() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        seed_score(&repo, "seed", 0.5);
        let persona: Arc<dyn CapabilityRuntimePersona> = Arc::new(StubPersona {
            instruction: None,
            fail: false,
        });
        let model: Arc<dyn MasterModelDispatch + Send + Sync> = StubModel::new("{}", true);
        let cycle = UnderstandingLoop::new(persona, MasterEnv::new(), model);
        let result = crate::master::learning::run_daily_learning_loop(
            &cycle,
            &repo,
            &scope(),
            three_am_local(),
        )
        .unwrap();
        assert!(result.executed);
        assert_eq!(result.updated, 1);
        assert_eq!(result.scheduled_at, "2026-03-04 03:00");
    }
}
