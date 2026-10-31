//! Port of
//! `src/server/model-hub/Models/openai-codex/connectivity/testConnectivity.ts`.
//!
//! The probe is a real (tiny) Responses call — `ping`, `max_tokens: 16` — and the
//! result is then enriched with the `/wham/usage` snapshot, whose failure is
//! swallowed (`testConnectivity.ts:20-25`). The snapshot that wins is the merge
//! of the probe's response headers and the usage payload.
//!
//! `max_tokens` reaches the probe request but **not** the wire body: the Codex
//! request mapper never sends it (`requestMapper.ts:48-58`).

use crate::model_hub::http::HttpTransport;
use crate::model_hub::openai_compatible::utils::AttachmentStore;
use crate::model_hub::types::{ConnectivityResult, GatewayMessage, GatewayRequest};

use super::client::config::resolve_codex_probe_model;
use super::client::dispatch::dispatch_codex_responses;
use super::client::usage::fetch_codex_usage_rate_limits;
use super::parsers::usage_rate_limit_parser::merge_rate_limit_snapshots;

/// `'OpenAI Codex connectivity failed: '` from `testConnectivity.ts:37`.
pub const CONNECTIVITY_FAILURE_PREFIX: &str = "OpenAI Codex connectivity failed: ";
/// `'Codex probe failed.'` — the `||` fallback of `testConnectivity.ts:37`.
pub const PROBE_FAILED: &str = "Codex probe failed.";

/// `testOpenAICodexConnectivity({ secret, defaultModels, model })` from
/// `testConnectivity.ts:7-40`.
pub async fn test_openai_codex_connectivity(
    transport: &dyn HttpTransport,
    attachments: &dyn AttachmentStore,
    secret: &str,
    default_models: &[String],
    model: Option<&str>,
) -> ConnectivityResult {
    let probe_model = resolve_codex_probe_model(model, default_models);
    let probe_request = GatewayRequest {
        max_tokens: Some(16),
        ..GatewayRequest::new(probe_model.clone(), vec![GatewayMessage::user("ping")])
    };

    let result =
        dispatch_codex_responses(transport, attachments, secret, &probe_request, None, None).await;

    let usage_rate_limits = fetch_codex_usage_rate_limits(transport, secret)
        .await
        .ok()
        .flatten();
    let rate_limits =
        merge_rate_limit_snapshots(result.rate_limits.as_ref(), usage_rate_limits.as_ref());

    if result.ok {
        return ConnectivityResult {
            ok: true,
            message: format!(
                "OpenAI Codex connectivity verified (codex responses reachable with model {probe_model})."
            ),
            rate_limits,
        };
    }

    ConnectivityResult {
        ok: false,
        message: format!(
            "{CONNECTIVITY_FAILURE_PREFIX}{}",
            result
                .error
                .filter(|error| !error.is_empty())
                .unwrap_or_else(|| PROBE_FAILED.to_string())
        ),
        rate_limits,
    }
}
