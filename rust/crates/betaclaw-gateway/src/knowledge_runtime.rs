//! Process composition for the S7 Knowledge ingestion loop.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use crate::model_hub_transport::ReqwestTransport;
use crate::state::SharedState;
use betaclaw_core::knowledge::config::{resolve_knowledge_config, KnowledgeConfig};
use betaclaw_core::knowledge::extractor::{
    ExtractionModel, ExtractionModelError, KnowledgeExtractor,
};
use betaclaw_core::knowledge::ingestion::service::{
    KnowledgeIngestionDeps, KnowledgeIngestionService,
};
use betaclaw_core::knowledge::ingestion::types::{
    ExistingFactNode, FactStoreInput, MemoryFactError, MemoryFactService, MessageMemoryMarker,
};
use betaclaw_core::knowledge::ingestion::world_model_adapter::PgWorldModelPort;
use betaclaw_core::knowledge::ingestion::world_model_port::{
    ObservationRecord, ProjectWindowRequest, ProjectWindowResult, ProjectionPendingInput,
    WorldModelCheckpointInput, WorldModelConfigView, WorldModelPort, WorldModelPortError,
    WorldModelProjection, WorldModelScope,
};
use betaclaw_core::knowledge::ingestion_cursor::{
    IngestionMessageSource, KnowledgeIngestionCursor, KnowledgeIngestionCursorOptions,
};
use betaclaw_core::knowledge::runtime::{
    run_cleanup_pass, run_reconciliation_pass, MemorySnapshot, SnapshotEntry,
    MAINTENANCE_EVERY_NTH_TICK,
};
use betaclaw_core::knowledge::runtime_loop::{
    KnowledgeRuntimeLoop, KnowledgeRuntimeLoopOptions, LoopTask,
};
use betaclaw_core::knowledge::sqlite_knowledge_repository::{
    default_knowledge_db_path, SqliteKnowledgeRepository,
};
use betaclaw_core::memory::lifecycle::MemoryLifecycleBus;
use betaclaw_core::memory::mem0::{create_mem0_client_from_env, Mem0HttpClient};
use betaclaw_core::memory::runtime::{configured_provider, ConfiguredProvider};
use betaclaw_core::memory::service::{
    Mem0PolicyConfig, MemoryPageRequest, MemoryService, MemoryServiceDependencies,
    MemoryStoreInput, MemoryUpdateInput,
};
use betaclaw_core::memory::sqlite::client::SqliteMemoryClient;
use betaclaw_core::memory::types::{Mem0Client, MemoryType};
use betaclaw_core::messages_store::{
    Conversation, MessageRepositoryError, MessagesStore, StoredMessage,
};
use betaclaw_core::model_hub::env::EnvOverrides;
use betaclaw_core::model_hub::openai_compatible::NOOP_ATTACHMENT_STORE;
use betaclaw_core::model_hub::runtime::{get_model_hub_encryption_key, get_model_hub_service};
use betaclaw_core::model_hub::service::gateway::NoopObserver;
use betaclaw_core::model_hub::service::refresh::NoCodexRefresh;
use betaclaw_core::model_hub::service::ServiceDependencies;
use betaclaw_core::model_hub::sqlite::SqliteModelHubRepository;
use betaclaw_core::model_hub::types::{
    GatewayAuditContext, GatewayAuditKind, GatewayMessage, GatewayRequest,
};
use betaclaw_core::personas::repository::PersonaRepository;
use betaclaw_core::personas::PersonaWorkspace;
use betaclaw_core::world_model::config::{resolve_world_model_config, WorldModelConfig};
use betaclaw_core::world_model::db::PgExecutor;
use betaclaw_core::world_model::mem0_policy::is_mem0_factual_write_blocked;
use tracing::warn;

const MODEL_HUB_DB_FALLBACK: &str = "model-hub.db";
type KnowledgeTaskFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>;
type KnowledgeTask = fn(SharedState) -> KnowledgeTaskFuture;

