//! Slice S13: Process composition for `betaclaw-scheduler`.
//!
//! Mirrors `scheduler.ts:1-104` and `src/server/automation/runtime.ts:1-158`:
//! - Startup guards (`assert_production_auth_config_from_env`,
//!   `assert_production_world_model_config`, `assert_memory_runtime_configuration`)
//! - `AutomationRuntime` (15 s default tick + SQLite lease in `automation_scheduler_lease`)
//! - `KnowledgeRuntimeLoop` (`build_knowledge_runtime_loop`)
//! - World-Model workers (`OutboxDispatcher`, `run_prospective_runtime_once`,
//!   `EmbeddingWorker`, `ProjectionRetryWorker`)
//! - Ordered graceful shutdown on `SIGTERM` / `SIGINT`.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use betaclaw_core::auth::production_guard::assert_production_auth_config_from_env;
use betaclaw_core::automation::error::AutomationError;
use betaclaw_core::automation::service::{AutomationService, ProcessTickOptions, PromptRunner};
use betaclaw_core::channels::adapters::discord::deliver_discord;
use betaclaw_core::channels::adapters::imessage::deliver_imessage;
use betaclaw_core::channels::adapters::slack::deliver_slack;
use betaclaw_core::channels::adapters::telegram::api::TelegramApi;
use betaclaw_core::channels::adapters::telegram::outbound::{TelegramSender, TelegramTextOptions};
use betaclaw_core::channels::adapters::whatsapp::deliver_whatsapp;
use betaclaw_core::channels::pairing::credentials::{ChannelCredentialStore, ChannelEnv};
use betaclaw_core::knowledge::entity_extractor::EntityExtractor;
use betaclaw_core::knowledge::event_extractor::ExtractedEvent;
use betaclaw_core::knowledge::event_types::SpeakerRole;
use betaclaw_core::knowledge::extractor::{KnowledgeExtractionResult, KnowledgeMeetingLedger};
use betaclaw_core::knowledge::ingestion::entity_extractor::{
    store_entities, EntityProcessingContext,
};
use betaclaw_core::knowledge::ingestion::episode_extractor::{
    upsert_episode_and_ledger, EpisodeInput,
};
use betaclaw_core::knowledge::ingestion::event_extractor::{store_events, EventProcessingContext};
use betaclaw_core::knowledge::ingestion::fact_extractor::{process_facts, process_meeting_ledger};
use betaclaw_core::knowledge::ingestion_cursor::IngestionWindow;
use betaclaw_core::knowledge::repository::KnowledgeSourceRef;
use betaclaw_core::knowledge::runtime_loop::KnowledgeRuntimeLoop;
use betaclaw_core::knowledge::sqlite_knowledge_repository::{
    default_knowledge_db_path, SqliteKnowledgeRepository,
};
use betaclaw_core::memory::mem0::{create_mem0_client_from_env, Mem0HttpClient};
use betaclaw_core::memory::postgres::PostgresMemoryClient;
use betaclaw_core::memory::runtime::{
    assert_memory_runtime_configuration, configured_provider, ConfiguredProvider,
};
use betaclaw_core::memory::service::{
    Mem0PolicyConfig, MemoryService, MemoryServiceDependencies, MemoryStoreInput,
};
use betaclaw_core::memory::sqlite::client::SqliteMemoryClient;
use betaclaw_core::memory::types::{Mem0Client, MemoryType};
use betaclaw_core::messages_store::types::{ChannelBinding, ChannelType, StoredMessage};
use betaclaw_core::messages_store::MessagesStore;
use betaclaw_core::model_hub::http::HttpTransport;
use betaclaw_core::personas::telegram_bots::PersonaTelegramBotRegistry;
use betaclaw_core::world_model::config::{resolve_world_model_config, WorldModelConfig};
use betaclaw_core::world_model::db::{BoxFuture, PgExecutor};
use betaclaw_core::world_model::embeddings::embedding_worker::{
    EmbeddingWorker, EmbeddingWorkerDeps, EmbeddingWorkerHandle, ScopeProvider,
};
use betaclaw_core::world_model::embeddings::provider::configured_embedding_provider;
use betaclaw_core::world_model::graphiti::client::{GraphitiClientConfig, GraphitiRestClient};
use betaclaw_core::world_model::graphiti::projector::create_graphiti_projector_handler;
use betaclaw_core::world_model::mem0_policy::is_mem0_factual_write_blocked;
use betaclaw_core::world_model::migrations::MigrationSettings;
use betaclaw_core::world_model::outbox_dispatcher::{OutboxDispatcher, OutboxHandlerPorts};
use betaclaw_core::world_model::production_guard::{
    assert_production_world_model_config, ProductionGuardEnv,
};
use betaclaw_core::world_model::runtime::prospective_runtime::{
    run_prospective_runtime_once, ProspectiveRuntimeDeps,
};
use betaclaw_core::world_model::runtime::scope_discovery::list_runtime_world_model_scopes;
use betaclaw_core::world_model::services::proactive_channel_delivery::{
    create_proactive_intent_fired_handler, create_proactive_question_handler, Clock,
    DeliverOutbound, ListChannelBindings, OutboundReceipt,
};
use betaclaw_core::world_model::services::projection_retry_worker::{
    default_projection_retry_handlers, KnowledgeRetrySink, MarkMessagesMemoryPending,
    MemoryFactSink, ProjectionRetryWorker, ProjectionRetryWorkerHandle, RetryMemoryFact,
    SqliteKnowledgeRetry,
};
use serde_json::{json, Value};

