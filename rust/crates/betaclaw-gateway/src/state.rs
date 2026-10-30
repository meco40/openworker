//! Shared application state.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use betaclaw_core::agent_v2::errors::AgentV2Error;
use betaclaw_core::agent_v2::repository::AgentV2Repository;
use betaclaw_core::automation::error::AutomationError;
use betaclaw_core::config::GatewayConfig;
use betaclaw_core::gateway::registry::{ClientRegistry, SharedRegistry};
use betaclaw_core::gateway_config::GatewayConfigStore;
use betaclaw_core::logging::repository::{LogRepository, LogRepositoryError};
use betaclaw_core::master::feature_flags::process_env;
use betaclaw_core::memory::lifecycle::MemoryLifecycleBus;
use betaclaw_core::messages_store::{MessageRepositoryError, MessagesStore};
use betaclaw_core::migration_runner::{DbPaths, MigrationError};
use betaclaw_core::model_hub::env::EnvOverrides;
use betaclaw_core::model_hub::http::HttpTransport;
use betaclaw_core::personas::repository::{PersonaRepository, PersonaRepositoryError};
use betaclaw_core::personas::PersonaWorkspace;
use betaclaw_core::skills::exec_approval::ExecApprovalStore;
use betaclaw_core::skills::store::SkillRepository;
use betaclaw_core::skills::types::{SkillEnv, SkillError, SkillExecConfig};
use betaclaw_core::tasks::repository::TaskRepository;
use betaclaw_core::world_model::config::WorldModelConfig;
use betaclaw_core::world_model::db::{PgError, PgExecutor};
use betaclaw_core::world_model::driver::{PgPoolSettings, SqlxPgExecutor};
use tokio::sync::{Mutex, OnceCell};

use crate::families::cutover::{CutoverError, CutoverPolicy};
use crate::families::tasks::ports::{
    GatewayPromptRunner, IntegratedBetaClawRuntime, SkillStoreInventory,
};
use crate::families::{
    channels_wire, chat_runtime, master, migrations_wire, ops_wire, skills_wire, stats_wire, tasks,
};
use crate::model_hub_transport::ReqwestTransport;
use crate::routes::inbox::InboxRateLimiter;

/// State shared by every request handler.
pub struct AppState {
    pub ui: crate::static_ui::StaticUi,
    pub config: GatewayConfig,
    pub registry: SharedRegistry,
    /// The log repository is behind a mutex because `rusqlite::Connection` is
    /// synchronous. Contention is negligible: log writes are short and rare
    /// compared to reads through the gateway.
    pub logs: Mutex<LogRepository>,
    /// Gateway config store, built once from the resolved backend and paths.
    pub gateway_config: GatewayConfigStore,
    // ponytail: sync SQLite under a mutex on the reactor, same as `logs`.
    // Upgrade to spawn_blocking if persona routes show up in profiles.
    pub personas: Mutex<PersonaRepository>,
    // ponytail: one connection under a mutex for conversations, messages and the
    // inbox, same as `personas`. Upgrade to spawn_blocking or a pool if the chat
    // routes show up in profiles.
    pub messages: Mutex<MessagesStore>,
    /// Local credentials store (`auth.db`).
    pub auth_users: Mutex<betaclaw_core::auth::AuthUserStore>,
    /// In-memory rate limiter for login attempts.
    pub login_limiter: Mutex<betaclaw_core::auth::LoginRateLimiter>,
    /// Agent-v2 sessions, commands and events repository (`messages.db`).
    pub agent_v2: Arc<AgentV2Repository>,
    /// Per-user request windows for `GET /api/channels/inbox`.
    pub inbox_rate_limiter: InboxRateLimiter,
    /// Process-local publisher used by Memory and World-Model lifecycle events.
    pub memory_lifecycle_bus: MemoryLifecycleBus,
    /// Upstream client for the reverse proxy. One client per process keeps the
    /// connection pool bounded and predictable. It does not follow redirects, so a
    /// proxied request cannot be sent somewhere the gateway did not check.
    pub upstream: reqwest::Client,
    /// Canonical World-Model pool, initialized on the first PostgreSQL memory request.
    world_model_pg_executor: OnceCell<Arc<dyn PgExecutor>>,
    /// Migrated databases and the paths the families open.
    pub migrations: Arc<migrations_wire::Services>,
    pub master: Arc<master::Services>,
    pub skills: Arc<skills_wire::Services>,
    pub stats: Arc<stats_wire::Services>,
    pub ops: Arc<ops_wire::Services>,
    /// Tasks, activities, deliverables, agents and automation rules.
    pub tasks: Arc<tasks::Services>,
    /// Channel services. They take the shared state themselves, so
    /// [`GatewayRuntime::bind`] sets them once the state is in its `Arc`.
    pub channels: OnceLock<Arc<channels_wire::Services>>,
    /// The chat runtime. It is the `ChannelInbound` of the channel routes and the
    /// `WsServices` source of the chat, store and persona ports. Like
    /// [`AppState::channels`], [`GatewayRuntime::bind`] sets it once the state is in
    /// its `Arc`; a state built without a bind has no chat runtime.
    pub chat: Arc<OnceLock<Arc<chat_runtime::Services>>>,
    /// Runtime switch between the Rust route and the proxy, one per family.
    pub cutover: Arc<CutoverPolicy>,
}