/// Builds the process-owned loop using the TypeScript runtime's enable gate and interval.
pub fn build_knowledge_runtime_loop(state: SharedState) -> KnowledgeRuntimeLoop {
    let config = resolve_knowledge_config(&process_env());
    KnowledgeRuntimeLoop::new(KnowledgeRuntimeLoopOptions {
        enabled: knowledge_loop_enabled(&config),
        interval: Duration::from_millis(config.ingest_interval_ms.max(1) as u64),
        run_ingestion: task(state.clone(), run_ingestion_once),
        run_cleanup: Some(task(state.clone(), run_cleanup_once)),
        run_reconciliation: Some(task(state, run_reconciliation_once)),
        run_summarization: None,
        maintenance_every_nth_tick: MAINTENANCE_EVERY_NTH_TICK,
    })
}

fn knowledge_loop_enabled(config: &KnowledgeConfig) -> bool {
    config.layer_enabled && (config.episode_enabled || config.ledger_enabled)
}

fn task(state: SharedState, run: KnowledgeTask) -> LoopTask {
    Arc::new(move || run(Arc::clone(&state)))
}

fn run_ingestion_once(state: SharedState) -> KnowledgeTaskFuture {
    Box::pin(async move {
        let env = process_env();
        let config = resolve_knowledge_config(&env);
        if !knowledge_loop_enabled(&config) {
            return Ok(());
        }

        let world_model_config = resolve_world_model_config(&env);
        let world_model_active = world_model_config.enabled || world_model_config.e2e_enabled;
        let executor =
            if world_model_active || configured_provider(&env) == ConfiguredProvider::Postgres {
                Some(
                    state
                        .get_world_model_pg_executor(&world_model_config)
                        .await
                        .map_err(|error| error.to_string())?,
                )
            } else {
                None
            };
        let world_model = match (&executor, world_model_active) {
            (Some(executor), true) => {
                GatewayWorldModelPort::Postgres(PgWorldModelPort::new(Arc::clone(executor)))
            }
            _ => GatewayWorldModelPort::Disabled(world_model_config.clone()),
        };

        let message_source = SyncMessagesStore(Mutex::new(
            MessagesStore::open(&state.config.messages_db_path)
                .map_err(|error| error.to_string())?,
        ));
        let message_marker = SyncMessagesStore(Mutex::new(
            MessagesStore::open(&state.config.messages_db_path)
                .map_err(|error| error.to_string())?,
        ));
        let cursor_repository = SqliteKnowledgeRepository::open(&default_knowledge_db_path())
            .map_err(|error| error.to_string())?;
        let knowledge_repository = SqliteKnowledgeRepository::open(&default_knowledge_db_path())
            .map_err(|error| error.to_string())?;
        let cursor = KnowledgeIngestionCursor::new(
            &message_source,
            &cursor_repository,
            KnowledgeIngestionCursorOptions {
                min_messages_per_batch: Some(config.min_messages_per_batch as f64),
            },
        );
        let memory_service =
            build_memory_adapter(&state, &env, &world_model_config, executor).await;
        let resolve_persona_name = PersonaRepository::open_with_workspace(
            &state.config.personas_db_path,
            PersonaWorkspace::new(state.config.personas_root_path.clone()),
        )
        .ok()
        .map(|repository| {
            let repository = Mutex::new(repository);
            Box::new(move |id: &str| {
                repository
                    .lock()
                    .ok()?
                    .get_persona(id)
                    .ok()
                    .flatten()
                    .map(|persona| persona.name)
            }) as betaclaw_core::knowledge::ingestion::service::PersonaNameResolver
        });

        let model = KnowledgeModelHubExtractor {
            transport: ReqwestTransport::with_client(state.upstream.clone()),
            env: EnvOverrides::new(),
        };
        let service = KnowledgeIngestionService::new(
            KnowledgeIngestionDeps {
                cursor,
                extractor: KnowledgeExtractor::with_model(model),
                knowledge_repository,
                world_model,
                memory_service,
                message_marker: Some(message_marker),
                resolve_persona_name,
            },
            betaclaw_core::knowledge::ingestion::types::KnowledgeIngestionServiceOptions {
                min_messages_per_batch: Some(config.min_messages_per_batch as f64),
            },
        );

        let result = service
            .run_once()
            .await
            .map_err(|error| error.to_string())?;
        for error in result.errors {
            warn!(
                conversation_id = %error.conversation_id,
                persona_id = %error.persona_id,
                reason = %error.reason,
                "[knowledge] ingestion window failed"
            );
        }
        Ok(())
    })
}