use crate::background::BackgroundTask;
use crate::families::channels_wire::store::ChannelDb;
use crate::families::tasks;
use crate::knowledge_runtime::build_knowledge_runtime_loop;
use crate::model_hub_transport::ReqwestTransport;
use crate::state::SharedState;

/// Default tick interval of `AutomationRuntime` (`src/server/automation/runtime.ts:31`).
pub const DEFAULT_AUTOMATION_TICK_INTERVAL_MS: u64 = 15_000;
/// Default lease TTL of `AutomationRuntime` (`src/server/automation/runtime.ts:32`).
pub const DEFAULT_AUTOMATION_LEASE_TTL_MS: i64 = 30_000;
/// Default max attempts of `AutomationRuntime` (`src/server/automation/runtime.ts:33`).
pub const DEFAULT_AUTOMATION_MAX_ATTEMPTS: i64 = 3;
/// Default auto-pause failure threshold (`src/server/automation/runtime.ts:35`).
pub const DEFAULT_AUTOMATION_AUTO_PAUSE_FAILURES: i64 = 10;
/// Default retry backoff schedule (`src/server/automation/runtime.ts:34`).
pub const DEFAULT_AUTOMATION_RETRY_BACKOFF_MS: [u64; 3] = [30_000, 120_000, 600_000];
/// Default interval for the World-Model embedding and projection retry workers (`scheduler.ts:92-94`).
pub const DEFAULT_WORLD_MODEL_WORKER_INTERVAL_MS: u64 = 30_000;

/// Options of [`AutomationRuntime`], mirroring `AutomationRuntimeOptions` in
/// `src/server/automation/runtime.ts:4-11` and `131-148`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationRuntimeOptions {
    pub instance_id: String,
    pub tick_interval_ms: u64,
    pub lease_ttl_ms: i64,
    pub max_attempts: i64,
    pub retry_backoff_ms: Vec<u64>,
    pub auto_pause_failure_threshold: i64,
}

impl AutomationRuntimeOptions {
    pub fn from_env(env: &HashMap<String, String>) -> Self {
        let instance_id = env
            .get("SCHEDULER_INSTANCE_ID")
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("scheduler-{}", std::process::id()));
        let tick_interval_ms = env
            .get("AUTOMATION_TICK_INTERVAL_MS")
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|&v| v > 0)
            .unwrap_or(DEFAULT_AUTOMATION_TICK_INTERVAL_MS);
        let lease_ttl_ms = env
            .get("AUTOMATION_LEASE_TTL_MS")
            .and_then(|v| v.trim().parse::<i64>().ok())
            .filter(|&v| v > 0)
            .unwrap_or(DEFAULT_AUTOMATION_LEASE_TTL_MS);
        let max_attempts = env
            .get("AUTOMATION_MAX_ATTEMPTS")
            .and_then(|v| v.trim().parse::<i64>().ok())
            .filter(|&v| v > 0)
            .unwrap_or(DEFAULT_AUTOMATION_MAX_ATTEMPTS);
        let retry_backoff_ms = env
            .get("AUTOMATION_RETRY_BACKOFF_MS")
            .map(String::as_str)
            .unwrap_or("30000,120000,600000")
            .split(',')
            .filter_map(|raw| raw.trim().parse::<i64>().ok())
            .filter(|&value| value > 0)
            .map(|value| value as u64)
            .collect::<Vec<_>>();
        let retry_backoff_ms = if retry_backoff_ms.is_empty() {
            DEFAULT_AUTOMATION_RETRY_BACKOFF_MS.to_vec()
        } else {
            retry_backoff_ms
        };
        let auto_pause_failure_threshold = env
            .get("AUTOMATION_AUTO_PAUSE_FAILURES")
            .and_then(|v| v.trim().parse::<i64>().ok())
            .filter(|&v| v > 0)
            .unwrap_or(DEFAULT_AUTOMATION_AUTO_PAUSE_FAILURES);

        Self {
            instance_id,
            tick_interval_ms,
            lease_ttl_ms,
            max_attempts,
            retry_backoff_ms,
            auto_pause_failure_threshold,
        }
    }
}

/// Trait abstracting `AutomationService` lease + tick operations so [`AutomationRuntime`]
/// can drive either `Arc<tasks::Services>` or a standalone `Arc<AutomationService<R>>`.
pub trait AutomationTickPort: Send + Sync {
    fn acquire_lease(
        &self,
        instance_id: &str,
        ttl_ms: i64,
        now_iso: &str,
    ) -> Result<bool, AutomationError>;

    fn release_lease(&self, instance_id: &str) -> Result<(), AutomationError>;

    fn process_tick<'a>(
        &'a self,
        options: &'a ProcessTickOptions,
    ) -> Pin<Box<dyn Future<Output = Result<(), AutomationError>> + Send + 'a>>;
}

impl<R: PromptRunner + 'static> AutomationTickPort for AutomationService<R> {
    fn acquire_lease(
        &self,
        instance_id: &str,
        ttl_ms: i64,
        now_iso: &str,
    ) -> Result<bool, AutomationError> {
        AutomationService::acquire_lease(self, instance_id, ttl_ms, now_iso)
    }

    fn release_lease(&self, instance_id: &str) -> Result<(), AutomationError> {
        AutomationService::release_lease(self, instance_id)
    }

    fn process_tick<'a>(
        &'a self,
        options: &'a ProcessTickOptions,
    ) -> Pin<Box<dyn Future<Output = Result<(), AutomationError>> + Send + 'a>> {
        Box::pin(AutomationService::process_tick(self, options))
    }
}

