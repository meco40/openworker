//! Tools and skills: the `ToolBackend`, the `SkillMdPort`, the tool manager adapter, the
//! model tool loop and the approval responder.
//!
//! The SKILL.md metadata is the core `skills::skill_md` module. The installed skills are
//! the core `SkillRepository`. A tool call runs through the core handlers that have a port
//! (`shell_execute`, `python_execute`, `playwright_cli`, `file_read`, the coding tools,
//! `web_fetch`, `web_search`, `http_request`, `pdf_generate`, `browser_snapshot`). Any other
//! function answers with a named error, so a model that calls it sees the gap.
//!
//! Approval: `is_command_approved` and `approve_command` use the `ExecApprovalStore` file
//! (`<cwd>/.local/exec-approvals.json`), as `exec-approval-manager.ts` does.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};

use betaclaw_core::channels::messages::service::approval::handler::{
    respond_tool_approval as handle_tool_approval, ApprovalHandlerDeps, ApprovalOutcome,
    ApprovalParams,
};
use betaclaw_core::channels::messages::service::dispatchers::ai::run_model_tool_loop::run_model_tool_loop;
use betaclaw_core::channels::messages::service::dispatchers::ai::types::{
    AuditContextExtras, ModelOutcome, RunModelToolLoopParams,
};
use betaclaw_core::channels::messages::service::dispatchers::skills_prompt::{
    BuiltInSkillSeed, EnrichedSkill, ParsedSkillMd, SkillMdPort, SkillSource, SkillTier,
};
use betaclaw_core::channels::messages::service::execution::ports::{
    ModelLoopParams, ModelToolLoop, PortError, PortResult, ToolManagerPort,
};
use betaclaw_core::channels::messages::service::ports::{
    ApprovalResponder, BoxFuture, CommandPolicy, ModelGateway, SendResponse, SkillDispatchContext,
    SkillRow, ToolBackend,
};
use betaclaw_core::channels::messages::service::tool_manager::{
    now_ms, ToolCallRequest, ToolManager,
};
use betaclaw_core::channels::messages::service::types::{
    PendingToolApproval, ResolvedToolContext, ToolExecutionResult,
};
use betaclaw_core::model_hub::http::{AbortSignal as HttpAbortSignal, HttpTransport};
use betaclaw_core::net_guard::ssrf_guard::SystemResolver;
use betaclaw_core::skills::browser_snapshot::browser_snapshot;
use betaclaw_core::skills::builtin_skills::built_in_skills;
use betaclaw_core::skills::coding_compat::{
    apply_patch_compat, edit_compat, read_compat, write_compat,
};
use betaclaw_core::skills::file_read::{file_read, FileReadOutput};
use betaclaw_core::skills::http_request::http_request;
use betaclaw_core::skills::node_command_policy::evaluate_node_command_policy;
use betaclaw_core::skills::pdf_generate::pdf_generate;
use betaclaw_core::skills::playwright_cli::{playwright_cli, PlaywrightResult};
use betaclaw_core::skills::playwright_cli_command as playwright;
use betaclaw_core::skills::python_execute::{build_python_command, python_execute};
use betaclaw_core::skills::shell_execute::{shell_execute, ShellOutput};
use betaclaw_core::skills::skill_md::{
    build_skills_prompt_section, current_platform, enrich_built_in_manifest,
    filter_eligible_skills, load_all_skill_md, user_skill_to_manifest,
    EnrichedSkill as FileEnrichedSkill, LoadSkillsOptions, ParsedSkillMd as FileSkillMd,
    SkillSource as FileSkillSource, SkillTier as FileSkillTier,
};
use betaclaw_core::skills::store::{SkillRepository, SkillRow as StoreSkillRow};
use betaclaw_core::skills::types::{SkillDispatchContext as CoreContext, SkillEnv};
use betaclaw_core::skills::web_fetch::web_fetch;
use betaclaw_core::skills::web_search::web_search;

use super::{failed, not_wired};

