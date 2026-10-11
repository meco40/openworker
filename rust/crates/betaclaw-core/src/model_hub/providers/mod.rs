//! Port of `src/server/model-hub/Models/registry.ts` plus the provider adapters
//! of `src/server/model-hub/Models/<provider>/index.ts`.
//!
//! Fifteen adapters are ported — every catalog entry, in `registry.ts` order:
//!
//! | Adapter | Kind |
//! | --- | --- |
//! | [`gemini`], [`anthropic`], [`xai`] | native wire format end to end |
//! | [`cohere`] | native v2 wire format end to end (own `message.content[]` / `usage.tokens` shape) |
//! | [`openai_codex`] | native Responses wire format end to end (own SSE event names, `chatgpt-account-id` header, usage and rate-limit parsers) |
//! | [`github_copilot`] | native model discovery, OpenAI-compatible dispatch |
//! | [`ollama`], [`opencode`] | own model discovery, OpenAI-compatible dispatch |
//! | [`openai`], [`openrouter`], [`lmstudio`], [`mistral`], [`kimi`], [`zai`], [`bytedance`] | pure configuration of the shared OpenAI-compatible layer |
//!
//! `cohere` and `openai-codex` were the last two entries; they landed in S4b/S4c.
//! [`DEFERRED_PROVIDER_IDS`] is therefore empty, and the two lists together cover
//! all fifteen catalog ids.
//!
//! [`get_provider_adapter`] now returns `None` only for an id that is not in the
//! catalog at all — `getProviderAdapter` (`registry.ts:36-38`) has the same
//! fall-through when a provider module is missing from the build. The two
//! account-level entry points that consume that case are still unported:
//! `fetchModelsForAccount` (`modelFetcher.ts:43`) and
//! `testProviderAccountConnectivity` (`connectivity.ts:12`, with its
//! `openai-compatible` fallback at `:34-46`) — see the open-points register in
//! `docs/RUST_MIGRATION.md`.
//!
//! The mapping is one file per provider, mirroring the TypeScript directory names,
//! so a reviewer can diff `providers/kimi.rs` against `Models/kimi/index.ts`.

use crate::model_hub::env::EnvOverrides;
use crate::model_hub::http::{BoxFuture, HttpError, HttpTransport};
use crate::model_hub::openai_compatible::utils::AttachmentStore;
use crate::model_hub::types::{
    ConnectivityResult, FetchedModel, GatewayRequest, GatewayResponse, ProviderExecutionContext,
};

pub mod anthropic;
pub mod bytedance;
pub mod cohere;
pub mod gemini;
pub mod github_copilot;
pub mod kimi;
pub mod lmstudio;
pub mod mistral;
pub mod ollama;
pub mod openai;
pub mod openai_codex;
pub mod opencode;
pub mod openrouter;
pub mod xai;
pub mod zai;

use crate::model_hub::openai_compatible::DispatchOptions;

/// `ProviderAdapter` from `src/server/model-hub/Models/types.ts:84-95`.
///
/// The two collaborators TypeScript reaches for implicitly — `fetch` and the
/// attachment filesystem — are bundled into [`ProviderCall`] so the adapter
/// signature stays short and object safe.
pub trait ProviderAdapter: Send + Sync {
    fn id(&self) -> &'static str;

    /// `fetchModels(context)`.
    fn fetch_models<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
    ) -> BoxFuture<'a, Result<Vec<FetchedModel>, HttpError>>;

    /// `testConnectivity(context, options)` where `options.model` is optional.
    fn test_connectivity<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        model: Option<&'a str>,
    ) -> BoxFuture<'a, ConnectivityResult>;

    /// `dispatchGateway(context, request, options)`.
    fn dispatch_gateway<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        request: &'a GatewayRequest,
        options: &'a DispatchOptions,
    ) -> BoxFuture<'a, Result<GatewayResponse, HttpError>>;
}

/// The collaborators every adapter needs, in place of TypeScript's implicit
/// globals. Build it with a struct literal.
pub struct ProviderCall<'a> {
    pub transport: &'a dyn HttpTransport,
    pub attachments: &'a dyn AttachmentStore,
    /// Reads `process.env` by default; tests inject overrides.
    pub env: &'a EnvOverrides,
}

