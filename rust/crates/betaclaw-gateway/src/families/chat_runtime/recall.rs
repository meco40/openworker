//! Chat recall: the `RecallPort`.
//!
//! Port of `src/server/channels/messages/service/recall/index.ts`. The core `RecallService`
//! runs the recall, and this adapter supplies its four sources. The chat source searches the
//! real messages store, the memory source is [`Memory`], the world-model source is
//! [`WorldRetrieval`], and Knowledge retrieval uses the shared SQLite repositories. Inline
//! Knowledge pre-ingest still reports its missing S7 runtime composition through the source
//! error path.

use std::collections::HashMap;
use std::future::{ready, Future};
use std::sync::{Arc, Mutex};

use betaclaw_core::channels::messages::service::execution::ports::PortResult;
use betaclaw_core::channels::messages::service::ports::{BoxFuture, RecallPort, StrictRecallReply};
use betaclaw_core::channels::messages::service::recall::index::RecallService;
use betaclaw_core::channels::messages::service::recall::ports::{
    KnowledgeRetrieveInput, RecallChatSearch, RecallKnowledge, RecallSourceError,
};
use betaclaw_core::channels::messages::service::recall::service_types::RecallSettings;
use betaclaw_core::channels::messages::service::types::is_strict_evidence_recall_enabled;
use betaclaw_core::knowledge::config::resolve_knowledge_config;
use betaclaw_core::knowledge::extractor::KnowledgeExtractor;
use betaclaw_core::knowledge::ingestion::service::{
    KnowledgeIngestionDeps, KnowledgeIngestionService, PersonaNameResolver,
};
use betaclaw_core::knowledge::ingestion::types::KnowledgeIngestionServiceOptions;
use betaclaw_core::knowledge::ingestion::world_model_adapter::PgWorldModelPort;
use betaclaw_core::knowledge::ingestion::world_model_port::{
    ObservationRecord, ProjectWindowRequest, ProjectWindowResult, ProjectionPendingInput,
    WorldModelCheckpointInput, WorldModelConfigView, WorldModelPort as IngestionWorldModelPort,
    WorldModelPortError, WorldModelProjection, WorldModelScope,
};
use betaclaw_core::knowledge::ingestion_cursor::{
    KnowledgeIngestionCursor, KnowledgeIngestionCursorOptions,
};
use betaclaw_core::knowledge::inline_ingestion_policy::is_knowledge_pre_ingest_on_recall_enabled;
use betaclaw_core::knowledge::repository::KnowledgeRepository;
use betaclaw_core::knowledge::retrieval::service::knowledge_retrieval_service::KnowledgeRetrievalService;
use betaclaw_core::knowledge::retrieval::types::{
    KnowledgeRetrievalInput, KnowledgeRetrievalServiceOptions, MessageLookupRepository,
    PersonaMemoryTypeLookup, RetrievalError, RetrievalKnowledgeRepository, RetrievalResult,
};
use betaclaw_core::knowledge::sqlite_knowledge_repository::{
    default_knowledge_db_path, SqliteKnowledgeRepository,
};
use betaclaw_core::memory::runtime::configured_provider;
use betaclaw_core::messages_store::trace::chat_recall_slow_threshold_ms;
use betaclaw_core::messages_store::types::Conversation;
use betaclaw_core::messages_store::{MessageRepositoryError, SearchMessagesOptions, StoredMessage};
use betaclaw_core::model_hub::env::EnvOverrides;
use betaclaw_core::world_model::config::WorldModelConfig;
use betaclaw_core::world_model::mem0_policy::{
    is_mem0_factual_write_blocked, is_mem0_preferences_only,
};

use super::memory::Memory;
use super::model::{ModelHubGateway, SharedModelHub};
use super::persona::PersonaStore;
use super::repo::{MessagesRepo, SharedMessagesRepo};
use super::world::{PgHandle, WorldRetrieval};

/// Knowledge retrieval and inline pre-ingest over the shared SQLite store.
pub struct Knowledge {
    repository: Mutex<Option<Arc<SqliteKnowledgeRepository>>>,
    database_path: String,
    messages: Arc<MessagesRepo>,
    personas: Arc<PersonaStore>,
    memory: Memory,
    model: Arc<ModelHubGateway>,
    world_model: WorldModelConfig,
    pg: Arc<PgHandle>,
    max_context_tokens: i64,
}

