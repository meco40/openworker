//! `betaclaw-scheduler graphiti-evaluate` replaces `pnpm run world-model:graphiti-evaluate`
//! (`scripts/world-model-graphiti-evaluate.ts`).
//!
//! Measures Graphiti recall and precision against the canonical World-Model rows of
//! each scope. The report is separate from the rebuild report: a transport-complete
//! rebuild does not prove useful recall. `--require-quality` turns a missed threshold
//! into exit 1.
//!
//! Flags: `--scope <userId:personaId:workspaceId>|all`, `--output <file>`,
//! `--require-quality`, `--recall-threshold <0..1>`, `--precision-threshold <0..1>`.
//! Errors print the message alone on stderr and exit 1, as the script does.

use std::collections::HashMap;
use std::sync::Arc;

use betaclaw_core::model_hub::http::HttpTransport;
use betaclaw_core::world_model::config::RuntimeRole;
use betaclaw_core::world_model::db::PgExecutor;
use betaclaw_core::world_model::graphiti::client::GraphitiRestClient;
use betaclaw_core::world_model::graphiti::evaluator::{
    evaluate_graphiti_value, EvaluationScope, GraphitiEvaluationResult,
};
use betaclaw_core::world_model::runtime::scope_discovery::list_runtime_world_model_scopes;
use betaclaw_core::world_model::scope::WorldModelScope;
use serde_json::{json, Map, Value as Json};

use super::{connect_lazy_executor, js_number, load_config, process_env};

/// The default thresholds of the script.
const DEFAULT_THRESHOLD: f64 = 0.9;
/// The default and the bounds of `retrievalK` (`GRAPHITI_SEARCH_RESULTS`).
const DEFAULT_RETRIEVAL_K: f64 = 5.0;
const MAX_RETRIEVAL_K: f64 = 50.0;

const LIMITATIONS: [&str; 3] = [
    "Graphiti is a derived projection; PostgreSQL remains the system of record.",
    "A rebuild can be transport-complete while recall quality remains below the activation threshold.",
    "Provider-wide Mem0 and external channel/provider receipts are outside this local report.",
];

/// The parsed flags (`parseArgs`, `world-model-graphiti-evaluate.ts:29-58`).
#[derive(Debug, PartialEq)]
pub struct Options {
    pub scope: Option<String>,
    pub output: Option<String>,
    pub require_quality: bool,
    pub recall_threshold: f64,
    pub precision_threshold: f64,
}

/// `parseArgs`. A flag with a value takes the next argument even when it is a flag.
pub fn parse_args(args: &[String]) -> Result<Options, String> {
    let mut options = Options {
        scope: None,
        output: None,
        require_quality: false,
        recall_threshold: DEFAULT_THRESHOLD,
        precision_threshold: DEFAULT_THRESHOLD,
    };
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--scope" => {
                index += 1;
                options.scope = args.get(index).cloned();
            }
            "--output" => {
                index += 1;
                options.output = args.get(index).cloned();
            }
            "--require-quality" => options.require_quality = true,
            "--recall-threshold" => {
                index += 1;
                options.recall_threshold =
                    parse_threshold(args.get(index).map(String::as_str), "--recall-threshold")?;
            }
            "--precision-threshold" => {
                index += 1;
                options.precision_threshold =
                    parse_threshold(args.get(index).map(String::as_str), "--precision-threshold")?;
            }
            _ => {}
        }
        index += 1;
    }
    Ok(options)
}

/// `parseThreshold`: a number from 0 to 1.
fn parse_threshold(value: Option<&str>, flag: &str) -> Result<f64, String> {
    match js_number(value) {
        Some(threshold) if (0.0..=1.0).contains(&threshold) => Ok(threshold),
        _ => Err(format!("{flag} must be a number between 0 and 1.")),
    }
}

/// `parseScope`: `userId:personaId:workspaceId`, the workspace may contain `:`. The
/// parts are not trimmed, as in the script.
pub fn parse_scope(value: &str) -> Result<WorldModelScope, String> {
    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() < 3 || parts[0].is_empty() || parts[1].is_empty() {
        return Err("--scope must be all or userId:personaId:workspaceId.".to_string());
    }
    Ok(WorldModelScope::new(
        parts[0],
        parts[1],
        Some(parts[2..].join(":")),
    ))
}

/// `label`: `userId:personaId:workspaceId` with an absent workspace as `""`.
pub fn scope_label(scope: &WorldModelScope) -> String {
    format!(
        "{}:{}:{}",
        scope.user_id,
        scope.persona_id,
        scope.workspace_id.as_deref().unwrap_or("")
    )
}