fn run_cleanup_once(_state: SharedState) -> KnowledgeTaskFuture {
    Box::pin(async move {
        let repository = SqliteKnowledgeRepository::open(&default_knowledge_db_path())
            .map_err(|error| error.to_string())?;
        run_cleanup_pass(&repository, chrono::Utc::now().timestamp_millis())
            .map(|_| ())
            .map_err(|error| error.to_string())
    })
}

fn run_reconciliation_once(state: SharedState) -> KnowledgeTaskFuture {
    Box::pin(async move {
        let env = process_env();
        let world_model_config = resolve_world_model_config(&env);
        let repository = SqliteKnowledgeRepository::open(&default_knowledge_db_path())
            .map_err(|error| error.to_string())?;
        let memory = build_memory_adapter(&state, &env, &world_model_config, None).await;
        run_reconciliation_pass(&repository, memory.as_deref())
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    })
}

fn process_env() -> HashMap<String, String> {
    std::env::vars().collect()
}

async fn build_memory_adapter(
    state: &SharedState,
    env: &HashMap<String, String>,
    world_model_config: &WorldModelConfig,
    executor: Option<Arc<dyn PgExecutor>>,
) -> Option<Arc<KnowledgeMemoryAdapter>> {
    let transport: Arc<dyn betaclaw_core::model_hub::http::HttpTransport> =
        Arc::new(ReqwestTransport::with_client(state.upstream.clone()));
    let client: Result<Box<dyn Mem0Client + Send>, String> = match configured_provider(env) {
        ConfiguredProvider::Postgres => {
            let executor = match executor {
                Some(executor) => executor,
                None => match state.get_world_model_pg_executor(world_model_config).await {
                    Ok(executor) => executor,
                    Err(error) => return unavailable_memory(error.to_string()),
                },
            };
            Ok(Box::new(
                crate::model_hub_embedding::canonical_memory_client(executor),
            ))
        }
        ConfiguredProvider::Mem0 => create_mem0_client_from_env(env, transport)
            .map(|client| {
                client.map(|client: Mem0HttpClient| Box::new(client) as Box<dyn Mem0Client + Send>)
            })
            .map_err(|error| error.to_string())
            .and_then(|client| client.ok_or_else(|| "Mem0 provider is not configured".to_string())),
        ConfiguredProvider::Sqlite => SqliteMemoryClient::new()
            .map(|client| Box::new(client) as Box<dyn Mem0Client + Send>)
            .map_err(|error| error.to_string()),
    };
    match client {
        Ok(client) => Some(Arc::new(KnowledgeMemoryAdapter {
            client: Arc::new(Mutex::new(client)),
            lifecycle: state.memory_lifecycle_bus.clone(),
            policy: if world_model_config.mode.is_canonical() {
                Mem0PolicyConfig::canonical()
            } else if world_model_config.mem0_preferences_only {
                Mem0PolicyConfig::preferences_only()
            } else {
                Mem0PolicyConfig::legacy()
            },
        })),
        Err(error) => unavailable_memory(error),
    }
}

fn unavailable_memory<T>(reason: String) -> Option<T> {
    warn!(error = %reason, "[knowledge] memory provider unavailable; ingestion will use its degraded path");
    None
}

struct SyncMessagesStore(Mutex<MessagesStore>);