impl Knowledge {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        messages: Arc<MessagesRepo>,
        personas: Arc<PersonaStore>,
        memory: Memory,
        model: Arc<ModelHubGateway>,
        world_model: WorldModelConfig,
        pg: Arc<PgHandle>,
        max_context_tokens: i64,
        database_path: String,
    ) -> Self {
        Self {
            repository: Mutex::new(None),
            database_path,
            messages,
            personas,
            memory,
            model,
            world_model,
            pg,
            max_context_tokens,
        }
    }

    fn repository(&self) -> RetrievalResult<Arc<SqliteKnowledgeRepository>> {
        let mut repository = self
            .repository
            .lock()
            .map_err(|_| RetrievalError::new("knowledge repository lock poisoned"))?;
        if let Some(repository) = repository.as_ref() {
            return Ok(Arc::clone(repository));
        }
        let opened = Arc::new(
            SqliteKnowledgeRepository::open(&self.database_path)
                .map_err(|error| RetrievalError::new(error.to_string()))?,
        );
        *repository = Some(Arc::clone(&opened));
        Ok(opened)
    }
}

enum RecallIngestionWorldModel {
    Postgres(PgWorldModelPort),
    Disabled(WorldModelConfig),
}

impl IngestionWorldModelPort for RecallIngestionWorldModel {
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

impl RecallKnowledge for Knowledge {
    async fn ensure_ingested(
        &self,
        conversation_id: &str,
        user_id: &str,
        persona_id: &str,
    ) -> Result<(), RecallSourceError> {
        let conversation_id = conversation_id.trim();
        let user_id = user_id.trim();
        let persona_id = persona_id.trim();
        if conversation_id.is_empty() || user_id.is_empty() || persona_id.is_empty() {
            return Ok(());
        }

        let cursor_repo = SqliteKnowledgeRepository::open(&self.database_path)
            .map_err(|error| RecallSourceError(error.to_string()))?;
        let knowledge_repo = SqliteKnowledgeRepository::open(&self.database_path)
            .map_err(|error| RecallSourceError(error.to_string()))?;
        let cursor = KnowledgeIngestionCursor::new(
            self.messages.as_ref(),
            &cursor_repo,
            KnowledgeIngestionCursorOptions {
                min_messages_per_batch: Some(1.0),
            },
        );
        let world_model_active = self.world_model.enabled || self.world_model.e2e_enabled;
        let world_model = if world_model_active {
            match self.pg.executor() {
                Ok(executor) => {
                    RecallIngestionWorldModel::Postgres(PgWorldModelPort::new(executor))
                }
                Err(_) => RecallIngestionWorldModel::Disabled(self.world_model.clone()),
            }
        } else {
            RecallIngestionWorldModel::Disabled(self.world_model.clone())
        };
        let personas = self.personas.clone();
        let resolve_persona_name: Option<PersonaNameResolver> = Some(Box::new(move |id: &str| {
            personas
                .run(|repo| repo.get_persona(id))
                .ok()
                .flatten()
                .map(|p| p.name)
        }));
        let service = KnowledgeIngestionService::new(
            KnowledgeIngestionDeps {
                cursor,
                extractor: KnowledgeExtractor::with_model(SharedModelHub(self.model.clone())),
                knowledge_repository: knowledge_repo,
                world_model,
                memory_service: Some(Arc::new(self.memory.clone())),
                message_marker: Some(SharedMessagesRepo(self.messages.clone())),
                resolve_persona_name,
            },
            KnowledgeIngestionServiceOptions {
                min_messages_per_batch: Some(1.0),
            },
        );

        let conversation_messages = self
            .messages
            .with_store(|store| store.list_messages(conversation_id, 1000, None, Some(user_id)))
            .map_err(|error| RecallSourceError(error.to_string()))?;
        if conversation_messages.is_empty() {
            return Ok(());
        }
        let checkpoint = service
            .repository()
            .get_ingestion_checkpoint(conversation_id, user_id, Some(persona_id))
            .map_err(|error| RecallSourceError(error.to_string()))?
            .map(|value| value.last_seq)
            .unwrap_or(0);
        let pending_messages = conversation_messages
            .iter()
            .filter(|message| message.seq.unwrap_or(0) > checkpoint)
            .count();
        if pending_messages == 0 {
            return Ok(());
        }

        service
            .ingest_conversation_window(
                betaclaw_core::knowledge::ingestion::types::IngestConversationWindowInput {
                    conversation_id: conversation_id.to_string(),
                    user_id: user_id.to_string(),
                    persona_id: persona_id.to_string(),
                    workspace_id: None,
                    messages: conversation_messages,
                    summary_text: None,
                    persona_context: None,
                },
            )
            .await
            .map_err(|error| RecallSourceError(error.to_string()))
    }

