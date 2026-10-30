//! The long-term memory of the chat: the `RecallMemory` source and the `MemoryWritePort`.
//!
//! Port of `src/server/memory/runtime.ts` (`getMemoryService`) as used by
//! `recall/index.ts`, `recall/search/strict.ts`, `recall/learning/feedback.ts` and
//! `handlers/memoryHandler.ts`. The provider selection follows `routes::memory`, the
//! gateway's other memory composition: `MemoryRuntime::from_env` with a factory that
//! builds the SQLite client, the Mem0 client over the gateway transport, or the
//! PostgreSQL client over the World-Model pool (`world::PgHandle`).
//!
//! The runtime is built per call, as `routes::memory` builds it per request. Every
//! failure is returned as text, and the callers log it as the TypeScript does.

use std::collections::HashMap;
use std::future::{ready, Future};
use std::sync::Arc;

use betaclaw_core::channels::messages::service::execution::ports::PortResult;
use betaclaw_core::channels::messages::service::handlers::memory_handler::{
    MemoryStoreRequest, MemoryWritePort,
};
use betaclaw_core::channels::messages::service::ports::BoxFuture;
use betaclaw_core::channels::messages::service::recall::ports::{RecallMemory, RecallSourceError};
use betaclaw_core::knowledge::ingestion::types::{
    ExistingFactNode, FactStoreInput, MemoryFactError, MemoryFactService,
};
use betaclaw_core::knowledge::retrieval::types::{
    MemoryRecall as KnowledgeMemoryRecall, MemoryRecallMatch as KnowledgeMemoryRecallMatch,
    MemoryRecallNode as KnowledgeMemoryRecallNode,
    MemoryRecallOptions as KnowledgeMemoryRecallOptions,
    MemoryRecallResult as KnowledgeMemoryRecallResult, RecallMode as KnowledgeRecallMode,
    RetrievalError, RetrievalResult,
};
use betaclaw_core::memory::errors::MemoryError;
use betaclaw_core::memory::lifecycle::NoopLifecyclePublisher;
use betaclaw_core::memory::mem0::create_mem0_client_from_env;
use betaclaw_core::memory::runtime::{
    ConfiguredProvider, MemoryClientFactory, MemoryRuntime, MemoryRuntimeError,
};
use betaclaw_core::memory::service::{
    Mem0PolicyConfig, MemoryPageRequest, MemoryServiceDependencies, MemoryStoreInput,
    MemoryUpdateInput, RecallMode, RecallRequest,
};
use betaclaw_core::memory::sqlite::client::SqliteMemoryClient;
use betaclaw_core::memory::types::{
    Mem0Client, MemoryFeedbackSignal, MemoryRecallResult, MemoryType,
};
use betaclaw_core::model_hub::http::HttpTransport;
use betaclaw_core::world_model::config::WorldModelConfig;
use betaclaw_core::world_model::mem0_policy::is_mem0_factual_write_blocked;

use super::failed;
use super::world::PgHandle;

/// `CLIENT_UNAVAILABLE_MESSAGE` of `runtime.ts:136-139`, as `routes::memory` words it.
const CLIENT_UNAVAILABLE_MESSAGE: &str =
    "Invalid memory configuration: memory client unavailable. Set MEMORY_PROVIDER=postgres, mem0, or sqlite.";

/// The lifecycle events go nowhere: the chat has no subscriber for `memory.lifecycle.changed`.
static NOOP_PUBLISHER: NoopLifecyclePublisher = NoopLifecyclePublisher;

/// The provider factory of `resolveMemoryClient` (`runtime.ts:112-124`).
struct ChatMemoryClientFactory<'a> {
    transport: Arc<dyn HttpTransport>,
    pg: &'a PgHandle,
}