impl AppState {
    pub fn new(config: GatewayConfig) -> Result<Self, StateError> {
        let _migration_guard = migration_lock();
        // Migrations first: every store below opens a file that is already migrated.
        let migrations = migrations_wire::build(migration_paths(&config))?;
        let paths = &migrations.paths;

        let registry: SharedRegistry = Arc::new(ClientRegistry::new());
        let logs = LogRepository::open(&config.logs_db_path)?;
        let personas = PersonaRepository::open_with_workspace(
            &config.personas_db_path,
            PersonaWorkspace::new(config.personas_root_path.as_str()),
        )?;
        let messages = MessagesStore::open(&config.messages_db_path)?;
        let bootstrap = betaclaw_core::auth::user_store::BootstrapConfig {
            default_email: std::env::var("AUTH_DEFAULT_EMAIL").unwrap_or_default(),
            default_password: std::env::var("AUTH_DEFAULT_PASSWORD").unwrap_or_default(),
            default_name: std::env::var("AUTH_DEFAULT_NAME").unwrap_or_default(),
            node_env: std::env::var("NODE_ENV").unwrap_or_default(),
        };
        let auth_users =
            betaclaw_core::auth::AuthUserStore::open(&config.auth_db_path, &bootstrap)?;
        let login_limiter = betaclaw_core::auth::LoginRateLimiter::default();
        let agent_v2 = Arc::new(AgentV2Repository::open(&config.messages_db_path)?);
        let _ = agent_v2.recover_running_commands_on_startup();
        let chat: Arc<OnceLock<Arc<chat_runtime::Services>>> = Arc::new(OnceLock::new());
        let gateway_config = GatewayConfigStore::new(
            config.gateway_config_backend,
            config.gateway_config_path.as_str(),
            config.gateway_config_db_path.as_str(),
        );
        let upstream = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;

        // `CLAWHUB_WORKDIR`, falling back to the working directory as the TypeScript
        // service does. The approval file is `<cwd>/.local/exec-approvals.json`, the
        // path `ExecApprovalStore::in_current_dir` uses.
        let workdir = match std::env::var("CLAWHUB_WORKDIR") {
            Ok(value) if !value.is_empty() => PathBuf::from(value),
            _ => std::env::current_dir()?,
        };
        let approvals = std::env::current_dir()?
            .join(".local")
            .join("exec-approvals.json");
        // The dispatcher behind both the Master tool runner and `POST /api/skills/execute`.
        // It carries the persona workspace and the exec-approval store, so the exec handlers
        // keep their approval gate and path guard.
        let skills_env = SkillEnv {
            personas: PersonaWorkspace::from_env(),
            approvals: ExecApprovalStore::in_current_dir()?,
            exec: SkillExecConfig::from_env(),
        };
        let dispatcher: Arc<dyn master::skills::SkillDispatcher> =
            Arc::new(master::skills::CoreSkillDispatcher::new(
                Arc::new(ReqwestTransport::new()),
                std::env::var("BRAVE_SEARCH_API_KEY")
                    .ok()
                    .filter(|key| !key.is_empty()),
                skills_env,
            ));
        let skills = skills_wire::build(
            &paths.skills,
            &paths.clawhub,
            workdir,
            approvals,
            dispatcher.clone(),
        )?;

        let mut stats_config = stats_wire::StatsWireConfig::from_env();
        stats_config.stats_db_path = paths.stats.clone();
        stats_config.knowledge_db_path = paths.knowledge.clone();
        stats_config.main_db_path = paths.mission_control.clone();
        stats_config.master_db_path = paths.master.clone();
        let stats = stats_wire::build(&stats_config)?;

        let prompt_runner = GatewayPromptRunner::new(chat.clone());
        let automation = master::automation::open_automation_port_with_runner(
            &paths.automation,
            prompt_runner.clone(),
        )?;
        let master = master::build(
            &paths.master,
            &paths.personas,
            &paths.personas_root,
            &paths.model_hub,
            process_env(),
            master::RuntimeSeams {
                automation,
                skills: dispatcher,
                action_bridge: Arc::new(master::action_bridge::ActionBridge::direct()),
                process_bus: Some(registry.clone()),
            },
        )?;

        // The task family reads the same Mission Control database as the migrations and
        // the automation port: `paths.mission_control` is `DATABASE_PATH`. The skill
        // inventory is the installed rows of the skills store. `IntegratedBetaClawRuntime`
        // and `GatewayPromptRunner` connect to `chat` once `GatewayRuntime::bind` sets it.
        let task_skills: Arc<dyn tasks::SkillInventory> = Arc::new(SkillStoreInventory(Arc::new(
            SkillRepository::open(&paths.skills)?,
        )));
        let runtime_tasks = Arc::new(TaskRepository::open(&paths.mission_control)?);
        let task_runtime: Arc<dyn tasks::BetaClawRuntime> = Arc::new(
            IntegratedBetaClawRuntime::new(runtime_tasks.clone(), chat.clone()),
        );
        let tasks = tasks::build_with_prompt_runner(
            (&paths.mission_control, &paths.automation),
            betaclaw_core::tasks::workspace::resolve_root(),
            projects_path_from_env(),
            mission_control_url_from_env(),
            task_runtime.clone(),
            task_skills,
            prompt_runner,
        )?;

        let ops_env = EnvOverrides::new()
            .with("AUTOMATION_DB_PATH", paths.automation.as_str())
            .with("STATS_DB_PATH", paths.stats.as_str())
            .with("DATABASE_PATH", paths.mission_control.as_str())
            .with("MODEL_HUB_DB_PATH", paths.model_hub.as_str())
            .with("KNOWLEDGE_DB_PATH", paths.knowledge.as_str());
        let ops = ops_wire::build(
            &ops_env,
            ops_wire::GatewayLinks {
                logs_db_path: &config.logs_db_path,
                messages_db_path: &config.messages_db_path,
                registry: registry.clone(),
                http: upstream.clone(),
            },
        )?
        .with_control_plane(paths.knowledge.clone())
        .with_core_channel_pairing(
            &config.messages_db_path,
            Arc::new(ReqwestTransport::with_client(upstream.clone())),
        )?
        .with_betaclaw(
            runtime_tasks,
            task_runtime,
            registry.clone(),
            config.require_auth,
        );

        let cutover = CutoverPolicy::from_env()?;

        Ok(Self {
            ui: crate::static_ui::StaticUi::from_env(),
            config,
            registry,
            logs: Mutex::new(logs),
            gateway_config,
            personas: Mutex::new(personas),
            messages: Mutex::new(messages),
            auth_users: Mutex::new(auth_users),
            login_limiter: Mutex::new(login_limiter),
            agent_v2,
            inbox_rate_limiter: InboxRateLimiter::default(),
            memory_lifecycle_bus: MemoryLifecycleBus::default(),
            upstream,
            world_model_pg_executor: OnceCell::new(),
            migrations: Arc::new(migrations),
            master: Arc::new(master),
            skills: Arc::new(skills),
            stats: Arc::new(stats),
            ops: Arc::new(ops),
            tasks: Arc::new(tasks),
            channels: OnceLock::new(),
            chat,
            cutover: Arc::new(cutover),
        })
    }