    fn retrieve(
        &self,
        input: &KnowledgeRetrieveInput<'_>,
    ) -> impl Future<Output = Result<String, RecallSourceError>> + Send {
        let result = (|| {
            let repository = self
                .repository()
                .map_err(|error| RecallSourceError(error.to_string()))?;
            let options = KnowledgeRetrievalServiceOptions {
                max_context_tokens: self.max_context_tokens,
                knowledge_repository: repository.as_ref() as &dyn RetrievalKnowledgeRepository,
                memory_service: Some(&self.memory),
                memory_service_provider: None,
                message_repository: self.messages.as_ref(),
                get_persona_memory_type: Some(
                    self.personas.as_ref() as &dyn PersonaMemoryTypeLookup
                ),
            };
            let service = KnowledgeRetrievalService::new(&options);
            service
                .retrieve(&KnowledgeRetrievalInput {
                    user_id: input.user_id.to_string(),
                    persona_id: input.persona_id.to_string(),
                    conversation_id: Some(input.conversation_id.to_string()),
                    query: input.query.to_string(),
                    include_semantic: Some(input.include_semantic),
                    memory_types: None,
                })
                .map(|result| result.context)
                .map_err(|error| RecallSourceError(error.to_string()))
        })();
        ready(result)
    }
}

impl MessageLookupRepository for MessagesRepo {
    fn list_messages(
        &self,
        conversation_id: &str,
        limit: Option<i64>,
        before: Option<&str>,
        user_id: Option<&str>,
    ) -> RetrievalResult<Vec<StoredMessage>> {
        self.with_store(|store| {
            store
                .list_messages(conversation_id, limit.unwrap_or(200), before, user_id)
                .map_err(|error| RetrievalError::new(error.to_string()))
        })
    }
}

/// `searchMessages` over the messages store (FTS5).
pub struct ChatSearch(Arc<MessagesRepo>);

impl RecallChatSearch for ChatSearch {
    fn search_messages(
        &self,
        query: &str,
        options: &SearchMessagesOptions<'_>,
    ) -> Result<Vec<StoredMessage>, MessageRepositoryError> {
        self.0
            .with_store(|store| store.search_messages(query, options))
    }
}

type Service = RecallService<WorldRetrieval, Knowledge, Memory, ChatSearch>;

pub struct Recall {
    service: Arc<Service>,
}

impl Recall {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        repo: Arc<MessagesRepo>,
        env: &EnvOverrides,
        process_env: &HashMap<String, String>,
        world_model: &WorldModelConfig,
        world: WorldRetrieval,
        personas: Arc<PersonaStore>,
        memory: Memory,
        model: Arc<ModelHubGateway>,
        pg: Arc<PgHandle>,
    ) -> Self {
        let service = RecallService::new(
            world,
            Knowledge::new(
                repo.clone(),
                personas,
                memory.clone(),
                model,
                world_model.clone(),
                pg,
                resolve_knowledge_config(process_env).max_context_tokens,
                default_knowledge_db_path(),
            ),
            memory,
            Some(ChatSearch(repo)),
            settings(env, process_env, world_model),
        );
        Self {
            service: Arc::new(service),
        }
    }
}

/// The settings the TypeScript recall reads on each request (`recall/index.ts`, `config`).
fn settings(
    env: &EnvOverrides,
    process_env: &HashMap<String, String>,
    world_model: &WorldModelConfig,
) -> RecallSettings {
    let knowledge = resolve_knowledge_config(process_env);
    RecallSettings {
        knowledge_layer_enabled: knowledge.layer_enabled,
        knowledge_retrieval_enabled: knowledge.retrieval_enabled,
        knowledge_pre_ingest_on_recall: is_knowledge_pre_ingest_on_recall_enabled(process_env),
        world_model_canonical: world_model.mode.is_canonical(),
        memory_provider: configured_provider(process_env).provider_kind(),
        mem0_preferences_only: is_mem0_preferences_only(world_model),
        mem0_factual_write_blocked: is_mem0_factual_write_blocked(world_model),
        strict_evidence_enabled: is_strict_evidence_recall_enabled(env),
        slow_threshold_ms: chat_recall_slow_threshold_ms(),
    }
}