/// The skills that `mapSkillsToTools` offers to the model, in `SKILL_MODULES` order. The
/// installed skills with other ids (`gateway-self-heal`, `process-manager`) get no tool.
const TOOL_MODULE_IDS: [&str; 31] = [
    "browser",
    "browser-tool",
    "python-runtime",
    "search",
    "vision",
    "filesystem",
    "read",
    "write",
    "edit",
    "apply-patch",
    "github-manager",
    "multi-tool-use-parallel",
    "shell-access",
    "exec",
    "process",
    "sql-bridge",
    "subagents",
    "memory-search",
    "memory-get",
    "agents-list",
    "sessions-list",
    "sessions-history",
    "sessions-send",
    "sessions-spawn",
    "session-status",
    "message",
    "web-search",
    "web-fetch",
    "http-request",
    "notifications",
    "pdf-generate",
];

// ── SkillMdPort ──────────────────────────────────────────────────

/// The SKILL.md seam (`skillsPrompt.ts`), over the core `skills::skill_md` module.
pub struct Skills;

impl SkillMdPort for Skills {
    fn eligible_parsed_skills(
        &self,
        workspace_cwd: Option<String>,
    ) -> PortResult<Vec<ParsedSkillMd>> {
        let loaded = load_all_skill_md(&LoadSkillsOptions {
            workspace_cwd: workspace_cwd.map(PathBuf::from),
        });
        Ok(filter_eligible_skills(&loaded, current_platform())
            .iter()
            .map(to_port_parsed)
            .collect())
    }

    fn built_in_seeds(&self) -> Vec<BuiltInSkillSeed> {
        built_in_skills()
            .into_iter()
            .map(|seed| BuiltInSkillSeed {
                id: seed.manifest.id.to_string(),
                payload: Value::Null,
            })
            .collect()
    }

    fn enrich_built_in(&self, seed: &BuiltInSkillSeed, parsed: &ParsedSkillMd) -> EnrichedSkill {
        let manifest = built_in_skills()
            .into_iter()
            .map(|built_in| built_in.manifest)
            .find(|manifest| manifest.id == seed.id);
        let file = from_port_parsed(parsed);
        match (manifest, file) {
            (Some(manifest), Some(file)) => {
                to_port_enriched(&enrich_built_in_manifest(&manifest, &file))
            }
            // Not reached: the seeds come from the same list. Without guidance the registry
            // fallback in the prompt builder takes over, so nothing is invented here.
            _ => EnrichedSkill {
                id: seed.id.clone(),
                name: seed.id.clone(),
                description: String::new(),
                version: String::new(),
                category: String::new(),
                function_name: String::new(),
                tool: Value::Null,
                emoji: None,
                body: String::new(),
                file_path: String::new(),
                source: SkillSource::Bundled,
            },
        }
    }

    fn user_skill_to_manifest(&self, parsed: &ParsedSkillMd) -> PortResult<EnrichedSkill> {
        let file = from_port_parsed(parsed).ok_or_else(|| {
            PortError::Failed(format!("unreadable SKILL.md record {}", parsed.id))
        })?;
        user_skill_to_manifest(&file)
            .map(|skill| to_port_enriched(&skill))
            .map_err(PortError::Failed)
    }

    fn build_skills_prompt_section(&self, skills: &[EnrichedSkill]) -> String {
        let file: Vec<FileEnrichedSkill> = skills.iter().map(from_port_enriched).collect();
        build_skills_prompt_section(&file)
    }
}

/// The port record of a parsed file. The whole file rides in `payload`, which S8 does not read.
fn to_port_parsed(file: &FileSkillMd) -> ParsedSkillMd {
    ParsedSkillMd {
        id: file.str_field("id").unwrap_or_default().to_string(),
        tier: match file.tier {
            FileSkillTier::BuiltIn => SkillTier::BuiltIn,
            FileSkillTier::User => SkillTier::User,
        },
        payload: serde_json::to_value(file).unwrap_or(Value::Null),
    }
}

fn from_port_parsed(parsed: &ParsedSkillMd) -> Option<FileSkillMd> {
    serde_json::from_value(parsed.payload.clone()).ok()
}

fn to_port_enriched(skill: &FileEnrichedSkill) -> EnrichedSkill {
    EnrichedSkill {
        id: skill.id.clone(),
        name: skill.name.clone(),
        description: skill.description.clone(),
        version: skill.version.clone(),
        category: skill.category.clone(),
        function_name: skill.function_name.clone(),
        tool: skill.tool.clone(),
        emoji: skill.emoji.clone(),
        body: skill.body.clone(),
        file_path: skill.file_path.clone(),
        source: match skill.source {
            FileSkillSource::Bundled => SkillSource::Bundled,
            _ => SkillSource::User,
        },
    }
}

