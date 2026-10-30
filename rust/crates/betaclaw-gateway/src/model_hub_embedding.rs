//! Model Hub embedding provider for the World Model.
//!
//! Port of `resolveModelHubEmbeddingProvider` in
//! `src/server/world-model/embeddings/provider.ts:36-81`: without `EMBEDDING_*` settings
//! the World Model embeds through the active head of the `p1-embeddings` pipeline. The
//! repository is opened per call, as the TypeScript service reads it per call.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use futures_util::future::BoxFuture;
use serde_json::{json, Value};

use betaclaw_core::memory::mem0_embedder_sync::EMBEDDING_PROFILE_ID;
use betaclaw_core::memory::postgres::PostgresMemoryClient;
use betaclaw_core::model_hub::env::EnvOverrides;
use betaclaw_core::model_hub::http::HttpTransport;
use betaclaw_core::model_hub::openai_compatible::NOOP_ATTACHMENT_STORE;
use betaclaw_core::model_hub::repository::ModelHubRepository;
use betaclaw_core::model_hub::runtime::{get_model_hub_encryption_key, get_model_hub_service};
use betaclaw_core::model_hub::service::gateway::NoopObserver;
use betaclaw_core::model_hub::service::refresh::NoCodexRefresh;
use betaclaw_core::model_hub::service::types::{EmbeddingInput, EmbeddingOperation};
use betaclaw_core::model_hub::service::ServiceDependencies;
use betaclaw_core::model_hub::sqlite::SqliteModelHubRepository;
use betaclaw_core::model_hub::types::{PipelineModelEntry, PipelineStatus};
use betaclaw_core::world_model::db::{PgError, PgExecutor, QueryEmbedder};
use betaclaw_core::world_model::embeddings::provider::{
    configured_embedding_provider, generate_embedding_once,
};
use betaclaw_core::world_model::embeddings::provider::{EmbeddingError, EmbeddingProvider};

use crate::model_hub_transport::ReqwestTransport;

fn model_hub_db_path(env: &EnvOverrides) -> String {
    env.get("MODEL_HUB_DB_PATH")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| ".local/model-hub.db".to_string())
}

/// The active entry with the lowest priority (`provider.ts:39-42`).
fn pipeline_head(entries: Vec<PipelineModelEntry>) -> Option<PipelineModelEntry> {
    entries
        .into_iter()
        .filter(|entry| entry.status == PipelineStatus::Active)
        .min_by_key(|entry| entry.priority)
}

/// The numeric vector of a dispatch result (`provider.ts:57-73`).
fn embedding_values(result: &Value) -> Result<Vec<f64>, EmbeddingError> {
    if let Some(error) = result.get("error").and_then(Value::as_str) {
        if !error.trim().is_empty() {
            return Err(EmbeddingError::new(format!(
                "Model Hub embedding failed: {error}"
            )));
        }
    }
    let values = result
        .get("embedding")
        .and_then(|embedding| embedding.get("values"))
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty())
        .and_then(|values| {
            values
                .iter()
                .map(|value| value.as_f64().filter(|number| number.is_finite()))
                .collect::<Option<Vec<f64>>>()
        });
    values
        .ok_or_else(|| EmbeddingError::new("Model Hub embedding returned no valid numeric vector"))
}

struct ModelHubEmbedding {
    http: reqwest::Client,
    model: String,
    model_version: String,
}

