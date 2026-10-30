//! Chat runtime family: the S8 dispatch (`MessageService`) with production
//! implementations of its ports.
//!
//! A port with a production type is wired to that type (the adapter modules below).
//! A port without one answers with a [`PortError`] that names it, see `unwired.rs`
//! and `tools.rs`, so a turn that reaches it fails visibly.
//!
//! The integrator calls [`build`] once and hands [`Services::inbound`] to
//! `channels_wire::build`. The chat routes stay in `channels_wire`; this family has
//! no router.

mod commands;
mod events;
mod execution;
mod handlers;
mod history;
mod memory;
mod model;
mod persona;
mod recall;
mod repo;
mod summary;
mod tools;
mod unwired;
mod world;
mod ws_ports;

use std::collections::HashMap;
use std::sync::Arc;

use betaclaw_core::agents::subagent_registry::resolve_store_path;
use betaclaw_core::channels::messages::service::approval::handler::ApprovalHandlerDeps;
use betaclaw_core::channels::messages::service::conversation::ports::MessageRepositoryPort;
use betaclaw_core::channels::messages::service::core::configuration::{
    get_subagent_max_active_per_conversation, requires_interactive_tool_approval,
};
use betaclaw_core::channels::messages::service::core::project_management::{
    resolve_conversation_workspace, resolve_conversation_workspace_cwd,
};
use betaclaw_core::channels::messages::service::core::types::ServiceState;
use betaclaw_core::channels::messages::service::execution::ports::PortError;
use betaclaw_core::channels::messages::service::inbound::handle_inbound::InboundDeps;
use betaclaw_core::channels::messages::service::message_service::MessageService;
use betaclaw_core::channels::messages::service::orchestration::subagent_tool_approval::SubagentCommandDeps;
use betaclaw_core::channels::messages::service::ports::{ApprovalResponder, CommandPort};
use betaclaw_core::channels::messages::service::ports::{SendResponse, SubagentToolInvoker};
use betaclaw_core::channels::messages::service::routing::model_routing::resolve_chat_model_routing;
use betaclaw_core::channels::messages::service::subagent::executor::SubagentExecutorDeps;
use betaclaw_core::channels::messages::service::subagent::lifecycle::WorkspaceRef;
use betaclaw_core::channels::messages::service::subagent::manager::SubagentManager;
use betaclaw_core::channels::messages::service::subagent::registry::SubagentRegistry;
use betaclaw_core::channels::messages::service::summary_service::SummaryService;
use betaclaw_core::channels::messages::service::tool_manager::ToolManager;
use betaclaw_core::channels::messages::service::utils::response_helper::ResponseHelper;
use betaclaw_core::channels::pairing::credentials::ChannelEnv;
use betaclaw_core::channels::ws::ports::{
    MessageService as WsMessageServicePort, MessageStore as WsMessageStorePort,
    PersonaStore as WsPersonaStorePort,
};
use betaclaw_core::config::GatewayConfig;
use betaclaw_core::gateway::registry::SharedRegistry;
use betaclaw_core::messages_store::types::Conversation;
use betaclaw_core::messages_store::MessageRepositoryError;
use betaclaw_core::model_hub::env::EnvOverrides;
use betaclaw_core::model_hub::http::HttpTransport;
use betaclaw_core::personas::repository::PersonaRepositoryError;
use betaclaw_core::personas::telegram_bots::PersonaTelegramBotRegistry;
use betaclaw_core::personas::workspace::PersonaWorkspace;
use betaclaw_core::skills::builtin_skills::built_in_skills;
use betaclaw_core::skills::exec_approval::ExecApprovalStore;
use betaclaw_core::skills::store::SkillRepository;
use betaclaw_core::skills::types::{SkillEnv, SkillExecConfig};
use betaclaw_core::world_model::config::get_world_model_config;

use crate::families::channels_wire::ChannelInbound;

use commands::Commands;
use events::{inbox_events_enabled, ChatBroadcast, Outbound};
use execution::Execution;
use handlers::Handlers;
use history::History;
use memory::Memory;
use model::ModelHubGateway;
use persona::PersonaStore;
use recall::Recall;
use repo::{MessagesRepo, SessionManager};
use summary::SummaryAdapter;
use tools::{Approvals, Skills, ToolLoop, ToolPort, Tools};
use unwired::{FileSubagentRegistry, SubagentManagerAdapter, WiredSubagentInvoker};
use world::{PgHandle, WorldModel, WorldRetrieval};

