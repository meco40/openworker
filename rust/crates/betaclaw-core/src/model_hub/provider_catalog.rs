//! Port of `src/server/model-hub/providerCatalog.ts`.
//!
//! The catalog has exactly 15 entries and the adapter registry
//! (`src/server/model-hub/Models/registry.ts`) has exactly 15 adapters, one per
//! entry — `tests/unit/model-hub/provider-registry.test.ts` asserts that
//! bijection. All fifteen providers are ported as of this slice: the registry
//! resolves every catalog id and no id is deferred any more
//! (`providers/mod.rs:141-157`, `:163`).
//!
//! The list is built once through [`LazyLock`] because `ProviderCatalogEntry`
//! owns `Vec` fields and `const` cannot construct them.
//!
//! `openai-codex` spreads `CODEX_MODEL_SEED` from
//! `src/server/model-hub/Models/openai-codex/constants.ts:12-34`. The seed is
//! duplicated here rather than imported so this module has no dependency on the
//! Codex adapter; the two lists must stay in sync.

use std::sync::LazyLock;

use super::types::{
    ProviderAuthMethod, ProviderCapability, ProviderCatalogEntry, ProviderEndpointType,
};

/// `CODEX_MODEL_SEED` from `src/server/model-hub/Models/openai-codex/constants.ts:12`.
pub const CODEX_MODEL_SEED: &[&str] = &[
    "gpt-5.6",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.4",
    "gpt-5.4-pro",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.3-codex",
    "gpt-5.2",
    "gpt-5.2-pro",
    "gpt-5.1",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5-pro",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4o-mini",
];

/// The literal shape of one `PROVIDER_CATALOG` element.
///
/// Mirrors the TypeScript object literal: the field order is the order in which
/// `providerCatalog.ts` writes them, and the three optional keys are only
/// emitted when the literal sets them.
struct EntrySpec {
    id: &'static str,
    name: &'static str,
    icon: &'static str,
    auth_methods: &'static [ProviderAuthMethod],
    endpoint_type: ProviderEndpointType,
    capabilities: &'static [ProviderCapability],
    default_models: &'static [&'static str],
    api_base_url: Option<&'static str>,
    docs_url: Option<&'static str>,
}

impl EntrySpec {
    fn build(self) -> ProviderCatalogEntry {
        ProviderCatalogEntry {
            id: self.id.to_string(),
            name: self.name.to_string(),
            icon: self.icon.to_string(),
            auth_methods: self.auth_methods.to_vec(),
            endpoint_type: self.endpoint_type,
            capabilities: self.capabilities.to_vec(),
            default_models: self
                .default_models
                .iter()
                .map(|model| (*model).to_string())
                .collect(),
            // No catalog entry sets `oauthConfigured`, so it is always absent; the
            // app/api route injects that flag per request.
            oauth_configured: None,
            api_base_url: self.api_base_url.map(str::to_string),
            docs_url: self.docs_url.map(str::to_string),
        }
    }
}

const CHAT: ProviderCapability = ProviderCapability::Chat;
const TOOLS: ProviderCapability = ProviderCapability::Tools;
const VISION: ProviderCapability = ProviderCapability::Vision;
const AUDIO: ProviderCapability = ProviderCapability::Audio;
const EMBEDDINGS: ProviderCapability = ProviderCapability::Embeddings;

const API_KEY: ProviderAuthMethod = ProviderAuthMethod::ApiKey;
const OAUTH: ProviderAuthMethod = ProviderAuthMethod::Oauth;
const NO_AUTH: ProviderAuthMethod = ProviderAuthMethod::None;