impl ModelHubEmbedding {
    async fn embed(&self, text: &str) -> Result<Vec<f64>, EmbeddingError> {
        let env = EnvOverrides::new();
        let repository = SqliteModelHubRepository::open(&model_hub_db_path(&env))
            .map_err(|error| EmbeddingError::new(error.to_string()))?;
        let encryption_key = get_model_hub_encryption_key(&env)
            .map_err(|error| EmbeddingError::new(error.to_string()))?;
        let transport = ReqwestTransport::with_client(self.http.clone());
        let dependencies = ServiceDependencies {
            transport: &transport,
            attachments: &NOOP_ATTACHMENT_STORE,
            observer: &NoopObserver,
            env: &env,
            codex: &NoCodexRefresh,
        };
        let service = get_model_hub_service(&repository, dependencies);
        let input = EmbeddingInput {
            operation: EmbeddingOperation::EmbedContent,
            payload: json!({ "model": self.model, "input": text }),
        };
        let result = service
            .dispatch_embedding(&encryption_key, &input)
            .await
            .map_err(|error| EmbeddingError::new(format!("Model Hub embedding failed: {error}")))?;
        embedding_values(&result)
    }
}

impl EmbeddingProvider for ModelHubEmbedding {
    fn model(&self) -> &str {
        &self.model
    }

    fn model_version(&self) -> &str {
        &self.model_version
    }

    fn generate_embedding<'a>(
        &'a self,
        text: &'a str,
    ) -> BoxFuture<'a, Result<Vec<f64>, EmbeddingError>> {
        Box::pin(self.embed(text))
    }
}

/// The provider, or `None` without a Model Hub database or an active embedding model.
pub fn model_hub_embedding_provider(http: reqwest::Client) -> Option<Arc<dyn EmbeddingProvider>> {
    let env = EnvOverrides::new();
    let repository = SqliteModelHubRepository::open(&model_hub_db_path(&env)).ok()?;
    let head = pipeline_head(repository.list_pipeline_models(EMBEDDING_PROFILE_ID).ok()?)?;
    let model = head.model_name.trim().to_string();
    if model.is_empty() {
        return None;
    }
    let model_version = env
        .get("EMBEDDING_MODEL_VERSION")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or(head.id);
    Some(Arc::new(ModelHubEmbedding {
        http,
        model,
        model_version,
    }))
}

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);

/// `getConfiguredEmbeddingProvider()` + `generateEmbeddingOnce` of the semantic branch of
/// `searchMemories` (`postgresMemoryClient.ts:267-270`). The provider is resolved per
/// query, as TypeScript does, so a Model Hub change applies without a restart.
struct ConfiguredQueryEmbedder;

impl QueryEmbedder for ConfiguredQueryEmbedder {
    fn embed<'a>(&'a self, text: &'a str) -> BoxFuture<'a, Result<Option<Vec<f64>>, PgError>> {
        Box::pin(async move {
            let env: HashMap<String, String> = std::env::vars().collect();
            let transport: Arc<dyn HttpTransport> =
                Arc::new(ReqwestTransport::with_client(HTTP.clone()));
            let fallback = || model_hub_embedding_provider(HTTP.clone());
            let Some(provider) = configured_embedding_provider(&env, transport, Some(&fallback))
            else {
                return Ok(None);
            };
            generate_embedding_once(provider, text)
                .await
                .map(Some)
                .map_err(|error| PgError::new(error.message))
        })
    }
}

/// The canonical memory client with semantic search (`new PostgresMemoryClient()`).
pub fn canonical_memory_client(executor: Arc<dyn PgExecutor>) -> PostgresMemoryClient {
    PostgresMemoryClient::with_embedder(executor, Arc::new(ConfiguredQueryEmbedder))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_vector_comes_from_embedding_values() {
        let ok = json!({ "embedding": { "values": [0.5, -1.0, 2.0] } });
        assert_eq!(embedding_values(&ok).unwrap(), vec![0.5, -1.0, 2.0]);
    }

    #[test]
    fn an_error_or_an_empty_vector_is_rejected() {
        let failed = json!({ "error": "No active embedding model configured." });
        assert!(embedding_values(&failed)
            .unwrap_err()
            .message
            .contains("No active embedding model"));
        assert!(embedding_values(&json!({ "embedding": { "values": [] } })).is_err());
        assert!(embedding_values(&json!({ "embedding": { "values": ["x"] } })).is_err());
    }
}