impl AutomationTickPort for tasks::Services {
    fn acquire_lease(
        &self,
        instance_id: &str,
        ttl_ms: i64,
        now_iso: &str,
    ) -> Result<bool, AutomationError> {
        self.automation.acquire_lease(instance_id, ttl_ms, now_iso)
    }

    fn release_lease(&self, instance_id: &str) -> Result<(), AutomationError> {
        self.automation.release_lease(instance_id)
    }

    fn process_tick<'a>(
        &'a self,
        options: &'a ProcessTickOptions,
    ) -> Pin<Box<dyn Future<Output = Result<(), AutomationError>> + Send + 'a>> {
        Box::pin(self.automation.process_tick(options))
    }
}

/// Port of `AutomationRuntime` (`src/server/automation/runtime.ts:19-77`).
pub struct AutomationRuntime {
    service: Arc<dyn AutomationTickPort>,
    options: AutomationRuntimeOptions,
    timer: Mutex<Option<BackgroundTask>>,
}

impl AutomationRuntime {
    pub fn new(service: Arc<dyn AutomationTickPort>, options: AutomationRuntimeOptions) -> Self {
        Self {
            service,
            options,
            timer: Mutex::new(None),
        }
    }

    pub fn instance_id(&self) -> &str {
        &self.options.instance_id
    }

    /// `runOnce()` (`src/server/automation/runtime.ts:51-68`).
    /// Returns `Ok(true)` when the lease was acquired and the tick ran, `Ok(false)` when
    /// another scheduler holds the lease.
    pub async fn run_once(&self) -> Result<bool, AutomationError> {
        let now_iso = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let has_lease = self.service.acquire_lease(
            &self.options.instance_id,
            self.options.lease_ttl_ms,
            &now_iso,
        )?;
        if !has_lease {
            return Ok(false);
        }

        let tick_options = ProcessTickOptions {
            now_iso: Some(now_iso),
            max_attempts: self.options.max_attempts,
            retry_backoff_ms: self.options.retry_backoff_ms.clone(),
            auto_pause_failure_threshold: self.options.auto_pause_failure_threshold,
        };
        self.service.process_tick(&tick_options).await?;
        Ok(true)
    }

    /// `start()` (`src/server/automation/runtime.ts:38-49`).
    pub fn start(self: &Arc<Self>) {
        let mut guard = self.timer.lock().unwrap_or_else(PoisonError::into_inner);
        if guard.is_some() {
            return;
        }
        let (stop, mut signal) = tokio::sync::watch::channel(false);
        let runtime = Arc::clone(self);
        let interval = Duration::from_millis(self.options.tick_interval_ms.max(1));
        let task = tokio::spawn(async move {
            if let Err(error) = runtime.run_once().await {
                tracing::error!(error = %error, "[automation] runtime tick failed");
            }
            loop {
                tokio::select! {
                    _ = signal.changed() => break,
                    _ = tokio::time::sleep(interval) => {}
                }
                if let Err(error) = runtime.run_once().await {
                    tracing::error!(error = %error, "[automation] runtime tick failed");
                }
            }
        });
        *guard = Some(BackgroundTask { stop, task });
    }

    /// `stop()` (`src/server/automation/runtime.ts:70-76`). Waits for an in-flight tick
    /// before the lease is released, so a second scheduler never runs the same tick.
    pub async fn stop(&self) {
        let task = self
            .timer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(task) = task {
            task.stop().await;
        }
        let _ = self.service.release_lease(&self.options.instance_id);
    }
}

/// Startup guards from `scheduler.ts:66-69`.
pub fn assert_scheduler_startup_guards(env: &HashMap<String, String>) -> Result<(), String> {
    assert_production_auth_config_from_env().map_err(|error| error.to_string())?;
    let world_model_config = resolve_world_model_config(env);
    let non_empty = |key: &str| {
        env.get(key)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    };
    let guard_env = ProductionGuardEnv {
        is_production: env.get("NODE_ENV").map(String::as_str) == Some("production"),
        has_explicit_world_model_database: non_empty("WORLD_MODEL_APP_DATABASE_URL")
            || non_empty("WORLD_MODEL_WORKER_DATABASE_URL")
            || non_empty("CANONICAL_DATABASE_URL"),
    };
    assert_production_world_model_config(&world_model_config, &guard_env)
        .map_err(|error| error.to_string())?;
    assert_memory_runtime_configuration(env).map_err(|error| error.to_string())?;
    Ok(())
}

/// Handle to all background workers owned by `betaclaw-scheduler`.
pub struct SchedulerRuntime {
    state: SharedState,
    pub instance_id: String,
    pub automation: Arc<AutomationRuntime>,
    pub knowledge_loop: KnowledgeRuntimeLoop,
    outbox_dispatcher: Option<Arc<OutboxDispatcher>>,
    prospective_timer: Mutex<Option<BackgroundTask>>,
    embedding_worker: Option<EmbeddingWorkerHandle>,
    projection_retry_worker: Option<ProjectionRetryWorkerHandle>,
    workspace_cleanup: Option<crate::workspace_cleanup::WorkspaceCleanupHandle>,
    swarm_runtime: Option<crate::swarm_runtime::SwarmRuntimeHandle>,
}