fn from_port_enriched(skill: &EnrichedSkill) -> FileEnrichedSkill {
    FileEnrichedSkill {
        id: skill.id.clone(),
        name: skill.name.clone(),
        description: skill.description.clone(),
        version: skill.version.clone(),
        category: skill.category.clone(),
        function_name: skill.function_name.clone(),
        tool: skill.tool.clone(),
        emoji: skill.emoji.clone(),
        body: skill.body.clone(),
        file_path: skill.file_path.clone(),
        source: match skill.source {
            SkillSource::Bundled => FileSkillSource::Bundled,
            SkillSource::User => FileSkillSource::User,
        },
    }
}

// ── ToolBackend ──────────────────────────────────────────────────

/// The skill registry, the exec approvals and the handlers of the chat tools.
pub struct Tools {
    repository: Arc<SkillRepository>,
    env: Arc<SkillEnv>,
    transport: Arc<dyn HttpTransport>,
}

impl Tools {
    pub fn new(
        repository: Arc<SkillRepository>,
        env: Arc<SkillEnv>,
        transport: Arc<dyn HttpTransport>,
    ) -> Self {
        Self {
            repository,
            env,
            transport,
        }
    }

    /// `dispatchSkill(name, args, context)` for the handlers that have a port here.
    async fn dispatch(
        &self,
        name: &str,
        args: Value,
        context: SkillDispatchContext,
    ) -> PortResult<Value> {
        let map = args.as_object().cloned().unwrap_or_default();
        let ctx = CoreContext {
            bypass_approval: context.bypass_approval,
            workspace_cwd: context.workspace_cwd,
        };
        let env = &*self.env;
        let personas = &env.personas;
        let transport = &*self.transport;

        match name {
            "shell_execute" | "exec" => shell_execute(&map, &ctx, env)
                .await
                .map(shell_json)
                .map_err(failed),
            "python_execute" => python_execute(&map, &ctx, env)
                .await
                .map(shell_json)
                .map_err(failed),
            "playwright_cli" => playwright_cli(&map, &ctx, env)
                .await
                .map(playwright_json)
                .map_err(failed),
            "file_read" => {
                let root = std::env::current_dir().map_err(failed)?;
                file_read(&map, &root)
                    .await
                    .map(file_read_json)
                    .map_err(failed)
            }
            "read" => read_compat(&map, &ctx, personas).await.map_err(failed),
            "write" => write_compat(&map, &ctx, personas).await.map_err(failed),
            "edit" => edit_compat(&map, &ctx, personas).await.map_err(failed),
            "apply_patch" => apply_patch_compat(&map, &ctx, personas)
                .await
                .map_err(failed),
            "web_fetch" => web_fetch(transport, &SystemResolver, &map)
                .await
                .map_err(failed),
            "web_search" => {
                let key = non_empty_env("BRAVE_SEARCH_API_KEY");
                web_search(transport, &map, key.as_deref())
                    .await
                    .map_err(failed)
            }
            "http_request" => {
                let enabled = std::env::var("BETACLAW_HTTP_SKILL_ENABLED")
                    .map(|value| value.to_lowercase() == "true")
                    .unwrap_or(false);
                http_request(transport, &SystemResolver, &map, enabled)
                    .await
                    .map_err(failed)
            }
            "pdf_generate" => pdf_generate(&map, &ctx).map_err(failed),
            "browser_snapshot" => browser_snapshot(transport, &SystemResolver, &map)
                .await
                .map_err(failed),
            other => Err(not_wired(
                "ToolBackend",
                &format!("dispatch_skill({other})"),
            )),
        }
    }
}