impl SyncMessagesStore {
    fn lock(&self) -> Result<MutexGuard<'_, MessagesStore>, MessageRepositoryError> {
        self.0
            .lock()
            .map_err(|_| MessageRepositoryError::Validation("messages store lock poisoned"))
    }
}

impl IngestionMessageSource for SyncMessagesStore {
    fn conversations_for_ingestion(
        &self,
        limit: i64,
    ) -> Result<Vec<Conversation>, MessageRepositoryError> {
        self.lock()?.list_conversations(limit, None)
    }

    fn messages_after_seq(
        &self,
        conversation_id: &str,
        after_seq: i64,
        limit: i64,
        user_id: &str,
    ) -> Result<Vec<StoredMessage>, MessageRepositoryError> {
        self.lock()?
            .list_messages_after_seq(conversation_id, after_seq, limit, Some(user_id))
    }
}

impl MessageMemoryMarker for SyncMessagesStore {
    fn mark_messages_memory_pending(
        &self,
        message_ids: &[&str],
        pending: bool,
        error_message: Option<&str>,
    ) -> Result<(), MessageRepositoryError> {
        self.lock()?
            .mark_messages_memory_pending(message_ids, pending, error_message)
    }
}

struct KnowledgeMemoryAdapter {
    client: Arc<Mutex<Box<dyn Mem0Client + Send>>>,
    lifecycle: MemoryLifecycleBus,
    policy: Mem0PolicyConfig,
}

impl MemoryFactService for KnowledgeMemoryAdapter {
    async fn store_fact(&self, input: FactStoreInput) -> Result<Option<String>, MemoryFactError> {
        let client = Arc::clone(&self.client);
        let lifecycle = self.lifecycle.clone();
        let policy = self.policy;
        tokio::task::spawn_blocking(move || {
            let dependencies = MemoryServiceDependencies::for_test()
                .with_publisher(&lifecycle)
                .with_policy(&policy);
            let client = client
                .lock()
                .map_err(|_| MemoryFactError("memory client lock poisoned".to_string()))?;
            let service = MemoryService::new(client.as_ref(), dependencies);
            service
                .store_memory(&MemoryStoreInput {
                    persona_id: input.persona_id,
                    workspace_id: None,
                    node_type: MemoryType::Fact,
                    content: input.content,
                    importance: input.importance as f64,
                    user_id: Some(input.user_id),
                    metadata: input.metadata,
                })
                .map(|node| Some(node.id))
                .map_err(|error| MemoryFactError(error.to_string()))
        })
        .await
        .map_err(|error| MemoryFactError(error.to_string()))?
    }

    async fn list_fact_nodes(
        &self,
        persona_id: &str,
        user_id: &str,
        page_size: usize,
    ) -> Result<Vec<ExistingFactNode>, MemoryFactError> {
        let client = Arc::clone(&self.client);
        let lifecycle = self.lifecycle.clone();
        let policy = self.policy;
        let persona_id = persona_id.to_string();
        let user_id = user_id.to_string();
        tokio::task::spawn_blocking(move || {
            let dependencies = MemoryServiceDependencies::for_test()
                .with_publisher(&lifecycle)
                .with_policy(&policy);
            let client = client
                .lock()
                .map_err(|_| MemoryFactError("memory client lock poisoned".to_string()))?;
            let service = MemoryService::new(client.as_ref(), dependencies);
            service
                .list_page(
                    &persona_id,
                    &MemoryPageRequest {
                        page: 1,
                        page_size: page_size.min(i64::MAX as usize) as i64,
                        query: None,
                        node_type: Some(MemoryType::Fact),
                    },
                    Some(&user_id),
                    None,
                )
                .map(|page| {
                    page.nodes
                        .into_iter()
                        .map(|node| ExistingFactNode {
                            id: node.id,
                            content: node.content,
                            metadata: node.metadata,
                        })
                        .collect()
                })
                .map_err(|error| MemoryFactError(error.to_string()))
        })
        .await
        .map_err(|error| MemoryFactError(error.to_string()))?
    }