impl SchedulerRuntime {
    /// Ordered shutdown mirroring `shutdown()` in `scheduler.ts:40-61`.
    pub async fn shutdown(self) {
        tracing::info!("[automation-scheduler] shutting down...");
        if let Some(chat) = self.state.chat.get() {
            chat.shutdown();
        }
        tokio::join!(
            async {
                if let Some(cleanup) = self.workspace_cleanup {
                    cleanup.stop().await;
                }
            },
            async {
                if let Some(swarm) = self.swarm_runtime {
                    swarm.stop().await;
                }
            }
        );
        let prospective = self
            .prospective_timer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(task) = prospective {
            task.stop().await;
        }
        if let Some(worker) = &self.embedding_worker {
            worker.stop();
        }
        if let Some(worker) = &self.projection_retry_worker {
            worker.stop();
        }
        self.knowledge_loop.stop();
        self.automation.stop().await;
        if let Some(dispatcher) = &self.outbox_dispatcher {
            dispatcher.stop();
        }
    }
}

/// Starts the full scheduler runtime over `state`, mirroring `bootstrap()` in `scheduler.ts:65-99`.
pub async fn start_scheduler_runtime(
    state: SharedState,
    env: HashMap<String, String>,
) -> Result<SchedulerRuntime, Box<dyn std::error::Error>> {
    assert_scheduler_startup_guards(&env)?;

    let options = AutomationRuntimeOptions::from_env(&env);
    let instance_id = options.instance_id.clone();
    tracing::info!("[automation-scheduler] starting with instance {instance_id}");

    let automation = Arc::new(AutomationRuntime::new(state.tasks.clone(), options));
    automation.start();

    let knowledge_loop = build_knowledge_runtime_loop(state.clone());
    knowledge_loop.start();

    let world_model_config = resolve_world_model_config(&env);
    let mut outbox_dispatcher = None;
    let mut prospective_timer = None;
    let mut embedding_worker = None;
    let mut projection_retry_worker = None;

    if world_model_config.enabled || world_model_config.e2e_enabled {
        match state.get_world_model_pg_executor(&world_model_config).await {
            Ok(executor) => {
                let transport: Arc<dyn HttpTransport> =
                    Arc::new(ReqwestTransport::with_client(state.upstream.clone()));

                // 1. OutboxDispatcher (`scheduler.ts:80-82`).
                let dispatcher = Arc::new(OutboxDispatcher::new(
                    executor.clone(),
                    world_model_config.outbox_batch_size,
                    env.clone(),
                    world_model_config.runtime_role,
                ));
                if let Ok(ports) = build_outbox_handler_ports(
                    &state,
                    executor.clone(),
                    &world_model_config,
                    &env,
                    transport.clone(),
                ) {
                    let migrations = MigrationSettings {
                        admin_database_url: env.get("WORLD_MODEL_ADMIN_DATABASE_URL").cloned(),
                        migrations_dir: env
                            .get("WORLD_MODEL_MIGRATIONS_DIR")
                            .cloned()
                            .unwrap_or_else(|| "src/server/world-model/migrations".to_string()),
                    };
                    if let Err(error) = Arc::clone(&dispatcher)
                        .start(&world_model_config, &ports, &migrations)
                        .await
                    {
                        tracing::error!(
                            error = %error,
                            "[automation-scheduler] world-model outbox dispatcher failed to start"
                        );
                    }
                    outbox_dispatcher = Some(dispatcher);
                }

                // 2. Prospective Runtime (`scheduler.ts:83-89`).
                let prospective_ms = world_model_config.prospective_interval_ms.max(1) as u64;
                let prospective_exec = executor.clone();
                let prospective_cfg = world_model_config.clone();
                let prospective_env = env.clone();
                let (prospective_stop, mut prospective_signal) = tokio::sync::watch::channel(false);
                let prospective_task = tokio::spawn(async move {
                    let mut interval = tokio::time::interval(Duration::from_millis(prospective_ms));
                    interval.tick().await;
                    loop {
                        tokio::select! {
                            _ = prospective_signal.changed() => break,
                            _ = interval.tick() => {}
                        }
                        let now_iso =
                            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                        let _ = run_prospective_runtime_once(
                            prospective_exec.as_ref(),
                            &prospective_cfg,
                            &prospective_env,
                            prospective_cfg.runtime_role,
                            &now_iso,
                            ProspectiveRuntimeDeps::default(),
                        )
                        .await;
                    }
                });
                prospective_timer = Some(BackgroundTask {
                    stop: prospective_stop,
                    task: prospective_task,
                });

                // 3. EmbeddingWorker (`scheduler.ts:91-93`).
                // Without EMBEDDING_* settings the Model Hub embeds (`provider.ts:95`).
                let model_hub_http = state.upstream.clone();
                let model_hub_fallback = move || {
                    crate::model_hub_embedding::model_hub_embedding_provider(model_hub_http.clone())
                };
                let provider = configured_embedding_provider(
                    &env,
                    transport.clone(),
                    Some(&model_hub_fallback),
                );
                let scope_exec = executor.clone();
                let scope_env = env.clone();
                let scope_role = world_model_config.runtime_role;
                let scope_provider: ScopeProvider = Arc::new(move || {
                    let exec = Arc::clone(&scope_exec);
                    let env = scope_env.clone();
                    Box::pin(async move {
                        list_runtime_world_model_scopes(&env, Some(exec.as_ref()), scope_role).await
                    })
                });
                let emb_worker = Arc::new(EmbeddingWorker::new(
                    executor.clone(),
                    world_model_config.clone(),
                    env.clone(),
                    provider,
                    EmbeddingWorkerDeps::default(),
                    Some(scope_provider),
                ));
                embedding_worker = Some(emb_worker.start(DEFAULT_WORLD_MODEL_WORKER_INTERVAL_MS));
                tracing::info!("[automation-scheduler] world-model embedding worker started");

                // 4. ProjectionRetryWorker (`scheduler.ts:94-95`).
                let memory_sink: Arc<dyn MemoryFactSink> = Arc::new(SchedulerMemoryFactSink {
                    state: state.clone(),
                    env: env.clone(),
                    world_model: world_model_config.clone(),
                    executor: executor.clone(),
                });
                let knowledge_sink: Arc<dyn KnowledgeRetrySink> =
                    Arc::new(SchedulerKnowledgeRetrySink {
                        knowledge_db_path: default_knowledge_db_path(),
                    });
                let handlers = default_projection_retry_handlers(
                    executor.clone(),
                    memory_sink,
                    knowledge_sink,
                );
                let messages_db_path = state.config.messages_db_path.clone();
                let marker: Arc<MarkMessagesMemoryPending> =
                    Arc::new(move |ids: &[String], pending: bool| {
                        if let Ok(store) = MessagesStore::open(&messages_db_path) {
                            let borrowed: Vec<&str> = ids.iter().map(String::as_str).collect();
                            let _ = store.mark_messages_memory_pending(&borrowed, pending, None);
                        }
                    });
                let retry_worker = Arc::new(ProjectionRetryWorker::new(
                    executor,
                    env.clone(),
                    world_model_config.runtime_role,
                    handlers,
                    Some(marker),
                ));
                projection_retry_worker =
                    Some(retry_worker.start(DEFAULT_WORLD_MODEL_WORKER_INTERVAL_MS));
                tracing::info!(
                    "[automation-scheduler] world-model projection retry worker started"
                );
            }
            Err(error) => {
                tracing::error!(
                    error = %error,
                    "[automation-scheduler] world-model database executor failed to connect"
                );
            }
        }
    }

    let workspace_cleanup = crate::workspace_cleanup::WorkspaceCleanup::start(state.clone());
    tracing::info!(
        owner = crate::background::job_owner("BETACLAW_WORKSPACE_CLEANUP"),
        "[task-workspaces] status"
    );
    let swarm_enabled = crate::swarm_runtime::SwarmRuntime::should_run_for_role("scheduler");
    tracing::info!(
        owner = crate::background::job_owner("BETACLAW_SWARM_RUNNER"),
        "[swarm-runtime] status"
    );
    let swarm_runtime = if swarm_enabled {
        Some(
            crate::swarm_runtime::SwarmRuntime::start(
                state.clone(),
                format!("scheduler-{instance_id}"),
            )
            .await,
        )
    } else {
        None
    };

    Ok(SchedulerRuntime {
        state,
        instance_id,
        automation,
        knowledge_loop,
        outbox_dispatcher,
        prospective_timer: Mutex::new(prospective_timer),
        embedding_worker,
        projection_retry_worker,
        workspace_cleanup,
        swarm_runtime,
    })
}