/// `PROVIDER_CATALOG` from `providerCatalog.ts:4-169`.
pub static PROVIDER_CATALOG: LazyLock<Vec<ProviderCatalogEntry>> = LazyLock::new(|| {
    vec![
        EntrySpec {
            id: "gemini",
            name: "Google Gemini",
            icon: "G",
            auth_methods: &[API_KEY],
            endpoint_type: ProviderEndpointType::GeminiNative,
            capabilities: &[CHAT, TOOLS, VISION, AUDIO, EMBEDDINGS],
            default_models: &["gemini-2.5-flash", "gemini-2.5-pro"],
            api_base_url: None,
            docs_url: Some("https://ai.google.dev/gemini-api/docs"),
        },
        EntrySpec {
            id: "openai",
            name: "OpenAI",
            icon: "O",
            auth_methods: &[API_KEY],
            endpoint_type: ProviderEndpointType::OpenAiNative,
            capabilities: &[CHAT, TOOLS, VISION, AUDIO, EMBEDDINGS],
            default_models: &["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"],
            api_base_url: Some("https://api.openai.com/v1"),
            docs_url: Some("https://platform.openai.com/docs/api-reference"),
        },
        EntrySpec {
            id: "openai-codex",
            name: "OpenAI Codex",
            icon: "OC",
            auth_methods: &[OAUTH],
            endpoint_type: ProviderEndpointType::OpenAiNative,
            capabilities: &[CHAT, TOOLS, VISION, AUDIO],
            default_models: CODEX_MODEL_SEED,
            api_base_url: Some("https://chatgpt.com/backend-api"),
            docs_url: Some("https://platform.openai.com/docs/guides/codex"),
        },
        EntrySpec {
            id: "anthropic",
            name: "Anthropic",
            icon: "A",
            auth_methods: &[API_KEY],
            endpoint_type: ProviderEndpointType::AnthropicNative,
            capabilities: &[CHAT, TOOLS, VISION],
            default_models: &["claude-sonnet-4-5", "claude-3-7-sonnet-latest"],
            api_base_url: Some("https://api.anthropic.com/v1"),
            docs_url: Some("https://docs.anthropic.com/en/api/messages"),
        },
        EntrySpec {
            id: "openrouter",
            name: "OpenRouter",
            icon: "R",
            auth_methods: &[API_KEY, OAUTH],
            endpoint_type: ProviderEndpointType::OpenAiCompatible,
            capabilities: &[CHAT, TOOLS, VISION, EMBEDDINGS],
            default_models: &["openai/gpt-4.1-mini", "anthropic/claude-3.7-sonnet"],
            api_base_url: Some("https://openrouter.ai/api/v1"),
            docs_url: Some("https://openrouter.ai/docs/quickstart"),
        },
        EntrySpec {
            id: "opencode",
            name: "OpenCode",
            icon: "OC",
            auth_methods: &[API_KEY],
            endpoint_type: ProviderEndpointType::OpenAiCompatible,
            capabilities: &[CHAT, TOOLS],
            default_models: &["big-pickle", "deepseek-v4-pro", "glm-5", "kimi-k2.5"],
            api_base_url: Some("https://opencode.ai/zen/v1"),
            docs_url: Some("https://opencode.ai/docs/zen"),
        },
        EntrySpec {
            id: "ollama",
            name: "Ollama (Local)",
            icon: "OL",
            auth_methods: &[NO_AUTH, API_KEY],
            endpoint_type: ProviderEndpointType::OpenAiCompatible,
            capabilities: &[CHAT, TOOLS, VISION, EMBEDDINGS],
            default_models: &["llama3.2", "qwen2.5-coder"],
            api_base_url: Some("http://localhost:11434/v1"),
            docs_url: Some("https://ollama.com/blog/openai-compatibility"),
        },
        EntrySpec {
            id: "lmstudio",
            name: "LM Studio (Local)",
            icon: "LM",
            auth_methods: &[NO_AUTH, API_KEY],
            endpoint_type: ProviderEndpointType::OpenAiCompatible,
            capabilities: &[CHAT, TOOLS, VISION],
            default_models: &["qwen2.5-coder-7b-instruct"],
            api_base_url: Some("http://localhost:1234/v1"),
            docs_url: Some("https://lmstudio.ai/docs/app/api/endpoints/openai"),
        },
        EntrySpec {
            id: "xai",
            name: "xAI",
            icon: "X",
            auth_methods: &[API_KEY],
            endpoint_type: ProviderEndpointType::XaiNative,
            capabilities: &[CHAT, TOOLS, VISION],
            default_models: &["grok-4", "grok-3"],
            api_base_url: Some("https://api.x.ai/v1"),
            docs_url: Some("https://docs.x.ai/docs/overview"),
        },
        EntrySpec {
            id: "mistral",
            name: "Mistral",
            icon: "M",
            auth_methods: &[API_KEY],
            endpoint_type: ProviderEndpointType::MistralNative,
            capabilities: &[CHAT, TOOLS, EMBEDDINGS],
            default_models: &["mistral-large-latest", "ministral-8b-latest"],
            api_base_url: Some("https://api.mistral.ai/v1"),
            docs_url: Some("https://docs.mistral.ai"),
        },
        EntrySpec {
            id: "cohere",
            name: "Cohere",
            icon: "C",
            auth_methods: &[API_KEY],
            endpoint_type: ProviderEndpointType::CohereNative,
            capabilities: &[CHAT, TOOLS, EMBEDDINGS],
            default_models: &["command-a-03-2025", "command-r-plus"],
            api_base_url: Some("https://api.cohere.com/v2"),
            docs_url: Some("https://docs.cohere.com"),
        },
        EntrySpec {
            id: "zai",
            name: "Z.AI",
            icon: "Z",
            auth_methods: &[API_KEY],
            endpoint_type: ProviderEndpointType::OpenAiCompatible,
            capabilities: &[CHAT, TOOLS, VISION],
            default_models: &["glm-4.5", "glm-4.5-air"],
            api_base_url: Some("https://api.z.ai/api/paas/v4"),
            docs_url: Some("https://docs.z.ai"),
        },
        EntrySpec {
            id: "kimi",
            name: "Kimi Code",
            icon: "K",
            auth_methods: &[API_KEY],
            endpoint_type: ProviderEndpointType::OpenAiCompatible,
            capabilities: &[CHAT, TOOLS],
            default_models: &["kimi-for-coding"],
            api_base_url: Some("https://api.kimi.com/coding/v1"),
            docs_url: Some("https://www.kimi.com/code/docs/en/"),
        },
        EntrySpec {
            id: "bytedance",
            name: "ByteDance ModelArk",
            icon: "B",
            auth_methods: &[API_KEY],
            endpoint_type: ProviderEndpointType::OpenAiCompatible,
            capabilities: &[CHAT, TOOLS],
            default_models: &["doubao-1-5-lite-32k-250115", "doubao-1-5-pro-32k-250115"],
            api_base_url: Some("https://ark.cn-beijing.volces.com/api/v3"),
            docs_url: Some("https://docs.byteplus.com/id/docs/ModelArk/Authentication"),
        },
        EntrySpec {
            id: "github-copilot",
            name: "GitHub Copilot / Models",
            icon: "GH",
            auth_methods: &[OAUTH, API_KEY],
            endpoint_type: ProviderEndpointType::GithubNative,
            capabilities: &[CHAT, ProviderCapability::CodePairing],
            default_models: &[],
            api_base_url: Some("https://api.github.com"),
            docs_url: Some("https://docs.github.com/en/rest/models"),
        },
    ]
    .into_iter()
    .map(EntrySpec::build)
    .collect()
});