impl MemoryClientFactory for ChatMemoryClientFactory<'_> {
    fn create(
        &self,
        provider: ConfiguredProvider,
        env: &HashMap<String, String>,
    ) -> Result<Box<dyn Mem0Client>, MemoryRuntimeError> {
        match provider {
            ConfiguredProvider::Sqlite => SqliteMemoryClient::new()
                .map(|client| Box::new(client) as Box<dyn Mem0Client>)
                .map_err(|error| MemoryRuntimeError::Configuration(error.to_string())),
            ConfiguredProvider::Mem0 => {
                match create_mem0_client_from_env(env, self.transport.clone()) {
                    Ok(Some(client)) => Ok(Box::new(client) as Box<dyn Mem0Client>),
                    Ok(None) => Err(MemoryRuntimeError::Configuration(
                        CLIENT_UNAVAILABLE_MESSAGE.to_string(),
                    )),
                    Err(error) => Err(MemoryRuntimeError::Configuration(error.to_string())),
                }
            }
            ConfiguredProvider::Postgres => {
                let executor = self
                    .pg
                    .executor()
                    .map_err(|error| MemoryRuntimeError::Configuration(error.to_string()))?;
                Ok(
                    Box::new(crate::model_hub_embedding::canonical_memory_client(
                        executor,
                    )) as Box<dyn Mem0Client>,
                )
            }
        }
    }
}

struct Inner {
    env: HashMap<String, String>,
    transport: Arc<dyn HttpTransport>,
    pg: Arc<PgHandle>,
    policy: Mem0PolicyConfig,
    factual_write_blocked: bool,
}

/// The memory source of the chat. Cheap to clone: recall and the save command share one.
#[derive(Clone)]
pub struct Memory {
    inner: Arc<Inner>,
}

impl Memory {
    /// `env` is the process environment (`MEMORY_PROVIDER`, `MEM0_*`, ...). `world_model`
    /// gives the Mem0 policy flags (`getWorldModelConfig()`, `mem0Policy.ts`).
    pub fn new(
        env: &HashMap<String, String>,
        world_model: &WorldModelConfig,
        transport: Arc<dyn HttpTransport>,
        pg: Arc<PgHandle>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                env: env.clone(),
                transport,
                pg,
                policy: Mem0PolicyConfig {
                    mem0_preferences_only: world_model.mem0_preferences_only,
                    mode_canonical: world_model.mode.is_canonical(),
                },
                factual_write_blocked: is_mem0_factual_write_blocked(world_model),
            }),
        }
    }

    /// Builds the runtime for this call and runs `operation` on its service.
    fn with_service<T>(
        &self,
        operation: impl FnOnce(
            &betaclaw_core::memory::service::MemoryService<'_>,
        ) -> Result<T, MemoryError>,
    ) -> Result<T, String> {
        let inner = &*self.inner;
        let factory = ChatMemoryClientFactory {
            transport: inner.transport.clone(),
            pg: &inner.pg,
        };
        let runtime = MemoryRuntime::from_env(&inner.env, &factory).map_err(|e| e.to_string())?;
        let dependencies = MemoryServiceDependencies {
            publisher: &NOOP_PUBLISHER,
            policy: &inner.policy,
            counter: None,
        };
        let service = runtime
            .memory_service(dependencies)
            .map_err(|e| e.to_string())?;
        operation(&service).map_err(|e| e.to_string())
    }
}

impl RecallMemory for Memory {
    fn recall_detailed(
        &self,
        persona_id: &str,
        query: &str,
        limit: i64,
        user_id: &str,
        options: &RecallRequest,
    ) -> impl Future<Output = Result<MemoryRecallResult, RecallSourceError>> + Send {
        let result = self
            .with_service(|service| {
                service.recall_detailed(
                    persona_id,
                    query,
                    Some(limit),
                    Some(user_id),
                    Some(options),
                )
            })
            .map_err(RecallSourceError);
        ready(result)
    }

    fn register_feedback(
        &self,
        persona_id: &str,
        node_ids: &[String],
        signal: MemoryFeedbackSignal,
        user_id: &str,
    ) -> impl Future<Output = Result<(), RecallSourceError>> + Send {
        let result = self
            .with_service(|service| {
                service.register_feedback(persona_id, node_ids, signal, Some(user_id), None)
            })
            .map(|_| ())
            .map_err(RecallSourceError);
        ready(result)
    }

    fn store_memory(
        &self,
        input: &MemoryStoreInput,
    ) -> impl Future<Output = Result<(), RecallSourceError>> + Send {
        let result = self
            .with_service(|service| service.store_memory(input))
            .map(|_| ())
            .map_err(RecallSourceError);
        ready(result)
    }
}