fn build_outbox_handler_ports(
    state: &SharedState,
    executor: Arc<dyn PgExecutor>,
    config: &WorldModelConfig,
    env: &HashMap<String, String>,
    transport: Arc<dyn HttpTransport>,
) -> Result<OutboxHandlerPorts, String> {
    let graphiti_client = Arc::new(GraphitiRestClient::new(
        GraphitiClientConfig::from_env(),
        transport.clone(),
    ));
    let graphiti_projector = create_graphiti_projector_handler(graphiti_client);

    let messages_db_path = state.config.messages_db_path.clone();
    let list_bindings: ListChannelBindings =
        Arc::new(move |user_id: &str| -> Vec<ChannelBinding> {
            MessagesStore::open(&messages_db_path)
                .ok()
                .and_then(|store| store.list_channel_bindings(user_id).ok())
                .unwrap_or_default()
        });

    let credentials: Arc<dyn ChannelCredentialStore> =
        Arc::new(ChannelDb::open(&state.config.messages_db_path).map_err(|e| e.to_string())?);
    let channel_env = Arc::new(ChannelEnv::new());
    let personas_db_path = state.config.personas_db_path.clone();
    let deliver_outbound: DeliverOutbound = Arc::new(
        move |channel: String,
              external_chat_id: String,
              message: String,
              persona_id: String|
              -> BoxFuture<'static, Result<Option<OutboundReceipt>, String>> {
            let transport = Arc::clone(&transport);
            let credentials = Arc::clone(&credentials);
            let channel_env = Arc::clone(&channel_env);
            let personas_db_path = personas_db_path.clone();
            Box::pin(async move {
                let Some(platform) = ChannelType::parse(&channel) else {
                    return Ok(None);
                };
                let outcome = match platform {
                    ChannelType::WebChat | ChannelType::AgentRoom => return Ok(None),
                    ChannelType::Telegram => {
                        let persona_token = PersonaTelegramBotRegistry::open(&personas_db_path)
                            .ok()
                            .and_then(|bots| bots.get_bot_by_persona_id(&persona_id).ok().flatten())
                            .filter(|bot| bot.active)
                            .map(|bot| bot.token);
                        let sender = TelegramSender::new(
                            TelegramApi::new(transport),
                            credentials,
                            channel_env,
                        );
                        sender
                            .deliver(
                                &external_chat_id,
                                &message,
                                &TelegramTextOptions {
                                    persona_token,
                                    ..Default::default()
                                },
                            )
                            .await
                    }
                    ChannelType::WhatsApp => {
                        let metadata = json!({ "personaId": persona_id });
                        deliver_whatsapp(
                            transport.as_ref(),
                            channel_env.as_ref(),
                            &external_chat_id,
                            &message,
                            Some(&metadata),
                        )
                        .await
                    }
                    ChannelType::Discord => {
                        deliver_discord(
                            transport.as_ref(),
                            credentials.as_ref(),
                            channel_env.as_ref(),
                            &external_chat_id,
                            &message,
                        )
                        .await
                    }
                    ChannelType::Slack => {
                        deliver_slack(
                            transport.as_ref(),
                            credentials.as_ref(),
                            channel_env.as_ref(),
                            &external_chat_id,
                            &message,
                        )
                        .await
                    }
                    ChannelType::IMessage => {
                        deliver_imessage(
                            transport.as_ref(),
                            channel_env.as_ref(),
                            &external_chat_id,
                            &message,
                        )
                        .await
                    }
                };
                match outcome {
                    Ok(provider_message_id) => Ok(Some(OutboundReceipt {
                        provider_id: Some(channel),
                        provider_message_id,
                    })),
                    Err(error) => Err(error.0),
                }
            })
        },
    );

    let clock: Clock =
        Arc::new(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    let proactive_question = create_proactive_question_handler(
        executor.clone(),
        config.clone(),
        env.clone(),
        list_bindings.clone(),
        deliver_outbound.clone(),
        clock,
    );
    let proactive_intent_fired = create_proactive_intent_fired_handler(
        executor,
        config.clone(),
        env.clone(),
        list_bindings,
        deliver_outbound,
    );

    Ok(OutboxHandlerPorts {
        graphiti_projector,
        proactive_question,
        proactive_intent_fired,
    })
}