/// The wired chat dispatch.
pub struct Services {
    state: Arc<ServiceState>,
    pub message_service: Arc<MessageService>,
    /// The WS family's chat port. It is the dispatch above behind the port the
    /// `chat.*`, `sessions.*` and `channels.*` handlers call.
    pub ws_messages: Arc<dyn WsMessageServicePort>,
    /// The WS family's repository port (`MessageStore`).
    pub ws_store: Arc<dyn WsMessageStorePort>,
    /// The WS family's persona port (`PersonaStore`).
    pub ws_personas: Arc<dyn WsPersonaStorePort>,
}

impl Services {
    pub fn shutdown(&self) {
        let mut active = self
            .state
            .active_requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for signal in active.values() {
            signal.abort();
        }
        active.clear();
    }
    /// The dispatch as the channel routes see it (`channels_wire::build` takes this).
    pub fn inbound(&self) -> Arc<dyn ChannelInbound> {
        self.message_service.clone()
    }
}

/// Start-up failures of [`build`].
#[derive(Debug, thiserror::Error)]
pub enum BuildError {
    #[error("messages store: {0}")]
    Messages(#[from] MessageRepositoryError),
    #[error("personas store: {0}")]
    Personas(#[from] PersonaRepositoryError),
    #[error("model hub store: {0}")]
    ModelHub(String),
    #[error("telegram bot store: {0}")]
    Telegram(String),
    #[error("skills store: {0}")]
    Skills(String),
    #[error("attachment storage: {0}")]
    Attachments(String),
    /// The configuration asks for a feature whose port is not ported. Refused at
    /// start-up, because the port cannot report the gap at call time.
    #[error("not ported yet: {0}")]
    Unported(&'static str),
}

/// Builds the chat dispatch.
///
/// - `config`: `messages_db_path` (conversations, messages, inbox), `personas_db_path`
///   and `personas_root_path` (personas and their workspaces).
/// - `registry`: the client registry the broadcasts go to (`AppState::registry`).
/// - `transport`: the HTTP port of the model hub. Production passes
///   `model_hub_transport::ReqwestTransport`.
///
/// Environment read here: `MODEL_HUB_DB_PATH`, `MODEL_HUB_ENCRYPTION_KEY`, the world
/// model and knowledge settings, `CHAT_SUMMARY_MODE`, `CHAT_AUTO_SESSION_MEMORY`,
/// `BETACLAW_EXEC_APPROVALS_REQUIRED`, `INBOX_V2_EVENTS_ENABLED`.
pub fn build(
    config: &GatewayConfig,
    registry: SharedRegistry,
    transport: Arc<dyn HttpTransport>,
) -> Result<Services, BuildError> {
    let env = EnvOverrides::new();
    let process_env: HashMap<String, String> = std::env::vars().collect();
    let world_model = get_world_model_config();

    let repo = Arc::new(MessagesRepo::open(&config.messages_db_path)?);
    let personas = Arc::new(PersonaStore::open(
        &config.personas_db_path,
        &config.personas_root_path,
    )?);
    let model = Arc::new(
        ModelHubGateway::open(&model_hub_db_path(&env), transport.clone(), env.clone())
            .map_err(|error| BuildError::ModelHub(error.to_string()))?,
    );
    // One World-Model pool, connected on first use, behind both the memory and the retrieval.
    let pg = Arc::new(PgHandle::new(&world_model));
    let memory = Memory::new(&process_env, &world_model, transport.clone(), pg.clone());
    let world = WorldRetrieval::new(world_model.clone(), pg.clone(), transport.clone());
    let bots = PersonaTelegramBotRegistry::open(&config.personas_db_path)
        .map_err(|error| BuildError::Telegram(error.to_string()))?;
    let outbound = Outbound::new(transport.clone(), repo.clone(), bots);
    let events = Arc::new(ChatBroadcast::new(
        registry,
        world_model.clone(),
        pg.clone(),
        inbox_events_enabled(&process_env),
        outbound,
    ));
    let history = Arc::new(History::new(repo.clone(), personas.clone()));
    let send: Arc<dyn SendResponse> =
        Arc::new(ResponseHelper::new(history.clone(), events.clone()));

    let summary_port = Arc::new(SummaryAdapter::from_env(&process_env)?);
    let summary = Arc::new(SummaryService::new(
        repo.clone(),
        summary_port.clone(),
        model.clone(),
        events.clone(),
    ));
    summary_port.bind(&summary);

    // Skills: the registry (seeded like `getSkillRepository`), the environment the handlers
    // read, and the tool backend that runs them.
    let skill_store = SkillRepository::open(&skills_db_path(&process_env))
        .map_err(|error| BuildError::Skills(error.to_string()))?;
    skill_store
        .seed_built_ins(&built_in_skills())
        .map_err(|error| BuildError::Skills(error.to_string()))?;
    let skill_env = Arc::new(SkillEnv {
        personas: PersonaWorkspace::new(config.personas_root_path.clone()),
        approvals: ExecApprovalStore::in_current_dir()
            .unwrap_or_else(|_| ExecApprovalStore::new(".local/exec-approvals.json")),
        exec: SkillExecConfig::from_env(),
    });
    let tool_backend = Arc::new(Tools::new(
        Arc::new(skill_store),
        skill_env,
        transport.clone(),
    ));

    let subagent_invoker = Arc::new(WiredSubagentInvoker::new());
    let subagent: Arc<dyn SubagentToolInvoker> = subagent_invoker.clone();
    // toolManager.ts takes the approval flag as a closure; the environment is read once here.
    let interactive_approval = requires_interactive_tool_approval(&env);
    let tools = Arc::new(ToolManager::new(
        tool_backend,
        Box::new(move || interactive_approval),
        Some(subagent.clone()),
    ));

    // `respondToolApproval` and the command handlers run on the same ports as the inbound
    // pipeline. The environment is shared, because the routing reads it per conversation.
    let session = Arc::new(SessionManager::new(repo.clone()));
    let env = Arc::new(env);
    let repo_port: Arc<dyn MessageRepositoryPort> = repo.clone();
    let get_conversation = {
        let repo = repo_port.clone();
        Arc::new(move |id: &str, user: &str| repo.get_conversation(id, Some(user)).ok().flatten())
    };
    let resolve_routing = {
        let personas = personas.clone();
        let env = env.clone();
        Arc::new(move |conversation: &Conversation| {
            resolve_chat_model_routing(conversation, &*personas, &env)
        })
    };
    let model_loop = Arc::new(ToolLoop {
        model: model.clone(),
        tools: tools.clone(),
    });
    let subagent_store_path = resolve_store_path(
        process_env
            .get("SUBAGENT_RUNS_STORE_PATH")
            .map(String::as_str),
        &std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")),
    );
    let subagent_registry: Arc<dyn SubagentRegistry> =
        Arc::new(FileSubagentRegistry::new(subagent_store_path));
    let max_active = {
        let env = env.clone();
        Arc::new(move || get_subagent_max_active_per_conversation(&env).max(1) as usize)
    };
    let subagent_workspace = {
        let repo = repo_port.clone();
        Arc::new(move |conversation: &Conversation| {
            resolve_conversation_workspace(conversation, &*repo)
                .ok()
                .flatten()
                .map(|ws| WorkspaceRef {
                    project_id: Some(ws.project_id),
                    workspace_path: Some(ws.workspace_path),
                    workspace_relative_path: ws.workspace_relative_path,
                })
        })
    };
    let subagent_manager = Arc::new(SubagentManager::new(
        subagent_registry.clone(),
        max_active,
        Some(subagent_workspace),
    ));
    let subagent_executor = Arc::new(SubagentExecutorDeps {
        manager: subagent_manager.clone(),
        registry: subagent_registry,
        tool_manager: Arc::new(ToolPort(tools.clone())),
        resolve_routing: resolve_routing.clone(),
        model_loop: model_loop.clone(),
        sink: send.clone(),
    });
    let subagent_command_deps = Arc::new(SubagentCommandDeps::new(
        subagent_manager.clone(),
        subagent_executor.clone(),
    ));
    subagent_invoker.bind(
        subagent_executor,
        get_conversation.clone(),
        subagent_command_deps.clone(),
    );

    let approval_deps = ApprovalHandlerDeps {
        session: session.clone(),
        chat: history.clone(),
        tool_manager: Arc::new(ToolPort(tools.clone())),
        summary: summary_port.clone(),
        persona: personas.clone(),
        model_loop,
        get_conversation,
        set_project_guard_approved: {
            let repo = repo_port.clone();
            Arc::new(move |id: &str, user: &str, approved: bool| {
                if let Err(error) = repo.set_conversation_project_guard_approved(id, user, approved)
                {
                    tracing::warn!("chat_runtime: project guard flag was not stored: {error}");
                }
            })
        },
        resolve_workspace_cwd: {
            let repo = repo_port.clone();
            Arc::new(move |conversation: &Conversation| {
                resolve_conversation_workspace_cwd(conversation, &*repo)
                    .ok()
                    .flatten()
            })
        },
        resolve_routing,
    };
    let approvals: Arc<dyn ApprovalResponder> = Arc::new(Approvals {
        deps: approval_deps,
        sink: send.clone(),
    });
    let commands: Arc<dyn CommandPort> = Arc::new(Commands {
        personas: personas.clone(),
        tools: tools.clone(),
        history: history.clone(),
        subagents: Arc::new(SubagentManagerAdapter(subagent_manager)),
        subagent_deps: subagent_command_deps,
        automation_db_path: automation_db_path(&process_env),
    });

    // Shared by the inbound pipeline and the WS ports (`deleteConversation` and
    // `abortGeneration`).
    let recall: Arc<Recall> = Arc::new(Recall::new(
        repo.clone(),
        &env,
        &process_env,
        &world_model,
        world,
        personas.clone(),
        memory.clone(),
        model.clone(),
        pg.clone(),
    ));
    // `ServiceState`: `activeRequests`, `processingMessages` and the clarifications.
    let state = Arc::new(ServiceState::new());

    let deps = InboundDeps {
        repo: repo.clone(),
        session: session.clone(),
        chat: history.clone(),
        events: events.clone(),
        world_model: Arc::new(WorldModel::new(world_model, pg)),
        personas: personas.clone(),
        recall: recall.clone(),
        skills: Arc::new(Skills),
        model,
        summary,
        tools,
        commands,
        approvals,
        handlers: Arc::new(Handlers::new(memory)),
        execution: Arc::new(Execution::from_env(&env)),
        send,
        state: state.clone(),
        env,
    };

    let message_service = Arc::new(MessageService::new(deps, subagent));
    // The attachment files of the chat routes: the channel family's production store,
    // built from the same environment (`CHAT_ATTACHMENTS_DIR`).
    let attachments = Arc::new(
        super::channels_wire::attachments::AttachmentStore::new(
            ChannelEnv::new().get("CHAT_ATTACHMENTS_DIR").as_deref(),
            &config.personas_root_path,
        )
        .map_err(BuildError::Attachments)?,
    );
    let ws_messages = Arc::new(ws_ports::WsMessages::new(
        message_service.clone(),
        repo.clone(),
        session,
        state.clone(),
        summary_port,
        recall,
        attachments,
    ));

    Ok(Services {
        state,
        message_service,
        ws_messages,
        ws_store: Arc::new(ws_ports::WsStore::new(repo)),
        ws_personas: Arc::new(ws_ports::WsPersonas::new(personas)),
    })
}

/// `MODEL_HUB_DB_PATH`, resolved like `routes::model_hub` does.
fn model_hub_db_path(env: &EnvOverrides) -> String {
    env.get("MODEL_HUB_DB_PATH")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| ".local/model-hub.db".to_string())
}

/// `SKILLS_DB_PATH`, default `.local/skills.db` (`skillRepository.ts`).
fn skills_db_path(process_env: &HashMap<String, String>) -> String {
    process_env
        .get("SKILLS_DB_PATH")
        .filter(|value| !value.is_empty())
        .cloned()
        .unwrap_or_else(|| ".local/skills.db".to_string())
}

/// `AUTOMATION_DB_PATH` / `DATABASE_PATH` (`automation/runtime.ts`), default `mission-control.db`.
fn automation_db_path(process_env: &HashMap<String, String>) -> String {
    process_env
        .get("AUTOMATION_DB_PATH")
        .or_else(|| process_env.get("DATABASE_PATH"))
        .filter(|value| !value.is_empty())
        .cloned()
        .unwrap_or_else(|| "mission-control.db".to_string())
}

/// Any port failure, as the message the dispatch and the routes log.
pub(crate) fn failed(error: impl std::fmt::Display) -> PortError {
    PortError::Failed(error.to_string())
}

/// A port with no production implementation yet. The message names the port and the method.
pub(crate) fn not_wired(port: &str, method: &str) -> PortError {
    PortError::Failed(format!("chat_runtime: {port}::{method} is not wired yet"))
}

/// A count as the store takes it. Values above `i64::MAX` cannot occur in practice.
pub(crate) fn to_i64(value: usize) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod test_support {
    use std::path::PathBuf;

    /// A scratch directory under the system temp dir, removed on drop.
    pub struct Scratch(PathBuf);

    impl Scratch {
        pub fn new() -> Self {
            let path = std::env::temp_dir().join(format!("chat-runtime-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("create scratch dir");
            Self(path)
        }

        /// A file path inside the scratch directory.
        pub fn path(&self, name: &str) -> String {
            self.0.join(name).to_string_lossy().into_owned()
        }

        /// A directory inside the scratch directory, created.
        pub fn dir(&self, name: &str) -> String {
            let path = self.0.join(name);
            std::fs::create_dir_all(&path).expect("create scratch subdir");
            path.to_string_lossy().into_owned()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::Scratch;
    use super::*;
    use betaclaw_core::channels::messages::service::inbound::handle_inbound::{
        InboundOptions, InboundParams,
    };
    use betaclaw_core::gateway::registry::ClientRegistry;
    use betaclaw_core::messages_store::types::ChannelType;
    use betaclaw_core::messages_store::MessagesStore;
    use betaclaw_core::model_hub::http::UnreachableTransport;

    fn config_in(scratch: &Scratch) -> GatewayConfig {
        let mut config = GatewayConfig::from_env().expect("test configuration resolves");
        config.messages_db_path = scratch.path("messages.db");
        config.personas_db_path = scratch.path("personas.db");
        config.personas_root_path = scratch.dir("personas");
        config
    }

    #[tokio::test]
    async fn wired_dispatch_stores_the_user_message_and_ends_in_a_named_error() {
        let scratch = Scratch::new();
        // The skill registry opens at `SKILLS_DB_PATH`; keep it out of the working directory.
        std::env::set_var("SKILLS_DB_PATH", scratch.path("skills.db"));
        let config = config_in(&scratch);
        let services = build(
            &config,
            Arc::new(ClientRegistry::new()),
            Arc::new(UnreachableTransport),
        )
        .expect("the chat runtime builds from a fresh configuration");

        let outcome = services
            .message_service
            .handle_inbound(InboundParams {
                platform: ChannelType::WebChat,
                external_chat_id: "web-1".into(),
                content: "hallo".into(),
                sender_name: None,
                external_msg_id: None,
                user_id: None,
                client_message_id: None,
                attachment_metadata: None,
                on_stream_delta: None,
                opts: InboundOptions::default(),
            })
            .await;

        // The turn runs through the wired stages, the skill registry included, and stops at the
        // model hub: the test environment has no MODEL_HUB_ENCRYPTION_KEY. The dispatch stores
        // that failure as the agent's reply.
        let result = outcome.expect("the turn completes with a stored reply");
        let reply = &result.agent_msg;
        assert!(
            reply.content.starts_with("AI dispatch failed: ")
                && reply.content.contains("MODEL_HUB_ENCRYPTION_KEY"),
            "unexpected reply: {}",
            reply.content
        );

        // The user message went through the real messages store before the turn stopped.
        let user = betaclaw_core::auth::LEGACY_LOCAL_USER_ID;
        let store = MessagesStore::open(&config.messages_db_path).expect("reopen store");
        let conversation = store
            .get_conversation_by_external_chat("WebChat", "web-1", Some(user))
            .expect("query")
            .expect("conversation was created");
        let messages = store
            .list_messages(&conversation.id, 10, None, Some(user))
            .expect("list");
        assert!(
            messages
                .iter()
                .any(|m| m.role == "user" && m.content == "hallo"),
            "user message not stored: {messages:?}"
        );
    }

    #[test]
    fn build_refuses_the_unported_auto_memory_heuristic() {
        // The mode is read from the process environment; test it through the adapter.
        let env: HashMap<String, String> = [(
            "CHAT_AUTO_SESSION_MEMORY".to_string(),
            "heuristic".to_string(),
        )]
        .into();
        assert!(matches!(
            summary::SummaryAdapter::from_env(&env),
            Err(BuildError::Unported(_))
        ));
    }
}
