//! Port of `src/server/master/execution/runtime/executionPlan.ts:1-139`.
//!
//! Two planners: [`build_fallback_execution_plan`] is pure rule matching on the
//! contract, [`build_execution_plan_with_model`] asks the runtime persona's model
//! profile and falls back to the rule plan on *any* failure (the source's bare
//! `catch`).
//!
//! # The model hub call is a seam
//!
//! `getModelHubService().dispatchWithFallback(profileId, getModelHubEncryptionKey(), …)`
//! (`executionPlan.ts:72-105`) is the process-wide model-hub singleton. The port
//! takes a [`MasterModelDispatch`] and folds the encryption-key resolution into
//! its implementation, so a missing key surfaces as `Err` and triggers the same
//! fallback the source's `catch` produces. The concrete implementation is the
//! gateway's model-hub wiring (OP-S9-8).

use regex::Regex;
use serde_json::Value;

use crate::master::execution::runtime::json_parsing::extract_json_object_from_text;
use crate::master::feature_flags::MasterEnv;
use crate::master::runtime_persona::{
    get_master_runtime_persona_config, MasterRuntimePersonaInput,
};
use crate::personas::repository::PersonaRepository;

use super::types::{Capability, ExecutionPlan, RiskProfile, RuntimeMode};

/// `verificationChecks` default — `executionPlan.ts:55,127`.
pub const DEFAULT_VERIFICATION_CHECKS: &[&str] = &[
    "non_empty_outputs",
    "structured_outputs",
    "capability_phase_coverage",
];

/// `rationale` default for the fallback plan — `executionPlan.ts:54`.
pub const FALLBACK_RATIONALE: &str =
    "Fallback planner selected capabilities from rule-based contract analysis.";

/// `rationale` default for the model plan — `executionPlan.ts:130`.
pub const MODEL_RATIONALE: &str = "Model-generated runtime plan.";

/// One chat message of a model request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MasterModelMessage {
    pub role: String,
    pub content: String,
}

/// The request body of `dispatchWithFallback` — `executionPlan.ts:75-104`.
#[derive(Debug, Clone, PartialEq)]
pub struct MasterModelRequest {
    pub messages: Vec<MasterModelMessage>,
    pub temperature: f64,
    pub max_tokens: i64,
    /// `auditContext` — `{ kind: 'worker_planner' }` / `{ kind: 'worker_executor', taskId }`.
    pub audit_context: Value,
}

/// `{ ok, error, text }` read from the dispatch response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MasterModelResponse {
    pub ok: bool,
    pub error: Option<String>,
    pub text: String,
}

/// The model-hub dispatch entry, including the encryption-key resolution.
///
/// A `Result::Err` stands for the source's `throw` (missing key, transport
/// failure, `response.ok === false`); the caller treats every failure as a
/// fallback trigger.
pub trait MasterModelDispatch {
    fn dispatch_with_fallback(
        &self,
        profile_id: &str,
        request: &MasterModelRequest,
    ) -> Result<MasterModelResponse, String>;
}