    pub async fn get_world_model_pg_executor(
        &self,
        config: &WorldModelConfig,
    ) -> Result<Arc<dyn PgExecutor>, PgError> {
        let config = config.clone();
        let executor = self
            .world_model_pg_executor
            .get_or_try_init(|| async move {
                let settings = PgPoolSettings::from_config(&config);
                let executor = SqlxPgExecutor::connect(&settings).await?;
                Ok::<Arc<dyn PgExecutor>, PgError>(Arc::new(executor))
            })
            .await?;
        Ok(Arc::clone(executor))
    }
}

/// Serialises the migration runs of this process. Each run reads a ledger and then
/// inserts into it, so two runs at once (parallel tests, or two states) can insert the
/// same row. A process-wide lock is the ceiling of this fix: two gateway processes on
/// the same files still need the runner itself to take a database lock.
static MIGRATION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn migration_lock() -> std::sync::MutexGuard<'static, ()> {
    MIGRATION_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// `getProjectsPath()` (`src/lib/config.ts`): `PROJECTS_PATH`, or the shared default.
fn projects_path_from_env() -> String {
    match std::env::var("PROJECTS_PATH") {
        Ok(value) if !value.is_empty() => value,
        _ => "~/Documents/Shared/projects".to_string(),
    }
}

/// `getMissionControlUrl()` (`src/lib/config.ts`): `MISSION_CONTROL_URL`, or
/// `http://localhost:${PORT || '3000'}`.
fn mission_control_url_from_env() -> String {
    match std::env::var("MISSION_CONTROL_URL") {
        Ok(value) if !value.is_empty() => value,
        _ => {
            let port = std::env::var("PORT").ok().filter(|value| !value.is_empty());
            format!("http://localhost:{}", port.as_deref().unwrap_or("3000"))
        }
    }
}