/// `providerAdapters` from `registry.ts:19-35`, restricted to the ported subset.
fn adapter_for(provider_id: &str) -> Option<&'static dyn ProviderAdapter> {
    static GEMINI: gemini::GeminiAdapter = gemini::GeminiAdapter;
    static ANTHROPIC: anthropic::AnthropicAdapter = anthropic::AnthropicAdapter;
    static XAI: xai::XaiAdapter = xai::XaiAdapter;
    static OPENAI: openai::OpenAiAdapter = openai::OpenAiAdapter;
    static OPENAI_CODEX: openai_codex::OpenAiCodexAdapter = openai_codex::OpenAiCodexAdapter;
    static MISTRAL: mistral::MistralAdapter = mistral::MistralAdapter;
    static COHERE: cohere::CohereAdapter = cohere::CohereAdapter;
    static LMSTUDIO: lmstudio::LmStudioAdapter = lmstudio::LmStudioAdapter;
    static ZAI: zai::ZaiAdapter = zai::ZaiAdapter;
    static BYTEDANCE: bytedance::BytedanceAdapter = bytedance::BytedanceAdapter;
    static OPENROUTER: openrouter::OpenRouterAdapter = openrouter::OpenRouterAdapter;
    static KIMI: kimi::KimiAdapter = kimi::KimiAdapter;
    static OLLAMA: ollama::OllamaAdapter = ollama::OllamaAdapter;
    static OPENCODE: opencode::OpenCodeAdapter = opencode::OpenCodeAdapter;
    static GITHUB_COPILOT: github_copilot::GithubCopilotAdapter =
        github_copilot::GithubCopilotAdapter;

    match provider_id {
        "gemini" => Some(&GEMINI),
        "openai" => Some(&OPENAI),
        "openai-codex" => Some(&OPENAI_CODEX),
        "anthropic" => Some(&ANTHROPIC),
        "opencode" => Some(&OPENCODE),
        "openrouter" => Some(&OPENROUTER),
        "ollama" => Some(&OLLAMA),
        "lmstudio" => Some(&LMSTUDIO),
        "xai" => Some(&XAI),
        "mistral" => Some(&MISTRAL),
        "cohere" => Some(&COHERE),
        "kimi" => Some(&KIMI),
        "zai" => Some(&ZAI),
        "bytedance" => Some(&BYTEDANCE),
        "github-copilot" => Some(&GITHUB_COPILOT),
        _ => None,
    }
}

/// `getProviderAdapter(providerId)` from `registry.ts:36-38`.
pub fn get_provider_adapter(provider_id: &str) -> Option<&'static dyn ProviderAdapter> {
    adapter_for(provider_id)
}

/// The provider ids this slice ports (all of them), in registry order.
pub const PORTED_PROVIDER_IDS: &[&str] = &[
    "gemini",
    "openai",
    "openai-codex",
    "anthropic",
    "opencode",
    "openrouter",
    "ollama",
    "lmstudio",
    "xai",
    "mistral",
    "cohere",
    "kimi",
    "zai",
    "bytedance",
    "github-copilot",
];

/// Catalog entries still served by the TypeScript adapters, in registry order.
/// Empty since S4 closed; the constant stays so `registry_and_catalog_agree`
/// keeps proving that both lists partition `catalog_ids()` without the test
/// having to be rewritten once the last adapter lands.
pub const DEFERRED_PROVIDER_IDS: &[&str] = &[];

/// `provider.defaultModels[0]` — the `options.model || defaultModels[0]` idiom
/// that `zai` and `bytedance` use for their ping request.
pub fn default_model_or_first(context: &ProviderExecutionContext) -> Option<&str> {
    context.provider.default_models.first().map(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_hub::provider_catalog::catalog_ids;

    /// All fifteen catalog ids resolve: `PORTED_PROVIDER_IDS` plus the (now empty)
    /// `DEFERRED_PROVIDER_IDS` partition `catalog_ids()`, and the registry answers
    /// for every one of them.
    #[test]
    fn registry_and_catalog_agree() {
        assert_eq!(
            PORTED_PROVIDER_IDS.len() + DEFERRED_PROVIDER_IDS.len(),
            catalog_ids().len(),
            "every catalog entry is either ported or deferred"
        );
        assert_eq!(
            PORTED_PROVIDER_IDS.len(),
            catalog_ids().len(),
            "S4 is closed: no catalog entry is deferred any more"
        );
        for provider_id in PORTED_PROVIDER_IDS {
            assert!(
                get_provider_adapter(provider_id).is_some(),
                "{provider_id} must resolve"
            );
        }
        for provider_id in DEFERRED_PROVIDER_IDS {
            assert!(
                get_provider_adapter(provider_id).is_none(),
                "{provider_id} is deferred to a later Model-Hub slice"
            );
        }
    }

    #[test]
    fn every_ported_adapter_exposes_all_three_handlers() {
        for provider_id in PORTED_PROVIDER_IDS {
            let adapter = get_provider_adapter(provider_id).expect("adapter");
            assert_eq!(adapter.id(), *provider_id);
        }
    }
}