/// All catalog entries in declaration order.
pub fn catalog() -> &'static [ProviderCatalogEntry] {
    PROVIDER_CATALOG.as_slice()
}

/// `PROVIDER_CATALOG.find((provider) => provider.id === providerId) ?? null`.
///
/// Repeated verbatim by `gateway.ts:27`, `modelFetcher.ts:8-10` and
/// `connectivity.ts:8-10`.
pub fn find_provider(provider_id: &str) -> Option<&'static ProviderCatalogEntry> {
    PROVIDER_CATALOG
        .iter()
        .find(|provider| provider.id == provider_id)
}

/// Every provider id in the catalog, in declaration order.
pub fn catalog_ids() -> Vec<&'static str> {
    PROVIDER_CATALOG
        .iter()
        .map(|provider| provider.id.as_str())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The catalog has 15 entries, not 16 — `provider-registry.test.ts` pairs it
    /// against the 15 adapters of `Models/registry.ts`.
    #[test]
    fn has_exactly_fifteen_entries_with_unique_ids() {
        assert_eq!(PROVIDER_CATALOG.len(), 15);
        let mut sorted = catalog_ids();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), 15, "duplicate provider id in the catalog");
    }

    #[test]
    fn matches_the_typescript_declaration_order() {
        assert_eq!(
            catalog_ids(),
            vec![
                "gemini",
                "openai",
                "openai-codex",
                "anthropic",
                "openrouter",
                "opencode",
                "ollama",
                "lmstudio",
                "xai",
                "mistral",
                "cohere",
                "zai",
                "kimi",
                "bytedance",
                "github-copilot",
            ]
        );
    }

    /// Every OpenAI-compatible entry uses the hyphen spelling; the underscore
    /// variant of the TS union is unused.
    #[test]
    fn no_entry_uses_the_underscore_spelling() {
        for provider in catalog() {
            assert_ne!(
                provider.endpoint_type,
                ProviderEndpointType::OpenAiCompatibleUnderscore,
                "{} must not use the underscore spelling",
                provider.id
            );
        }
    }

    #[test]
    fn codex_entry_spreads_the_seed() {
        let codex = find_provider("openai-codex").expect("openai-codex is in the catalog");
        assert_eq!(codex.default_models.len(), CODEX_MODEL_SEED.len());
        assert_eq!(codex.default_models[0], "gpt-5.6");
        assert_eq!(codex.default_models.last().unwrap(), "gpt-4o-mini");
        assert_eq!(
            codex.api_base_url.as_deref(),
            Some("https://chatgpt.com/backend-api")
        );
    }

    /// `gemini` is the only entry without `apiBaseUrl`, which is why
    /// `dispatchGatewayRequest` has an explicit `else` branch for it.
    #[test]
    fn only_gemini_has_no_api_base_url() {
        let without: Vec<&str> = catalog()
            .iter()
            .filter(|provider| provider.api_base_url.is_none())
            .map(|provider| provider.id.as_str())
            .collect();
        assert_eq!(without, vec!["gemini"]);
    }

    #[test]
    fn local_providers_allow_auth_method_none() {
        for id in ["ollama", "lmstudio"] {
            let provider = find_provider(id).expect("local provider");
            assert!(provider.has_auth_method(ProviderAuthMethod::None));
        }
    }

    /// `github-copilot` is the only entry whose `defaultModels` is empty.
    #[test]
    fn only_github_copilot_has_no_default_models() {
        let empty: Vec<&str> = catalog()
            .iter()
            .filter(|provider| provider.default_models.is_empty())
            .map(|provider| provider.id.as_str())
            .collect();
        assert_eq!(empty, vec!["github-copilot"]);
    }

    #[test]
    fn catalog_entry_serializes_with_camel_case_keys() {
        let value = serde_json::to_value(find_provider("openrouter").expect("openrouter"))
            .expect("serialize");
        assert_eq!(value["apiBaseUrl"], "https://openrouter.ai/api/v1");
        assert_eq!(value["endpointType"], "openai-compatible");
        assert_eq!(value["authMethods"][1], "oauth");
        assert_eq!(value["defaultModels"][0], "openai/gpt-4.1-mini");
        assert!(value.get("oauthConfigured").is_none());
    }
}
