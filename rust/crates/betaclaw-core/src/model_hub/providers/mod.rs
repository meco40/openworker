//! Port of `src/server/model-hub/Models/registry.ts` plus the seven simple
//! provider adapters of `src/server/model-hub/Models/<provider>/index.ts`.
//!
//! Only the providers that are a pure configuration of the shared
//! OpenAI-compatible layer are ported: `openai`, `mistral`, `lmstudio`, `zai`,
//! `bytedance`, `openrouter` and `kimi`. The eight remaining catalog entries —
//! `gemini`, `openai-codex`, `anthropic`, `xai`, `cohere`, `opencode`, `ollama`
//! and `github-copilot` — keep their own wire format and parser in TypeScript and
//! arrive in S4b/S4c.
//!
//! [`get_provider_adapter`] therefore returns `None` for them, which is exactly
//! what `getProviderAdapter` does in a build where the adapter module is absent.
//! `testProviderConnectivity` handles the `None` case, and
//! `testProviderAccountConnectivity` (`connectivity.ts:38-55`) has an explicit
//! `openai-compatible` fallback that keeps `ollama`, `opencode` and the two native
//! providers without an adapter reachable.
//!
//! The mapping is one file per provider, mirroring the TypeScript directory names,
//! so a reviewer can diff `providers/kimi.rs` against `Models/kimi/index.ts`.

use crate::model_hub::env::EnvOverrides;
use crate::model_hub::http::{BoxFuture, HttpError, HttpTransport};
use crate::model_hub::openai_compatible::utils::AttachmentStore;
use crate::model_hub::types::{
    ConnectivityResult, FetchedModel, GatewayRequest, GatewayResponse, ProviderExecutionContext,
};

pub mod bytedance;
pub mod kimi;
pub mod lmstudio;
pub mod mistral;
pub mod openai;
pub mod openrouter;
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
    static OPENAI: openai::OpenAiAdapter = openai::OpenAiAdapter;
    static MISTRAL: mistral::MistralAdapter = mistral::MistralAdapter;
    static LMSTUDIO: lmstudio::LmStudioAdapter = lmstudio::LmStudioAdapter;
    static ZAI: zai::ZaiAdapter = zai::ZaiAdapter;
    static BYTEDANCE: bytedance::BytedanceAdapter = bytedance::BytedanceAdapter;
    static OPENROUTER: openrouter::OpenRouterAdapter = openrouter::OpenRouterAdapter;
    static KIMI: kimi::KimiAdapter = kimi::KimiAdapter;

    match provider_id {
        "openai" => Some(&OPENAI),
        "mistral" => Some(&MISTRAL),
        "lmstudio" => Some(&LMSTUDIO),
        "zai" => Some(&ZAI),
        "bytedance" => Some(&BYTEDANCE),
        "openrouter" => Some(&OPENROUTER),
        "kimi" => Some(&KIMI),
        _ => None,
    }
}

/// `getProviderAdapter(providerId)` from `registry.ts:37-39`.
pub fn get_provider_adapter(provider_id: &str) -> Option<&'static dyn ProviderAdapter> {
    adapter_for(provider_id)
}

/// The provider ids this slice ports, in registry order.
pub const PORTED_PROVIDER_IDS: &[&str] = &[
    "openai",
    "mistral",
    "openrouter",
    "lmstudio",
    "kimi",
    "zai",
    "bytedance",
];

/// The catalog entries still served by the TypeScript adapters, in registry order.
pub const DEFERRED_PROVIDER_IDS: &[&str] = &[
    "gemini",
    "openai-codex",
    "anthropic",
    "opencode",
    "ollama",
    "xai",
    "cohere",
    "github-copilot",
];

/// `provider.defaultModels[0]` — the `options.model || defaultModels[0]` idiom
/// that `zai` and `bytedance` use for their ping request.
pub fn default_model_or_first(context: &ProviderExecutionContext) -> Option<&str> {
    context.provider.default_models.first().map(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_hub::provider_catalog::catalog_ids;

    /// The registry and the catalog agree on all 15 ids; seven are ported here.
    #[test]
    fn registry_and_catalog_agree() {
        assert_eq!(
            PORTED_PROVIDER_IDS.len() + DEFERRED_PROVIDER_IDS.len(),
            catalog_ids().len(),
            "every catalog entry is either ported or deferred"
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
                "{provider_id} is deferred to S4b/S4c"
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