/// The paths the migrations run on. `GatewayConfig` resolves its databases against
/// `WORKSPACE_ROOT`, so those paths come from the config: the migrations then touch
/// the same files that the stores open.
fn migration_paths(config: &GatewayConfig) -> DbPaths {
    let mut paths = DbPaths::from_env();
    paths.messages = config.messages_db_path.clone();
    paths.personas = config.personas_db_path.clone();
    paths.personas_root = config.personas_root_path.clone();
    paths.logs = config.logs_db_path.clone();
    paths.auth = config.auth_db_path.clone();
    // The gateway config store creates its database on first use. Migrating it here
    // would create the file for the file backend as well, so the step runs in memory.
    paths.gateway_config = ":memory:".to_string();
    paths
}

/// Failures while building [`AppState`]. Each store keeps its own error type.
#[derive(Debug, thiserror::Error)]
pub enum StateError {
    #[error(transparent)]
    Logs(#[from] LogRepositoryError),
    #[error(transparent)]
    Personas(#[from] PersonaRepositoryError),
    #[error(transparent)]
    Messages(#[from] MessageRepositoryError),
    #[error(transparent)]
    AuthStore(#[from] betaclaw_core::auth::user_store::AuthStoreError),
    #[error(transparent)]
    AgentV2(#[from] AgentV2Error),
    #[error(transparent)]
    TaskRepo(#[from] betaclaw_core::tasks::TaskError),
    #[error("failed to build upstream client: {0}")]
    Upstream(#[from] reqwest::Error),
    #[error(transparent)]
    Migrations(#[from] MigrationError),
    #[error(transparent)]
    Skills(#[from] skills_wire::BuildError),
    #[error(transparent)]
    Stats(#[from] stats_wire::BuildError),
    #[error(transparent)]
    Master(#[from] master::BuildError),
    #[error(transparent)]
    Ops(#[from] ops_wire::BuildError),
    #[error(transparent)]
    Tasks(#[from] tasks::ServicesError),
    #[error(transparent)]
    TaskSkills(#[from] SkillError),
    #[error(transparent)]
    Cutover(#[from] CutoverError),
    #[error(transparent)]
    Automation(#[from] AutomationError),
    #[error("failed to resolve the working directory: {0}")]
    WorkingDirectory(#[from] std::io::Error),
}

pub type SharedState = Arc<AppState>;

/// Everything the process owns at runtime, used by start-up and shutdown.
pub struct GatewayRuntime {
    pub state: SharedState,
    pub listener: tokio::net::TcpListener,
}

impl GatewayRuntime {
    /// Builds the shared state and wires `chat_runtime` and `channels_wire` without
    /// binding a TCP listener. Used by both [`GatewayRuntime::bind`] and
    /// `betaclaw-scheduler`.
    pub fn init_state(config: GatewayConfig) -> Result<SharedState, GatewayBindError> {
        let state = Arc::new(AppState::new(config).map_err(GatewayBindError::State)?);
        let transport: Arc<dyn HttpTransport> = Arc::new(ReqwestTransport::new());
        let _migration_guard = migration_lock();
        // The chat runtime is the dispatch of the channel routes and of the chat WS
        // methods. It is built first: `channels_wire::build` takes its `inbound`.
        let chat = Arc::new(chat_runtime::build(
            &state.config,
            state.registry.clone(),
            transport.clone(),
        )?);
        let channels = channels_wire::build(state.clone(), transport, chat.inbound())?;
        // Set once, before any router is built from this state.
        let _ = state.chat.set(chat);
        let _ = state.channels.set(Arc::new(channels));
        Ok(state)
    }

    /// Binds the public listener and builds the shared state.
    pub async fn bind(config: GatewayConfig) -> Result<Self, GatewayBindError> {
        // Fail before binding so a misconfigured production deployment never
        // opens a port.
        betaclaw_core::auth::production_guard::assert_production_auth_config_from_env()
            .map_err(GatewayBindError::AuthConfig)?;

        let bind_address = if config.hostname.contains(':') && !config.hostname.starts_with('[') {
            format!("[{}]:{}", config.hostname, config.port)
        } else {
            format!("{}:{}", config.hostname, config.port)
        };

        let listener = tokio::net::TcpListener::bind(&bind_address)
            .await
            .map_err(|source| GatewayBindError::Listen {
                address: bind_address,
                source,
            })?;

        let state = Self::init_state(config)?;
        Ok(Self { state, listener })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum GatewayBindError {
    #[error("refusing to start: {0}")]
    AuthConfig(#[from] betaclaw_core::auth::production_guard::AuthConfigError),
    #[error("failed to listen on {address}: {source}")]
    Listen {
        address: String,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to initialise state: {0}")]
    State(#[from] StateError),
    #[error("failed to build channel services: {0}")]
    Channels(#[from] channels_wire::ServicesError),
    #[error("failed to build the chat runtime: {0}")]
    Chat(#[from] chat_runtime::BuildError),
}