struct SchedulerMemoryFactSink {
    state: SharedState,
    env: HashMap<String, String>,
    world_model: WorldModelConfig,
    executor: Arc<dyn PgExecutor>,
}

impl MemoryFactSink for SchedulerMemoryFactSink {
    fn factual_write_guard(&self) -> Result<(), String> {
        if configured_provider(&self.env) == ConfiguredProvider::Mem0
            && is_mem0_factual_write_blocked(&self.world_model)
        {
            return Err("Mem0 factual write is blocked by world-model policy".to_string());
        }
        Ok(())
    }

    fn store_fact<'a>(&'a self, fact: RetryMemoryFact) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let transport: Arc<dyn HttpTransport> =
                Arc::new(ReqwestTransport::with_client(self.state.upstream.clone()));
            let client: Box<dyn Mem0Client + Send> = match configured_provider(&self.env) {
                ConfiguredProvider::Postgres => {
                    Box::new(PostgresMemoryClient::new(self.executor.clone()))
                }
                ConfiguredProvider::Mem0 => create_mem0_client_from_env(&self.env, transport)
                    .map_err(|error| error.to_string())?
                    .map(|client: Mem0HttpClient| Box::new(client) as Box<dyn Mem0Client + Send>)
                    .ok_or_else(|| "Mem0 provider is not configured".to_string())?,
                ConfiguredProvider::Sqlite => SqliteMemoryClient::new()
                    .map(|client| Box::new(client) as Box<dyn Mem0Client + Send>)
                    .map_err(|error| error.to_string())?,
            };
            let lifecycle = self.state.memory_lifecycle_bus.clone();
            let policy = if self.world_model.mode.is_canonical() {
                Mem0PolicyConfig::canonical()
            } else if self.world_model.mem0_preferences_only {
                Mem0PolicyConfig::preferences_only()
            } else {
                Mem0PolicyConfig::legacy()
            };
            tokio::task::spawn_blocking(move || {
                let deps = MemoryServiceDependencies::for_test()
                    .with_publisher(&lifecycle)
                    .with_policy(&policy);
                let service = MemoryService::new(client.as_ref(), deps);
                service
                    .store_memory(&MemoryStoreInput {
                        persona_id: fact.persona_id,
                        workspace_id: None,
                        node_type: MemoryType::Fact,
                        content: fact.content,
                        importance: fact.importance as f64,
                        user_id: Some(fact.user_id),
                        metadata: fact.metadata,
                    })
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
            .await
            .map_err(|error| error.to_string())?
        })
    }
}

struct SchedulerKnowledgeRetrySink {
    knowledge_db_path: String,
}