    async fn update_memory_metadata(
        &self,
        persona_id: &str,
        memory_id: &str,
        user_id: &str,
        metadata: serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), MemoryFactError> {
        let client = Arc::clone(&self.client);
        let lifecycle = self.lifecycle.clone();
        let policy = self.policy;
        let persona_id = persona_id.to_string();
        let memory_id = memory_id.to_string();
        let user_id = user_id.to_string();
        tokio::task::spawn_blocking(move || {
            let dependencies = MemoryServiceDependencies::for_test()
                .with_publisher(&lifecycle)
                .with_policy(&policy);
            let client = client
                .lock()
                .map_err(|_| MemoryFactError("memory client lock poisoned".to_string()))?;
            let service = MemoryService::new(client.as_ref(), dependencies);
            service
                .update(
                    &persona_id,
                    &memory_id,
                    &MemoryUpdateInput {
                        metadata,
                        ..MemoryUpdateInput::default()
                    },
                    Some(&user_id),
                    None,
                )
                .map(|_| ())
                .map_err(|error| MemoryFactError(error.to_string()))
        })
        .await
        .map_err(|error| MemoryFactError(error.to_string()))?
    }
}

impl MemorySnapshot for KnowledgeMemoryAdapter {
    async fn snapshot(
        &self,
        persona_id: &str,
        user_id: &str,
    ) -> Result<Vec<SnapshotEntry>, MemoryFactError> {
        let client = Arc::clone(&self.client);
        let lifecycle = self.lifecycle.clone();
        let policy = self.policy;
        let persona_id = persona_id.to_string();
        let user_id = user_id.to_string();
        tokio::task::spawn_blocking(move || {
            let dependencies = MemoryServiceDependencies::for_test()
                .with_publisher(&lifecycle)
                .with_policy(&policy);
            let client = client
                .lock()
                .map_err(|_| MemoryFactError("memory client lock poisoned".to_string()))?;
            let service = MemoryService::new(client.as_ref(), dependencies);
            service
                .snapshot(Some(&persona_id), Some(&user_id), None)
                .map(|nodes| {
                    nodes
                        .into_iter()
                        .map(|node| SnapshotEntry {
                            id: node.id,
                            content: node.content,
                        })
                        .collect()
                })
                .map_err(|error| MemoryFactError(error.to_string()))
        })
        .await
        .map_err(|error| MemoryFactError(error.to_string()))?
    }
}

struct KnowledgeModelHubExtractor {
    transport: ReqwestTransport,
    env: EnvOverrides,
}

impl ExtractionModel for KnowledgeModelHubExtractor {
    async fn run_extraction_model(&self, prompt: &str) -> Result<String, ExtractionModelError> {
        let db_path = self
            .env
            .get("MODEL_HUB_DB_PATH")
            .filter(|path| !path.is_empty())
            .unwrap_or_else(|| MODEL_HUB_DB_FALLBACK.to_string());
        let repository = SqliteModelHubRepository::open(&db_path)
            .map_err(|error| ExtractionModelError(error.to_string()))?;
        let encryption_key = get_model_hub_encryption_key(&self.env)
            .map_err(|error| ExtractionModelError(error.to_string()))?;
        let dependencies = ServiceDependencies {
            transport: &self.transport,
            attachments: &NOOP_ATTACHMENT_STORE,
            observer: &NoopObserver,
            env: &self.env,
            codex: &NoCodexRefresh,
        };
        let service = get_model_hub_service(&repository, dependencies);
        let mut request = GatewayRequest::new("", vec![GatewayMessage::user(prompt)]);
        request.audit_context = Some(GatewayAuditContext {
            kind: GatewayAuditKind::KnowledgeExtraction,
            conversation_id: None,
            turn_seq: None,
            memory_context: None,
            task_id: None,
            step_id: None,
            node_id: None,
        });
        let response = service
            .dispatch_with_fallback("p1", &encryption_key, &request, None)
            .await
            .map_err(|error| ExtractionModelError(error.to_string()))?;
        if !response.ok {
            return Err(ExtractionModelError(format!(
                "Knowledge extraction model call failed: {}",
                response.error.as_deref().unwrap_or("unknown")
            )));
        }
        Ok(response.text)
    }
}