/// `Math.max(5, Math.min(50, Number(GRAPHITI_SEARCH_RESULTS) || 5))`. `Infinity` is a
/// number here, so it clamps to 50 as in the script.
pub fn retrieval_k(env: &HashMap<String, String>) -> i64 {
    let raw = match env.get("GRAPHITI_SEARCH_RESULTS").map(|value| value.trim()) {
        Some("Infinity") => f64::INFINITY,
        Some("-Infinity") => f64::NEG_INFINITY,
        text => js_number(text).unwrap_or(f64::NAN),
    };
    let raw = if raw == 0.0 || raw.is_nan() {
        DEFAULT_RETRIEVAL_K
    } else {
        raw
    };
    raw.clamp(DEFAULT_RETRIEVAL_K, MAX_RETRIEVAL_K).floor() as i64
}

/// A JSON number as JavaScript prints it: whole numbers without a fraction.
pub fn js_json_number(value: f64) -> Json {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// One scope's result in the order of the script's object: `scope`, then the fields
/// of `GraphitiEvaluationResult`, with `error` only when it is set.
pub fn evaluation_json(scope: &WorldModelScope, result: &GraphitiEvaluationResult) -> Json {
    let mut entry = Map::new();
    entry.insert("scope".into(), json!(scope_label(scope)));
    entry.insert("graphitiReachable".into(), json!(result.graphiti_reachable));
    entry.insert(
        "shadowEdgeCount".into(),
        js_json_number(result.shadow_edge_count),
    );
    entry.insert(
        "structuredHitCount".into(),
        json!(result.structured_hit_count),
    );
    entry.insert(
        "evaluatedTargetCount".into(),
        json!(result.evaluated_target_count),
    );
    entry.insert(
        "graphitiFactCount".into(),
        json!(result.graphiti_fact_count),
    );
    entry.insert(
        "relevantFactCount".into(),
        json!(result.relevant_fact_count),
    );
    entry.insert(
        "matchedStructuredCount".into(),
        json!(result.matched_structured_count),
    );
    entry.insert(
        "provenanceMatchCount".into(),
        json!(result.provenance_match_count),
    );
    entry.insert("retrievalK".into(), json!(result.retrieval_k));
    entry.insert("precision".into(), js_json_number(result.precision));
    entry.insert("recall".into(), js_json_number(result.recall));
    entry.insert("precisionAt1".into(), js_json_number(result.precision_at1));
    entry.insert("recallAt1".into(), js_json_number(result.recall_at1));
    entry.insert("precisionAt3".into(), js_json_number(result.precision_at3));
    entry.insert("recallAt3".into(), js_json_number(result.recall_at3));
    entry.insert("precisionAtK".into(), js_json_number(result.precision_at_k));
    entry.insert("recallAtK".into(), js_json_number(result.recall_at_k));
    entry.insert("mrr".into(), js_json_number(result.mrr));
    entry.insert("overlapRate".into(), js_json_number(result.overlap_rate));
    entry.insert(
        "recommendation".into(),
        json!(result.recommendation.as_str()),
    );
    if let Some(error) = &result.error {
        entry.insert("error".into(), json!(error));
    }
    Json::Object(entry)
}

/// One scope passes when Graphiti is reachable and meets both thresholds.
pub fn scope_passes(
    reachable: bool,
    recall_at_k: f64,
    precision_at_k: f64,
    options: &Options,
) -> bool {
    reachable
        && recall_at_k >= options.recall_threshold
        && precision_at_k >= options.precision_threshold
}

/// `qualityPassed`: every scope passes (an empty list passes, as `every` does).
pub fn quality_passed(results: &[GraphitiEvaluationResult], options: &Options) -> bool {
    results.iter().all(|result| {
        scope_passes(
            result.graphiti_reachable,
            result.recall_at_k,
            result.precision_at_k,
            options,
        )
    })
}

/// Runs the evaluation. Returns the exit status.
pub async fn run(args: &[String]) -> i32 {
    match evaluate(args).await {
        Ok(passed_or_not_required) => {
            if passed_or_not_required {
                0
            } else {
                1
            }
        }
        Err(message) => {
            eprintln!("{message}");
            1
        }
    }
}

/// The order of the script. Returns `false` when `--require-quality` is set and the
/// thresholds were missed.
async fn evaluate(args: &[String]) -> Result<bool, String> {
    let options = parse_args(args)?;
    let env = process_env();
    let config = load_config();
    let app = connect_lazy_executor(&config).map_err(|error| error.into_message())?;

    let scopes = match options.scope.as_deref() {
        Some(value) if value != "all" => vec![parse_scope(value)?],
        _ => {
            let runtime_role: RuntimeRole = config.runtime_role;
            list_runtime_world_model_scopes(&env, Some(&app as &dyn PgExecutor), runtime_role).await
        }
    };
    if scopes.is_empty() {
        app.close().await;
        return Err("No runtime scopes were discovered.".to_string());
    }

    let transport: Arc<dyn HttpTransport> =
        Arc::new(crate::model_hub_transport::ReqwestTransport::new());
    let graphiti = GraphitiRestClient::from_env(transport);
    let k = retrieval_k(&env);

    let mut results = Vec::new();
    let mut evaluations = Vec::new();
    for scope in &scopes {
        // The script checks the health for every scope (`evaluateGraphitiValueInScope`).
        let health = graphiti.health().await;
        let input = EvaluationScope {
            user_id: scope.user_id.clone(),
            persona_id: scope.persona_id.clone(),
            workspace_id: scope.workspace_id.clone().unwrap_or_default(),
        };
        let result = evaluate_graphiti_value(&app, &graphiti, &health, &input, k).await;
        evaluations.push(evaluation_json(scope, &result));
        results.push(result);
    }
    app.close().await;

    let passed = quality_passed(&results, &options);
    let report = json!({
        "generatedAt": super::iso_now(),
        "evidenceClass": "graphiti-historical-recall-evaluation",
        "scopeSelection": options.scope.clone().unwrap_or_else(|| "all".to_string()),
        "thresholds": {
            "recall": js_json_number(options.recall_threshold),
            "precision": js_json_number(options.precision_threshold),
        },
        "qualityPassed": passed,
        "activationRecommendation": if passed { "enable" } else { "shadow" },
        "evaluations": evaluations,
        "limitations": LIMITATIONS,
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&report).unwrap_or_default()
    );

    if let Some(path) = &options.output {
        std::fs::write(
            path,
            serde_json::to_string_pretty(&report).unwrap_or_default(),
        )
        .map_err(|error| error.to_string())?;
        println!("Report written to {path}");
    }
    Ok(!options.require_quality || passed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn thresholds_must_be_numbers_between_zero_and_one() {
        let options = parse_args(&args(&["--recall-threshold", "0.75"])).unwrap();
        assert_eq!(options.recall_threshold, 0.75);
        assert_eq!(options.precision_threshold, 0.9);
        assert_eq!(
            parse_args(&args(&["--precision-threshold", "1.5"])).unwrap_err(),
            "--precision-threshold must be a number between 0 and 1."
        );
        assert_eq!(
            parse_args(&args(&["--recall-threshold"])).unwrap_err(),
            "--recall-threshold must be a number between 0 and 1."
        );
    }

    #[test]
    fn a_scope_keeps_colons_in_the_workspace_and_is_not_trimmed() {
        let scope = parse_scope("u: p:a:b").unwrap();
        assert_eq!(scope.user_id, "u");
        assert_eq!(scope.persona_id, " p");
        assert_eq!(scope.workspace_id.as_deref(), Some("a:b"));
        assert_eq!(
            parse_scope("u:p").unwrap_err(),
            "--scope must be all or userId:personaId:workspaceId."
        );
    }

    #[test]
    fn the_retrieval_count_is_clamped_like_the_script() {
        let env = |value: Option<&str>| -> HashMap<String, String> {
            value
                .map(|raw| {
                    [("GRAPHITI_SEARCH_RESULTS".to_string(), raw.to_string())]
                        .into_iter()
                        .collect()
                })
                .unwrap_or_default()
        };
        assert_eq!(retrieval_k(&env(None)), 5);
        assert_eq!(retrieval_k(&env(Some("abc"))), 5);
        assert_eq!(retrieval_k(&env(Some("2"))), 5);
        assert_eq!(retrieval_k(&env(Some("20"))), 20);
        assert_eq!(retrieval_k(&env(Some("500"))), 50);
    }

    #[test]
    fn whole_numbers_are_printed_without_a_fraction() {
        assert_eq!(js_json_number(1.0).to_string(), "1");
        assert_eq!(js_json_number(0.5).to_string(), "0.5");
    }

    #[test]
    fn a_scope_needs_reachability_and_both_thresholds() {
        let options = parse_args(&[]).unwrap();
        assert!(scope_passes(true, 0.9, 0.9, &options));
        assert!(!scope_passes(false, 1.0, 1.0, &options));
        assert!(!scope_passes(true, 0.89, 1.0, &options));
        assert!(!scope_passes(true, 1.0, 0.5, &options));
    }
}