impl KnowledgeRetrySink for SchedulerKnowledgeRetrySink {
    fn retry_sqlite_knowledge<'a>(
        &'a self,
        retry: SqliteKnowledgeRetry,
    ) -> BoxFuture<'a, Result<(), String>> {
        let db_path = self.knowledge_db_path.clone();
        Box::pin(async move {
            let repo =
                SqliteKnowledgeRepository::open(&db_path).map_err(|error| error.to_string())?;
            let messages: Vec<StoredMessage> = retry
                .window
                .messages
                .iter()
                .map(|msg| StoredMessage {
                    id: msg.id.clone(),
                    conversation_id: msg.conversation_id.clone(),
                    seq: Some(msg.seq),
                    role: msg.role.clone(),
                    content: msg.content.clone(),
                    platform: msg.platform.clone(),
                    external_msg_id: msg.external_msg_id.clone(),
                    sender_name: msg.sender_name.clone(),
                    metadata: msg.metadata.clone(),
                    created_at: msg.created_at.clone(),
                })
                .collect();
            let extraction = parse_retry_extraction(&retry.raw_extraction, &messages)?;
            let window = IngestionWindow {
                conversation_id: retry.window.conversation_id.clone(),
                user_id: retry.window.user_id.clone(),
                persona_id: retry.window.persona_id.clone(),
                workspace_id: if retry.window.workspace_id.is_empty() {
                    None
                } else {
                    Some(retry.window.workspace_id.clone())
                },
                from_seq_exclusive: retry.window.from_seq_exclusive,
                to_seq_inclusive: retry.window.to_seq_inclusive,
                messages,
            };
            let facts = retry
                .payload_facts
                .unwrap_or_else(|| process_facts(&extraction, &window));
            let ledger = process_meeting_ledger(&extraction, &window);
            upsert_episode_and_ledger(
                &repo,
                &EpisodeInput {
                    window: &window,
                    extraction: &extraction,
                    facts,
                    filtered_decisions: ledger.decisions,
                    filtered_negotiated_terms: ledger.negotiated_terms,
                    filtered_open_points: ledger.open_points,
                    filtered_action_items: ledger.action_items,
                    memory_ids: retry.memory_ids,
                },
            )
            .map_err(|error| error.to_string())?;
            store_events(
                &repo,
                &EventProcessingContext {
                    window: &window,
                    extraction: &extraction,
                    persona_name: retry.persona_name,
                },
            )
            .map_err(|error| error.to_string())?;
            store_entities(
                &repo,
                &EntityProcessingContext {
                    window: &window,
                    entities: extraction.entities,
                },
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
    }
}

fn parse_retry_extraction(
    raw: &Value,
    messages: &[StoredMessage],
) -> Result<KnowledgeExtractionResult, String> {
    let ledger = raw
        .get("meetingLedger")
        .and_then(Value::as_object)
        .ok_or_else(|| "projection retry payload has no meeting ledger".to_string())?;
    let str_vec = |val: Option<&Value>| -> Vec<String> {
        val.and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    let source_refs = ledger
        .get("sourceRefs")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(KnowledgeSourceRef {
                        seq: item.get("seq")?.as_i64()?,
                        quote: item.get("quote")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let events = raw
        .get("events")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|event| ExtractedEvent {
                    event_type: event
                        .get("eventType")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    speaker_role: match event.get("speakerRole").and_then(Value::as_str) {
                        Some("assistant") => SpeakerRole::Assistant,
                        _ => SpeakerRole::User,
                    },
                    subject: event
                        .get("subject")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    counterpart: event
                        .get("counterpart")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    relation_label: event
                        .get("relationLabel")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    start_date: event
                        .get("startDate")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    end_date: event
                        .get("endDate")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    day_count: event.get("dayCount").and_then(Value::as_i64).unwrap_or(1),
                    source_seq: event
                        .get("sourceSeq")
                        .and_then(Value::as_array)
                        .map(|arr| arr.iter().filter_map(Value::as_i64).collect())
                        .unwrap_or_default(),
                    time_expression: event
                        .get("rawTimeExpression")
                        .or_else(|| event.get("timeExpression"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    is_confirmation: event
                        .get("isConfirmation")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    confirmation_signals: str_vec(event.get("confirmationSignals")),
                })
                .collect()
        })
        .unwrap_or_default();
    let entities =
        EntityExtractor.normalize_entities(raw.get("entities").unwrap_or(&Value::Null), messages);

    Ok(KnowledgeExtractionResult {
        facts: str_vec(raw.get("facts")),
        teaser: raw
            .get("teaser")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        episode: raw
            .get("episode")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        meeting_ledger: KnowledgeMeetingLedger {
            topic_key: ledger
                .get("topicKey")
                .and_then(Value::as_str)
                .unwrap_or("general")
                .to_string(),
            counterpart: ledger
                .get("counterpart")
                .and_then(Value::as_str)
                .map(str::to_string),
            participants: str_vec(ledger.get("participants")),
            decisions: str_vec(ledger.get("decisions")),
            negotiated_terms: str_vec(ledger.get("negotiatedTerms")),
            open_points: str_vec(ledger.get("openPoints")),
            action_items: str_vec(ledger.get("actionItems")),
            source_refs,
            confidence: ledger
                .get("confidence")
                .and_then(Value::as_f64)
                .unwrap_or(0.7),
        },
        events,
        entities,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use betaclaw_core::automation::service::{PromptRunInput, PromptRunOutput};
    use betaclaw_core::automation::sqlite_repository::SqliteAutomationRepository;

    struct TestPromptRunner;

    #[test]
    fn scheduler_lease_uses_the_automation_database() {
        use crate::families::tasks::{
            build_with_prompt_runner,
            ports::{NoSkills, UnwiredRuntime},
            GatewayPromptRunner,
        };
        let root = std::env::temp_dir().join(format!("scheduler-db-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let tasks_path = root.join("tasks.db");
        let automation_path = root.join("automation.db");
        let services = build_with_prompt_runner(
            (
                tasks_path.to_str().unwrap(),
                automation_path.to_str().unwrap(),
            ),
            root.clone(),
            String::new(),
            String::new(),
            Arc::new(UnwiredRuntime),
            Arc::new(NoSkills),
            GatewayPromptRunner::unwired(),
        )
        .unwrap();
        services
            .acquire_lease("scheduler-test", 30_000, "2026-10-29T00:00:00.000Z")
            .unwrap();
        let repository =
            SqliteAutomationRepository::open(automation_path.to_str().unwrap()).unwrap();
        assert_eq!(
            repository.get_lease_state().unwrap().unwrap().instance_id,
            "scheduler-test"
        );
        drop(repository);
        drop(services);
        std::fs::remove_dir_all(root).unwrap();
    }

    impl PromptRunner for TestPromptRunner {
        async fn run_prompt(&self, _input: PromptRunInput) -> Result<PromptRunOutput, String> {
            Ok(PromptRunOutput::default())
        }
    }

    #[test]
    fn automation_runtime_options_use_documented_defaults() {
        let env = HashMap::new();
        let options = AutomationRuntimeOptions::from_env(&env);
        assert!(options.instance_id.starts_with("scheduler-"));
        assert_eq!(
            options.tick_interval_ms,
            DEFAULT_AUTOMATION_TICK_INTERVAL_MS
        );
        assert_eq!(options.lease_ttl_ms, DEFAULT_AUTOMATION_LEASE_TTL_MS);
        assert_eq!(options.max_attempts, DEFAULT_AUTOMATION_MAX_ATTEMPTS);
        assert_eq!(
            options.retry_backoff_ms,
            DEFAULT_AUTOMATION_RETRY_BACKOFF_MS.to_vec()
        );
        assert_eq!(
            options.auto_pause_failure_threshold,
            DEFAULT_AUTOMATION_AUTO_PAUSE_FAILURES
        );
    }

    #[test]
    fn automation_runtime_options_parse_custom_environment() {
        let env = HashMap::from([
            (
                "SCHEDULER_INSTANCE_ID".to_string(),
                "sched-custom".to_string(),
            ),
            (
                "AUTOMATION_TICK_INTERVAL_MS".to_string(),
                "5000".to_string(),
            ),
            ("AUTOMATION_LEASE_TTL_MS".to_string(), "12000".to_string()),
            ("AUTOMATION_MAX_ATTEMPTS".to_string(), "5".to_string()),
            (
                "AUTOMATION_RETRY_BACKOFF_MS".to_string(),
                "1000, 2000, invalid, -5, 4000".to_string(),
            ),
            (
                "AUTOMATION_AUTO_PAUSE_FAILURES".to_string(),
                "7".to_string(),
            ),
        ]);
        let options = AutomationRuntimeOptions::from_env(&env);
        assert_eq!(options.instance_id, "sched-custom");
        assert_eq!(options.tick_interval_ms, 5_000);
        assert_eq!(options.lease_ttl_ms, 12_000);
        assert_eq!(options.max_attempts, 5);
        assert_eq!(options.retry_backoff_ms, vec![1_000, 2_000, 4_000]);
        assert_eq!(options.auto_pause_failure_threshold, 7);
    }

    #[tokio::test]
    async fn automation_runtime_acquires_lease_runs_tick_and_releases_on_stop() {
        let tmp_dir = std::env::temp_dir().join(format!("sched-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp_dir).expect("temp dir");
        let db_path = tmp_dir.join("automation.db").to_string_lossy().into_owned();
        let repo_a = SqliteAutomationRepository::open(&db_path).expect("repo a");
        let repo_b = SqliteAutomationRepository::open(&db_path).expect("repo b");
        let service_a: Arc<dyn AutomationTickPort> =
            Arc::new(AutomationService::new(repo_a, TestPromptRunner));
        let service_b: Arc<dyn AutomationTickPort> =
            Arc::new(AutomationService::new(repo_b, TestPromptRunner));

        let runtime_a = Arc::new(AutomationRuntime::new(
            service_a,
            AutomationRuntimeOptions {
                instance_id: "scheduler-a".to_string(),
                tick_interval_ms: 15_000,
                lease_ttl_ms: 30_000,
                max_attempts: 3,
                retry_backoff_ms: vec![30_000],
                auto_pause_failure_threshold: 10,
            },
        ));
        let runtime_b = Arc::new(AutomationRuntime::new(
            service_b,
            AutomationRuntimeOptions {
                instance_id: "scheduler-b".to_string(),
                tick_interval_ms: 15_000,
                lease_ttl_ms: 30_000,
                max_attempts: 3,
                retry_backoff_ms: vec![30_000],
                auto_pause_failure_threshold: 10,
            },
        ));

        assert!(runtime_a.run_once().await.expect("tick a"));
        // While scheduler-a holds the lease, scheduler-b skips its tick.
        assert!(!runtime_b.run_once().await.expect("tick b skipped"));

        // Stopping scheduler-a releases the lease immediately.
        runtime_a.stop().await;
        assert!(runtime_b.run_once().await.expect("tick b after release"));
        runtime_b.stop().await;
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    /// Lease port whose tick takes a while, so `stop()` can be called mid-tick.
    struct SlowTickPort {
        finished: Arc<std::sync::atomic::AtomicBool>,
    }

    impl AutomationTickPort for SlowTickPort {
        fn acquire_lease(&self, _: &str, _: i64, _: &str) -> Result<bool, AutomationError> {
            Ok(true)
        }

        fn release_lease(&self, _: &str) -> Result<(), AutomationError> {
            Ok(())
        }

        fn process_tick<'a>(
            &'a self,
            _: &'a ProcessTickOptions,
        ) -> Pin<Box<dyn Future<Output = Result<(), AutomationError>> + Send + 'a>> {
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(100)).await;
                self.finished
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn automation_stop_waits_for_the_in_flight_tick() {
        let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let runtime = Arc::new(AutomationRuntime::new(
            Arc::new(SlowTickPort {
                finished: Arc::clone(&finished),
            }),
            AutomationRuntimeOptions {
                instance_id: "scheduler-drain".to_string(),
                tick_interval_ms: 60_000,
                lease_ttl_ms: 30_000,
                max_attempts: 3,
                retry_backoff_ms: vec![30_000],
                auto_pause_failure_threshold: 10,
            },
        ));
        runtime.start();
        tokio::time::sleep(Duration::from_millis(20)).await;
        runtime.stop().await;
        assert!(
            finished.load(std::sync::atomic::Ordering::SeqCst),
            "stop must let the running tick finish before releasing the lease"
        );
    }
}