/// `normalizeCapabilities` from `executionPlan.ts:6-26`.
///
/// `String(entry || '').trim().toLowerCase()` then keep the five known values
/// without duplicates.
pub fn normalize_capabilities(input: Option<&Value>) -> Vec<Capability> {
    let raw = match input {
        Some(Value::Array(entries)) => entries,
        _ => return Vec::new(),
    };
    let mut normalized: Vec<Capability> = Vec::new();
    for entry in raw {
        let value = match entry {
            Value::Null => String::new(),
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        let value = value.trim().to_lowercase();
        if let Some(capability) = Capability::parse(&value) {
            if !normalized.contains(&capability) {
                normalized.push(capability);
            }
        }
    }
    normalized
}

fn regex_matches(pattern: &str, text: &str) -> bool {
    let regex = Regex::new(pattern).expect("static regex");
    regex.is_match(text)
}

fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

/// `buildFallbackExecutionPlan` — `executionPlan.ts:28-64`.
pub fn build_fallback_execution_plan(contract: &str) -> ExecutionPlan {
    let normalized = contract.to_lowercase();
    let mut capabilities: Vec<Capability> = Vec::new();

    if regex_matches(
        r"\b(code|program|script|implement|implementation|module|function)\b",
        &normalized,
    ) {
        capabilities.push(Capability::CodeGeneration);
    }
    if regex_matches(r"\b(note|notiz|document|memo)\b", &normalized) {
        capabilities.push(Capability::Notes);
    }
    if regex_matches(r"\b(remind|reminder|erinner|cron|schedule)\b", &normalized) {
        capabilities.push(Capability::Reminders);
    }
    if regex_matches(r"\b(system|terminal|command|shell)\b", &normalized) {
        capabilities.push(Capability::SystemOps);
    }
    if regex_matches(
        r"\b(search|research|latest|docs|news|source|web)\b",
        &normalized,
    ) {
        capabilities.insert(0, Capability::WebSearch);
    }
    if capabilities.is_empty() {
        capabilities.push(Capability::WebSearch);
    }

    // `capabilities.filter((entry, index) => capabilities.indexOf(entry) === index)`.
    let mut selected: Vec<Capability> = Vec::new();
    for capability in &capabilities {
        if !selected.contains(capability) {
            selected.push(*capability);
        }
    }

    let risk_profile = if selected.contains(&Capability::SystemOps) {
        RiskProfile::High
    } else if selected.contains(&Capability::CodeGeneration) {
        RiskProfile::Medium
    } else {
        RiskProfile::Low
    };
    ExecutionPlan {
        capabilities: selected.iter().take(3).copied().collect(),
        rationale: FALLBACK_RATIONALE.to_string(),
        verification_checks: DEFAULT_VERIFICATION_CHECKS
            .iter()
            .map(|check| check.to_string())
            .collect(),
        risk_profile,
        requires_approval: selected.contains(&Capability::SystemOps)
            || selected.contains(&Capability::CodeGeneration),
        source: RuntimeMode::Fallback,
    }
}

/// `buildExecutionPlanWithModel` — `executionPlan.ts:66-139`.
///
/// The bare `catch` is the `unwrap_or_else` around [`model_plan`]: every failure
/// (persona resolution, key resolution, transport, `response.ok === false`,
/// unsupported capabilities) yields the rule plan.
pub fn build_execution_plan_with_model(
    contract: &str,
    scope: &MasterRuntimePersonaInput,
    persona_repo: &PersonaRepository,
    env: &MasterEnv,
    model: &dyn MasterModelDispatch,
) -> ExecutionPlan {
    model_plan(contract, scope, persona_repo, env, model)
        .unwrap_or_else(|| build_fallback_execution_plan(contract))
}

fn model_plan(
    contract: &str,
    scope: &MasterRuntimePersonaInput,
    persona_repo: &PersonaRepository,
    env: &MasterEnv,
    model: &dyn MasterModelDispatch,
) -> Option<ExecutionPlan> {
    let runtime_persona = get_master_runtime_persona_config(scope, persona_repo, env).ok()?;

    let mut parts: Vec<String> = Vec::new();
    if let Some(instruction) = &runtime_persona.system_instruction {
        if !instruction.is_empty() {
            parts.push(instruction.clone());
        }
    }
    if let Some(preferred) = &runtime_persona.preferred_model_id {
        if !preferred.is_empty() {
            parts.push(format!("Preferred model hint: {preferred}"));
        }
    }
    parts.push("You are a strict runtime planner for an autonomous execution engine.".to_string());
    parts.push("Return JSON only with keys:".to_string());
    parts.push(
        "- capabilities: array of web_search|code_generation|notes|reminders|system_ops"
            .to_string(),
    );
    parts.push("- rationale: string".to_string());
    parts.push("- verificationChecks: string[]".to_string());
    parts.push("- riskProfile: low|medium|high".to_string());
    parts.push("- requiresApproval: boolean".to_string());
    parts.push("Never return markdown fences.".to_string());

    let request = MasterModelRequest {
        messages: vec![
            MasterModelMessage {
                role: "system".to_string(),
                content: parts.join("\n\n"),
            },
            MasterModelMessage {
                role: "user".to_string(),
                content: format!("Contract:\n{contract}"),
            },
        ],
        temperature: 0.2,
        max_tokens: 500,
        audit_context: serde_json::json!({ "kind": "worker_planner" }),
    };
    let response = model
        .dispatch_with_fallback(&runtime_persona.model_hub_profile_id, &request)
        .ok()?;
    if !response.ok {
        return None;
    }
    let parsed = extract_json_object_from_text(&response.text);
    let capabilities =
        normalize_capabilities(parsed.as_ref().and_then(|value| value.get("capabilities")));
    if capabilities.is_empty() {
        return None;
    }

    let risk_profile_raw = js_string(parsed.as_ref().and_then(|value| value.get("riskProfile")))
        .trim()
        .to_lowercase();
    let risk_profile = match RiskProfile::parse(&risk_profile_raw) {
        Some(profile) => profile,
        None if capabilities.contains(&Capability::SystemOps) => RiskProfile::High,
        None if capabilities.contains(&Capability::CodeGeneration) => RiskProfile::Medium,
        None => RiskProfile::Low,
    };

    let verification_checks = parsed
        .as_ref()
        .and_then(|value| value.get("verificationChecks"))
        .and_then(|value| value.as_array())
        .map(|entries| {
            entries
                .iter()
                .map(|entry| js_string(Some(entry)).trim().to_string())
                .filter(|entry| !entry.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| {
            DEFAULT_VERIFICATION_CHECKS
                .iter()
                .map(|check| check.to_string())
                .collect()
        });

    let rationale = js_string(parsed.as_ref().and_then(|value| value.get("rationale")));
    Some(ExecutionPlan {
        capabilities: capabilities.iter().take(3).copied().collect(),
        rationale: if rationale.is_empty() {
            MODEL_RATIONALE.to_string()
        } else {
            rationale
        },
        verification_checks,
        risk_profile,
        requires_approval: parsed
            .as_ref()
            .and_then(|value| value.get("requiresApproval"))
            .map(|value| match value {
                Value::Bool(flag) => *flag,
                Value::Null => false,
                Value::Number(number) => number.as_f64().map(|n| n != 0.0).unwrap_or(true),
                Value::String(text) => !text.is_empty(),
                _ => true,
            })
            .unwrap_or(false),
        source: RuntimeMode::Model,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::personas::repository::PersonaRepository;
    use crate::personas::workspace::PersonaWorkspace;

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new() -> Self {
            let unique = uuid::Uuid::new_v4().simple().to_string();
            let path = std::env::temp_dir().join(format!("betaclaw-master-plan-{unique}"));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn repo(&self) -> PersonaRepository {
            PersonaRepository::open_with_workspace(
                self.0.join("personas.db").to_string_lossy().as_ref(),
                PersonaWorkspace::new(self.0.join("personas")),
            )
            .expect("open persona repository")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct StubModel {
        response: Result<MasterModelResponse, String>,
    }

    impl MasterModelDispatch for StubModel {
        fn dispatch_with_fallback(
            &self,
            _profile_id: &str,
            _request: &MasterModelRequest,
        ) -> Result<MasterModelResponse, String> {
            self.response.clone()
        }
    }

    fn ok_response(text: &str) -> StubModel {
        StubModel {
            response: Ok(MasterModelResponse {
                ok: true,
                error: None,
                text: text.to_string(),
            }),
        }
    }

    fn scope() -> MasterRuntimePersonaInput {
        MasterRuntimePersonaInput {
            user_id: "u1".to_string(),
            persona_id: None,
        }
    }

    #[test]
    fn the_fallback_plan_matches_the_source_rules() {
        let plan = build_fallback_execution_plan("Write a script and search the web");
        assert_eq!(
            plan.capabilities,
            vec![Capability::WebSearch, Capability::CodeGeneration]
        );
        assert_eq!(plan.risk_profile, RiskProfile::Medium);
        assert!(plan.requires_approval);
        assert_eq!(plan.source, RuntimeMode::Fallback);
        assert_eq!(plan.rationale, FALLBACK_RATIONALE);
    }

    #[test]
    fn an_empty_contract_selects_web_search() {
        let plan = build_fallback_execution_plan("nothing actionable here");
        assert_eq!(plan.capabilities, vec![Capability::WebSearch]);
        assert_eq!(plan.risk_profile, RiskProfile::Low);
        assert!(!plan.requires_approval);
    }

    #[test]
    fn system_ops_forces_high_risk_and_is_trimmed_to_three() {
        let plan = build_fallback_execution_plan("run a shell command and search the web");
        assert!(plan.capabilities.len() <= 3);
        assert!(plan.capabilities.contains(&Capability::SystemOps));
        assert_eq!(plan.risk_profile, RiskProfile::High);
        assert!(plan.requires_approval);
    }

    #[test]
    fn capabilities_are_normalized_and_deduplicated() {
        let input = serde_json::json!([" Web_Search ", "notes", "notes", "bogus", 5]);
        assert_eq!(
            normalize_capabilities(Some(&input)),
            vec![Capability::WebSearch, Capability::Notes]
        );
        assert!(normalize_capabilities(None).is_empty());
        assert!(normalize_capabilities(Some(&serde_json::json!("x"))).is_empty());
    }

    #[test]
    fn the_model_plan_is_used_when_the_model_answers() {
        let dir = TempDir::new();
        let repo = dir.repo();
        let model = ok_response(
            r#"{"capabilities":["code_generation","notes"],"rationale":"planned",
                "verificationChecks":["a","","b"],"riskProfile":"high","requiresApproval":true}"#,
        );
        let plan =
            build_execution_plan_with_model("contract", &scope(), &repo, &MasterEnv::new(), &model);
        assert_eq!(plan.source, RuntimeMode::Model);
        assert_eq!(
            plan.capabilities,
            vec![Capability::CodeGeneration, Capability::Notes]
        );
        assert_eq!(plan.rationale, "planned");
        assert_eq!(plan.verification_checks, vec!["a", "b"]);
        assert_eq!(plan.risk_profile, RiskProfile::High);
        assert!(plan.requires_approval);
    }

    #[test]
    fn every_model_failure_falls_back_to_the_rule_plan() {
        let dir = TempDir::new();
        let repo = dir.repo();
        let failing = StubModel {
            response: Err("no key".to_string()),
        };
        let plan = build_execution_plan_with_model(
            "run a shell command",
            &scope(),
            &repo,
            &MasterEnv::new(),
            &failing,
        );
        assert_eq!(plan.source, RuntimeMode::Fallback);

        let no_capabilities = ok_response(r#"{"rationale":"x"}"#);
        let plan = build_execution_plan_with_model(
            "run a shell command",
            &scope(),
            &repo,
            &MasterEnv::new(),
            &no_capabilities,
        );
        assert_eq!(plan.source, RuntimeMode::Fallback);
    }
}