enum GatewayWorldModelPort {
    Postgres(PgWorldModelPort),
    Disabled(WorldModelConfig),
}

impl WorldModelPort for GatewayWorldModelPort {
    fn config(&self) -> WorldModelConfigView {
        match self {
            Self::Postgres(port) => port.config(),
            Self::Disabled(config) => WorldModelConfigView {
                enabled: config.enabled,
                e2e_enabled: config.e2e_enabled,
                required: config.mode.is_required(),
            },
        }
    }

    fn is_mem0_factual_write_blocked(&self) -> bool {
        match self {
            Self::Postgres(port) => port.is_mem0_factual_write_blocked(),
            Self::Disabled(config) => is_mem0_factual_write_blocked(config),
        }
    }

    fn normalize_extraction(
        &self,
        result: &betaclaw_core::knowledge::extractor::KnowledgeExtractionResult,
        scope: &WorldModelScope,
    ) -> Result<WorldModelProjection, WorldModelPortError> {
        match self {
            Self::Postgres(port) => port.normalize_extraction(result, scope),
            Self::Disabled(_) => Err(WorldModelPortError("World Model is disabled".to_string())),
        }
    }

    async fn project_window(
        &self,
        request: ProjectWindowRequest<'_>,
    ) -> Result<ProjectWindowResult, WorldModelPortError> {
        match self {
            Self::Postgres(port) => port.project_window(request).await,
            Self::Disabled(_) => Err(WorldModelPortError("World Model is disabled".to_string())),
        }
    }

    async fn enqueue_projection_pending(
        &self,
        input: ProjectionPendingInput,
    ) -> Result<(), WorldModelPortError> {
        match self {
            Self::Postgres(port) => port.enqueue_projection_pending(input).await,
            Self::Disabled(_) => Ok(()),
        }
    }

    async fn process_incoming_standing_intents(
        &self,
        scope: &WorldModelScope,
        text: &str,
    ) -> Result<(), WorldModelPortError> {
        match self {
            Self::Postgres(port) => port.process_incoming_standing_intents(scope, text).await,
            Self::Disabled(_) => Ok(()),
        }
    }

    async fn get_observation_by_id(
        &self,
        observation_id: &str,
        scope: &WorldModelScope,
    ) -> Result<Option<ObservationRecord>, WorldModelPortError> {
        match self {
            Self::Postgres(port) => port.get_observation_by_id(observation_id, scope).await,
            Self::Disabled(_) => Ok(None),
        }
    }

    async fn match_standing_intents(
        &self,
        observation: &ObservationRecord,
    ) -> Result<(), WorldModelPortError> {
        match self {
            Self::Postgres(port) => port.match_standing_intents(observation).await,
            Self::Disabled(_) => Ok(()),
        }
    }

    async fn upsert_ingestion_checkpoint(
        &self,
        input: WorldModelCheckpointInput,
    ) -> Result<(), WorldModelPortError> {
        match self {
            Self::Postgres(port) => port.upsert_ingestion_checkpoint(input).await,
            Self::Disabled(_) => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knowledge_worker_requires_layer_and_an_ingestion_target() {
        let defaults = KnowledgeConfig::default();
        assert!(!knowledge_loop_enabled(&defaults));
        assert!(!knowledge_loop_enabled(&KnowledgeConfig {
            layer_enabled: true,
            ..defaults.clone()
        }));
        assert!(knowledge_loop_enabled(&KnowledgeConfig {
            layer_enabled: true,
            episode_enabled: true,
            ..defaults
        }));
    }
}