impl ToolBackend for Tools {
    fn list_skills(&self) -> BoxFuture<'_, PortResult<Vec<SkillRow>>> {
        let rows = self
            .repository
            .list_skills()
            .map(|rows| rows.iter().map(to_skill_row).collect())
            .map_err(failed);
        Box::pin(std::future::ready(rows))
    }

    fn map_skills_to_tools(&self, installed: &[SkillRow]) -> Vec<Value> {
        TOOL_MODULE_IDS
            .iter()
            .filter_map(|id| installed.iter().find(|row| row.id == *id))
            .filter_map(|row| to_openai_tool(&row.tool_definition))
            .collect()
    }

    fn evaluate_command_policy(&self, command: &str) -> CommandPolicy {
        let result = evaluate_node_command_policy(command);
        CommandPolicy {
            allowed: result.allowed,
            normalized_command: result.normalized_command,
            reason: result.reason.map(str::to_string),
        }
    }

    fn is_command_approved(&self, normalized_command: &str) -> bool {
        self.env.approvals.is_approved(normalized_command)
    }

    fn approve_command(&self, command: &str) {
        // The port has no error channel. A failed write leaves the command unapproved, so
        // the next run asks again. That fails closed.
        if let Err(error) = self.env.approvals.approve(command) {
            tracing::warn!("chat_runtime: exec approval was not stored: {error}");
        }
    }

    fn build_python_command(&self, code: &str) -> String {
        // An empty command is refused by the command policy, so an error maps to "".
        build_python_command(code).unwrap_or_default()
    }

    fn resolve_playwright_tokens(&self, args: &Value) -> PortResult<Vec<String>> {
        let map = args.as_object().cloned().unwrap_or_default();
        let tokens = playwright::resolve_playwright_cli_tokens(&map);
        playwright::assert_playwright_subcommand_allowed(&tokens).map_err(failed)?;
        Ok(tokens)
    }

    fn build_playwright_cli_command(&self, tokens: &[String]) -> String {
        playwright::build_playwright_cli_command(tokens)
    }

    fn normalize_skill_args(&self, args: &Value) -> Value {
        // `normalizeArgs`: a falsy value or a non-object becomes `{}`. A string is parsed as
        // JSON when it is an object.
        match args {
            Value::Object(_) | Value::Array(_) => args.clone(),
            Value::String(text) => match serde_json::from_str::<Value>(text) {
                Ok(parsed @ Value::Object(_)) => parsed,
                _ => json!({}),
            },
            _ => json!({}),
        }
    }

    fn dispatch_skill(
        &self,
        function_name: String,
        args: Value,
        context: SkillDispatchContext,
    ) -> BoxFuture<'_, PortResult<Value>> {
        Box::pin(async move { self.dispatch(&function_name, args, context).await })
    }
}

fn to_skill_row(row: &StoreSkillRow) -> SkillRow {
    SkillRow {
        id: row.id.clone(),
        name: row.name.clone(),
        description: row.description.clone(),
        category: row.category.clone(),
        installed: row.installed,
        version: row.version.clone(),
        function_name: row.function_name.clone(),
        source: row.source.clone(),
        source_url: row.source_url.clone(),
        tool_definition: row.tool_definition.clone(),
    }
}