impl RecallPort for Recall {
    fn build_recall_context(
        &self,
        conversation: Conversation,
        user_input: String,
    ) -> BoxFuture<'_, PortResult<Option<String>>> {
        Box::pin(async move {
            Ok(self
                .service
                .build_recall_context(&conversation, &user_input)
                .await)
        })
    }

    fn maybe_learn_from_feedback(&self, conversation: Conversation, content: String) {
        // recall/index.ts: fire-and-forget. The learning is written by the memory source,
        // which is not wired, so it logs its failure and nothing else happens.
        let service = self.service.clone();
        tokio::spawn(async move {
            service
                .maybe_learn_from_feedback(&conversation, &content)
                .await;
        });
    }

    fn clear_conversation_state(&self, conversation_id: &str) {
        self.service.clear_conversation_state(conversation_id);
    }

    fn build_strict_evidence_reply(
        &self,
        conversation: Conversation,
        user_input: String,
    ) -> BoxFuture<'_, PortResult<Option<StrictRecallReply>>> {
        Box::pin(async move {
            Ok(self
                .service
                .build_strict_evidence_reply(&conversation, &user_input)
                .await
                .map(|reply| StrictRecallReply {
                    content: reply.content,
                    // An evidence reply always carries its metadata object.
                    metadata: Some(reply.metadata),
                }))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::Scratch;
    use super::*;
    use betaclaw_core::model_hub::http::UnreachableTransport;
    use betaclaw_core::world_model::config::resolve_world_model_config;

    #[tokio::test]
    async fn a_turn_without_persona_gets_no_recall_and_touches_no_source() {
        let scratch = Scratch::new();
        let repo = Arc::new(MessagesRepo::open(&scratch.path("messages.db")).expect("open"));
        let conversation = repo
            .run(|s| s.get_or_create_conversation("WebChat", "web-r", None, Some("user-1")))
            .expect("conversation");
        let env = HashMap::new();
        let world_model =
            betaclaw_core::world_model::config::resolve_world_model_config(&HashMap::new());
        let personas = Arc::new(
            PersonaStore::open(&scratch.path("personas.db"), &scratch.dir("personas"))
                .expect("personas"),
        );
        let pg = Arc::new(super::super::world::PgHandle::new(&world_model));
        let model = Arc::new(
            ModelHubGateway::open(
                &scratch.path("model-hub.db"),
                Arc::new(UnreachableTransport),
                EnvOverrides::new(),
            )
            .expect("model"),
        );
        let recall = Recall::new(
            repo,
            &EnvOverrides::new(),
            &env,
            &world_model,
            WorldRetrieval::new(
                world_model.clone(),
                pg.clone(),
                Arc::new(UnreachableTransport),
            ),
            personas,
            Memory::new(
                &env,
                &world_model,
                Arc::new(betaclaw_core::model_hub::http::UnreachableTransport),
                pg.clone(),
            ),
            model,
            pg,
        );

        // Without a persona the core service returns before any source is read.
        let context = recall
            .build_recall_context(conversation, "hallo".to_string())
            .await;
        assert_eq!(context, Ok(None));
    }

    #[tokio::test]
    async fn knowledge_source_uses_sqlite_retrieval_and_returns_empty_context_without_hits() {
        let scratch = Scratch::new();
        let env = HashMap::new();
        let world_model = resolve_world_model_config(&env);
        let pg = Arc::new(super::super::world::PgHandle::new(&world_model));
        let memory = Memory::new(
            &env,
            &world_model,
            Arc::new(UnreachableTransport),
            pg.clone(),
        );
        let messages = Arc::new(MessagesRepo::open(&scratch.path("messages.db")).expect("open"));
        let personas = Arc::new(
            PersonaStore::open(&scratch.path("personas.db"), &scratch.dir("personas"))
                .expect("personas"),
        );
        let model = Arc::new(
            ModelHubGateway::open(
                &scratch.path("model-hub.db"),
                Arc::new(UnreachableTransport),
                EnvOverrides::new(),
            )
            .expect("model"),
        );
        let knowledge = Knowledge::new(
            messages,
            personas,
            memory,
            model,
            world_model,
            pg,
            1200,
            scratch.path("knowledge.db"),
        );

        let result = knowledge
            .retrieve(&KnowledgeRetrieveInput {
                user_id: "user-1",
                persona_id: "persona-1",
                conversation_id: "conversation-1",
                query: "hallo",
                include_semantic: false,
            })
            .await;

        assert_eq!(result, Ok(String::new()));
        assert_eq!(
            knowledge
                .ensure_ingested("conversation-1", "user-1", "persona-1")
                .await,
            Ok(())
        );
    }
}