impl KnowledgeMemoryRecall for Memory {
    fn recall_detailed(
        &self,
        persona_id: &str,
        query: &str,
        limit: Option<i64>,
        user_id: Option<&str>,
        options: Option<&KnowledgeMemoryRecallOptions>,
    ) -> RetrievalResult<KnowledgeMemoryRecallResult> {
        let request = options.map(|options| RecallRequest {
            mode: match options.mode {
                Some(KnowledgeRecallMode::Lexical) => RecallMode::Lexical,
                Some(KnowledgeRecallMode::Semantic) | None => RecallMode::Semantic,
            },
            memory_types: options.memory_types.clone(),
            workspace_id: None,
        });
        self.with_service(|service| {
            service.recall_detailed(persona_id, query, limit, user_id, request.as_ref())
        })
        .map(|result| KnowledgeMemoryRecallResult {
            context: result.context,
            matches: result
                .matches
                .into_iter()
                .map(|matched| KnowledgeMemoryRecallMatch {
                    node: KnowledgeMemoryRecallNode {
                        id: matched.node.id,
                        content: Some(matched.node.content),
                    },
                })
                .collect(),
        })
        .map_err(RetrievalError::new)
    }
}

impl MemoryWritePort for Memory {
    fn is_mem0_factual_write_blocked(&self) -> bool {
        self.inner.factual_write_blocked
    }

    /// `getMemoryService().storeMemory(...)` of `memoryHandler.ts`.
    fn store_memory<'a>(&'a self, request: MemoryStoreRequest) -> BoxFuture<'a, PortResult<()>> {
        let result = (|| {
            let node_type = MemoryType::parse(request.memory_type)
                .ok_or_else(|| failed(format!("unknown memory type: {}", request.memory_type)))?;
            let input = MemoryStoreInput {
                persona_id: request.persona_id,
                workspace_id: None,
                node_type,
                content: request.content,
                importance: f64::from(request.importance),
                user_id: Some(request.user_id),
                metadata: request.metadata,
            };
            self.with_service(|service| service.store_memory(&input))
                .map(|_| ())
                .map_err(failed)
        })();
        Box::pin(ready(result))
    }
}

impl MemoryFactService for Memory {
    fn store_fact(
        &self,
        input: FactStoreInput,
    ) -> impl Future<Output = Result<Option<String>, MemoryFactError>> + Send {
        let result = self
            .with_service(|service| {
                service.store_memory(&MemoryStoreInput {
                    persona_id: input.persona_id,
                    workspace_id: None,
                    node_type: MemoryType::Fact,
                    content: input.content,
                    importance: input.importance as f64,
                    user_id: Some(input.user_id),
                    metadata: input.metadata,
                })
            })
            .map(|node| Some(node.id))
            .map_err(MemoryFactError);
        ready(result)
    }

    fn list_fact_nodes(
        &self,
        persona_id: &str,
        user_id: &str,
        page_size: usize,
    ) -> impl Future<Output = Result<Vec<ExistingFactNode>, MemoryFactError>> + Send {
        let result = self
            .with_service(|service| {
                service.list_page(
                    persona_id,
                    &MemoryPageRequest {
                        page: 1,
                        page_size: page_size.min(i64::MAX as usize) as i64,
                        query: None,
                        node_type: Some(MemoryType::Fact),
                    },
                    Some(user_id),
                    None,
                )
            })
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
            .map_err(MemoryFactError);
        ready(result)
    }

    fn update_memory_metadata(
        &self,
        persona_id: &str,
        memory_id: &str,
        user_id: &str,
        metadata: serde_json::Map<String, serde_json::Value>,
    ) -> impl Future<Output = Result<(), MemoryFactError>> + Send {
        let result = self
            .with_service(|service| {
                service.update(
                    persona_id,
                    memory_id,
                    &MemoryUpdateInput {
                        metadata,
                        ..MemoryUpdateInput::default()
                    },
                    Some(user_id),
                    None,
                )
            })
            .map(|_| ())
            .map_err(MemoryFactError);
        ready(result)
    }
}