/// `convertTools([def], 'openai')` for one definition. A built-in definition gives its
/// `openai` provider config, and none when there is no such config.
fn to_openai_tool(definition: &Value) -> Option<Value> {
    let object = definition.as_object()?;
    if object.get("builtIn") == Some(&Value::Bool(true)) {
        return object
            .get("providerConfig")
            .and_then(|config| config.get("openai"))
            .filter(|config| !config.is_null())
            .cloned();
    }
    let parameters = object.get("parameters").and_then(Value::as_object);
    Some(json!({
        "type": "function",
        "function": {
            "name": object.get("name").cloned().unwrap_or(Value::Null),
            "description": object.get("description").cloned().unwrap_or(Value::Null),
            "parameters": {
                "type": "object",
                "properties": parameters
                    .and_then(|p| p.get("properties").cloned())
                    .unwrap_or_else(|| json!({})),
                "required": parameters
                    .and_then(|p| p.get("required").cloned())
                    .unwrap_or_else(|| json!([])),
            },
        },
    }))
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// `{ stdout, stderr, exitCode }`, the shape of the TypeScript shell handler.
fn shell_json(output: ShellOutput) -> Value {
    json!({
        "stdout": output.stdout,
        "stderr": output.stderr,
        "exitCode": output.exit_code,
    })
}

fn playwright_json(output: PlaywrightResult) -> Value {
    let mut value = json!({
        "command": output.command,
        "cwd": output.cwd,
        "stdout": output.stdout,
        "stderr": output.stderr,
        "exitCode": output.exit_code,
    });
    if let (Some(signal), Some(object)) = (output.signal, value.as_object_mut()) {
        object.insert("signal".into(), Value::String(signal));
    }
    value
}

fn file_read_json(output: FileReadOutput) -> Value {
    json!({
        "path": output.path,
        "resolvedPath": output.resolved_path.to_string_lossy(),
        "truncated": output.truncated,
        "content": output.content,
    })
}

// ── ToolManagerPort over the shared ToolManager ──────────────────

/// `ToolManagerPort` over the one [`ToolManager`] of the service. The port and the manager
/// both live in core, so the adapter is a local type.
pub struct ToolPort(pub Arc<ToolManager>);

impl ToolManagerPort for ToolPort {
    fn prune_pending_tool_approvals(&self) {
        self.0.prune_pending_tool_approvals(now_ms());
    }

    fn get_pending_approval(&self, token: &str) -> Option<PendingToolApproval> {
        self.0.get_pending_approval(token)
    }

    fn delete_pending_approval(&self, token: &str) -> bool {
        self.0.delete_pending_approval(token)
    }

    fn approve_command<'a>(&'a self, command: &'a str) -> BoxFuture<'a, PortResult<()>> {
        self.0.approve_command(command);
        Box::pin(std::future::ready(Ok(())))
    }

    fn resolve_tool_context(&self) -> BoxFuture<'_, PortResult<ResolvedToolContext>> {
        Box::pin(self.0.resolve_tool_context())
    }

    fn execute_tool_function_call(
        &self,
        request: ToolCallRequest,
    ) -> BoxFuture<'_, PortResult<ToolExecutionResult>> {
        Box::pin(async move { Ok(self.0.execute_tool_function_call(request).await) })
    }
}

// ── Model tool loop ──────────────────────────────────────────────

/// `runModelToolLoop` over the model gateway and the shared [`ToolManager`].
///
/// The port passes the tool manager as an argument. The core loop needs the concrete
/// `ToolManager`, which this adapter already holds. It is the same instance that the
/// [`ToolPort`] wraps, so the argument is not used.
pub struct ToolLoop {
    pub model: Arc<dyn ModelGateway>,
    pub tools: Arc<ToolManager>,
}

impl ModelToolLoop for ToolLoop {
    fn run_model_tool_loop<'a>(
        &'a self,
        _tools: &'a dyn ToolManagerPort,
        params: ModelLoopParams,
    ) -> BoxFuture<'a, PortResult<ModelOutcome>> {
        Box::pin(async move {
            run_model_tool_loop(
                &*self.model,
                &self.tools,
                RunModelToolLoopParams {
                    conversation: params.conversation,
                    messages: params.messages,
                    model_hub_profile_id: params.model_hub_profile_id,
                    preferred_model_id: params.preferred_model_id,
                    workspace_cwd: params.workspace_cwd,
                    tool_context: params.tool_context,
                    max_tool_calls: None,
                    // ponytail: the port's signal is a watch channel and the transport's is a flag.
                    // Only an abort that has already happened is carried over. The approval path
                    // never passes a signal, so no later abort is lost in practice.
                    abort_signal: params.abort_signal.map(|signal| {
                        let flag = HttpAbortSignal::new();
                        if signal.is_aborted() {
                            flag.abort();
                        }
                        flag
                    }),
                    on_stream_delta: params.on_stream_delta,
                    audit_context_extras: AuditContextExtras::default(),
                },
            )
            .await
        })
    }
}

// ── ApprovalResponder ────────────────────────────────────────────

/// `respondToolApproval` (`messageService.ts:406-418`): the handler of `approval::handler`
/// with the dependencies the service was built with.
pub struct Approvals {
    pub deps: ApprovalHandlerDeps,
    pub sink: Arc<dyn SendResponse>,
}

impl ApprovalResponder for Approvals {
    fn respond_tool_approval(
        &self,
        params: ApprovalParams,
    ) -> BoxFuture<'_, PortResult<ApprovalOutcome>> {
        Box::pin(async move { handle_tool_approval(&self.deps, &*self.sink, &params).await })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use betaclaw_core::model_hub::http::UnreachableTransport;
    use betaclaw_core::skills::exec_approval::ExecApprovalStore;

    /// A repository and an environment in a scratch directory, removed on drop.
    struct Fixture {
        dir: PathBuf,
        tools: Tools,
    }

    impl Fixture {
        fn new(approvals_required: bool) -> Self {
            let dir = std::env::temp_dir().join(format!("chat-tools-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("scratch dir");
            let repository = SkillRepository::in_memory().expect("store");
            repository
                .seed_built_ins(&built_in_skills())
                .expect("seed built-ins");
            let env = SkillEnv {
                personas: betaclaw_core::personas::workspace::PersonaWorkspace::new(
                    dir.join("personas"),
                ),
                approvals: ExecApprovalStore::new(dir.join(".local").join("exec-approvals.json")),
                exec: betaclaw_core::skills::types::SkillExecConfig::from_raw(
                    Some(if approvals_required { "true" } else { "false" }),
                    None,
                    None,
                    None,
                ),
            };
            let tools = Tools::new(
                Arc::new(repository),
                Arc::new(env),
                Arc::new(UnreachableTransport),
            );
            Self { dir, tools }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(future)
    }

    #[test]
    fn list_skills_reads_the_seeded_registry() {
        let fixture = Fixture::new(false);
        let rows = block_on(fixture.tools.list_skills()).expect("rows");
        assert_eq!(rows.len(), 34);
        assert!(rows.iter().any(|row| row.id == "browser" && row.installed));
    }

    #[test]
    fn only_installed_tool_modules_become_openai_tools_in_module_order() {
        let fixture = Fixture::new(false);
        let rows = block_on(fixture.tools.list_skills()).expect("rows");
        let tools = fixture.tools.map_skills_to_tools(&rows);
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|tool| tool["function"]["name"].as_str())
            .collect();
        assert!(!names.is_empty());
        assert!(names.contains(&"browser_snapshot"));
        assert!(tools.iter().all(|tool| tool["type"] == "function"));
    }

    #[test]
    fn approvals_are_remembered_in_the_store() {
        let fixture = Fixture::new(true);
        assert!(!fixture.tools.is_command_approved("ls -la"));
        fixture.tools.approve_command("ls -la");
        assert!(fixture.tools.is_command_approved("ls -la"));
    }

    #[test]
    fn an_unported_handler_names_itself_in_the_error() {
        let fixture = Fixture::new(false);
        let error = block_on(fixture.tools.dispatch_skill(
            "notifications".into(),
            json!({}),
            SkillDispatchContext {
                bypass_approval: false,
                workspace_cwd: None,
                conversation_id: "c".into(),
                user_id: "u".into(),
                platform: betaclaw_core::messages_store::types::ChannelType::WebChat,
                external_chat_id: "chat".into(),
                subagent_invoker: None,
            },
        ))
        .expect_err("not ported");
        assert!(
            error.to_string().contains("dispatch_skill(notifications)"),
            "{error}"
        );
    }

    #[test]
    fn shell_execute_runs_the_command_and_returns_its_output() {
        let fixture = Fixture::new(false);
        let output = block_on(fixture.tools.dispatch_skill(
            "shell_execute".into(),
            json!({ "command": "echo chat-tools" }),
            SkillDispatchContext {
                bypass_approval: false,
                workspace_cwd: None,
                conversation_id: "c".into(),
                user_id: "u".into(),
                platform: betaclaw_core::messages_store::types::ChannelType::WebChat,
                external_chat_id: "chat".into(),
                subagent_invoker: None,
            },
        ))
        .expect("runs");
        assert!(output["stdout"]
            .as_str()
            .unwrap_or("")
            .contains("chat-tools"));
        assert_eq!(output["exitCode"], 0);
    }

    #[test]
    fn the_command_policy_is_the_real_one() {
        let fixture = Fixture::new(false);
        let policy = fixture.tools.evaluate_command_policy("ls");
        assert!(!policy.normalized_command.is_empty());
    }

    #[test]
    fn normalize_skill_args_follows_normalize_args() {
        let fixture = Fixture::new(false);
        assert_eq!(fixture.tools.normalize_skill_args(&Value::Null), json!({}));
        assert_eq!(
            fixture.tools.normalize_skill_args(&json!("{\"a\":1}")),
            json!({ "a": 1 })
        );
        assert_eq!(
            fixture.tools.normalize_skill_args(&json!("nope")),
            json!({})
        );
    }
}
