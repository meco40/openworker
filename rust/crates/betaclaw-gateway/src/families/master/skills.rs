//! Port of `dispatchSkill` (`src/server/skills/executeSkill.ts:126-143`) for the names
//! whose handler ports exist in `betaclaw-core::skills`.
//!
//! The TypeScript table holds about 35 handlers and an external-skill host. [`CoreSkillDispatcher`]
//! answers every name whose core port exists — `file_read`, `read`, `write`, `edit`,
//! `apply_patch`, `shell_execute`/`exec`, `python_execute`, `playwright_cli`, `web_search`,
//! `web_fetch`, `http_request`, `browser_snapshot`, `vision_analyze` and `pdf_generate` — and
//! reports every other name as `Unsupported skill`, the TypeScript error for an unknown name.
//!
//! The names that still have no port are listed as open points rather than answered wrongly:
//! - `notifications` (needs the SMTP mail transport and its config, not wired here),
//! - `db_query` (needs the runtime config store and the workspace database path),
//! - `process_manager`/`process` (owns mutable process state of its own),
//! - `memory_search`/`memory_get` (the memory runtime, `MemoryCompatRuntime`, is the S5 slice),
//! - `gateway_self_heal` (the gateway runtime, `GatewayRuntime`, is the gateway itself),
//! - `github_query`, `subagents`, `agents_list`, `sessions_*`, `session_status`, `message`,
//!   `multi_tool_use_parallel` (not ported in S11).
//!
//! The exec handlers (`shell_execute`, `python_execute`, `playwright_cli`) keep the exec-approval
//! gate and the workspace path guard inside the core handlers: the dispatcher only supplies the
//! [`SkillEnv`] and the dispatch context, so a call cannot bypass either boundary.
//!
//! The seam is async. Nesting a synchronous bridge around an awaited skill would
//! block a runtime inside itself, so the tool runner awaits the whole effect chain
//! once, at its synchronous boundary.

use std::env;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use betaclaw_core::model_hub::http::HttpTransport;
use betaclaw_core::net_guard::ssrf_guard::{Resolver, SystemResolver};
use betaclaw_core::skills::browser_snapshot::browser_snapshot;
use betaclaw_core::skills::coding_compat::{
    apply_patch_compat, edit_compat, read_compat, write_compat,
};
use betaclaw_core::skills::file_read::{file_read, FileReadOutput};
use betaclaw_core::skills::http_request::http_request;
use betaclaw_core::skills::pdf_generate::pdf_generate;
use betaclaw_core::skills::playwright_cli::{playwright_cli, PlaywrightResult};
use betaclaw_core::skills::python_execute::python_execute;
use betaclaw_core::skills::shell_execute::{shell_execute, ShellOutput};
use betaclaw_core::skills::types::{SkillDispatchContext, SkillEnv};
use betaclaw_core::skills::vision_analyze::vision_analyze;
use betaclaw_core::skills::web_fetch::web_fetch;
use betaclaw_core::skills::web_search::web_search;
use betaclaw_core::skills::workspace_fs::resolve_workspace_root;
use serde_json::{json, Map, Value};

/// The future of one skill call. It is not `Send`, because the core handlers borrow
/// the transport; the tool runner drives it on the calling thread.
pub type SkillFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + 'a>>;

/// One `dispatchSkill(name, args, context)` call.
pub struct SkillInvocation<'a> {
    pub name: &'a str,
    pub args: &'a Map<String, Value>,
    pub bypass_approval: bool,
    pub workspace_cwd: Option<&'a str>,
}

/// The skill seam of the Master runtime. An `Err` is the TypeScript thrown `Error`.
pub trait SkillDispatcher: Send + Sync {
    fn dispatch<'a>(&'a self, invocation: SkillInvocation<'a>) -> SkillFuture<'a>;
}

/// The core-backed dispatcher for the ported skill handlers.
pub struct CoreSkillDispatcher {
    transport: Arc<dyn HttpTransport + Send + Sync>,
    resolver: Arc<dyn Resolver>,
    brave_api_key: Option<String>,
    /// `vision.gemini_api_key`, falling back to `GEMINI_API_KEY`. The runtime config store is not
    /// wired here, so only the environment fallback is read (open point).
    gemini_api_key: Option<String>,
    /// `BETACLAW_HTTP_SKILL_ENABLED` equal to `"true"`, ignoring case.
    http_request_enabled: bool,
    env: SkillEnv,
}

impl CoreSkillDispatcher {
    /// Builds the dispatcher from the transport, the Brave key and the skill environment.
    /// The resolver defaults to [`SystemResolver`]; the Gemini key and the `http_request`
    /// switch are read from the process environment, as the TypeScript handlers do.
    pub fn new(
        transport: Arc<dyn HttpTransport + Send + Sync>,
        brave_api_key: Option<String>,
        env: SkillEnv,
    ) -> Self {
        Self {
            transport,
            resolver: Arc::new(SystemResolver),
            brave_api_key,
            gemini_api_key: env::var("GEMINI_API_KEY")
                .ok()
                .filter(|key| !key.is_empty()),
            http_request_enabled: env::var("BETACLAW_HTTP_SKILL_ENABLED")
                .is_ok_and(|value| value.to_lowercase() == "true"),
            env,
        }
    }

    /// Replaces the resolver, so tests can point the SSRF guard at chosen addresses.
    pub fn with_resolver(mut self, resolver: Arc<dyn Resolver>) -> Self {
        self.resolver = resolver;
        self
    }

    /// Replaces the `http_request` switch, so tests do not depend on the host environment.
    pub fn with_http_request_enabled(mut self, enabled: bool) -> Self {
        self.http_request_enabled = enabled;
        self
    }
}

impl SkillDispatcher for CoreSkillDispatcher {
    fn dispatch<'a>(&'a self, invocation: SkillInvocation<'a>) -> SkillFuture<'a> {
        Box::pin(async move {
            let context = SkillDispatchContext {
                bypass_approval: invocation.bypass_approval,
                workspace_cwd: invocation.workspace_cwd.map(str::to_string),
            };
            let args = invocation.args;
            match invocation.name {
                "file_read" => {
                    let root = resolve_workspace_root(&self.env.personas, &context)
                        .map_err(|error| error.to_string())?;
                    file_read(args, &root)
                        .await
                        .map(file_read_json)
                        .map_err(|error| error.to_string())
                }
                "read" => read_compat(args, &context, &self.env.personas)
                    .await
                    .map_err(|error| error.to_string()),
                "write" => write_compat(args, &context, &self.env.personas)
                    .await
                    .map_err(|error| error.to_string()),
                "edit" => edit_compat(args, &context, &self.env.personas)
                    .await
                    .map_err(|error| error.to_string()),
                "apply_patch" => apply_patch_compat(args, &context, &self.env.personas)
                    .await
                    .map_err(|error| error.to_string()),
                "shell_execute" | "exec" => shell_execute(args, &context, &self.env)
                    .await
                    .map(shell_json)
                    .map_err(|error| error.to_string()),
                "python_execute" => python_execute(args, &context, &self.env)
                    .await
                    .map(shell_json)
                    .map_err(|error| error.to_string()),
                "playwright_cli" => playwright_cli(args, &context, &self.env)
                    .await
                    .map(playwright_json)
                    .map_err(|error| error.to_string()),
                "web_search" => web_search(&*self.transport, args, self.brave_api_key.as_deref())
                    .await
                    .map_err(|error| error.to_string()),
                "web_fetch" => web_fetch(&*self.transport, &*self.resolver, args)
                    .await
                    .map_err(|error| error.to_string()),
                "http_request" => http_request(
                    &*self.transport,
                    &*self.resolver,
                    args,
                    self.http_request_enabled,
                )
                .await
                .map_err(|error| error.to_string()),
                "browser_snapshot" => browser_snapshot(&*self.transport, &*self.resolver, args)
                    .await
                    .map_err(|error| error.to_string()),
                "vision_analyze" => {
                    vision_analyze(&*self.transport, args, self.gemini_api_key.as_deref())
                        .await
                        .map_err(|error| error.to_string())
                }
                "pdf_generate" => pdf_generate(args, &context).map_err(|error| error.to_string()),
                other => Err(format!("Unsupported skill: {other}")),
            }
        })
    }
}

/// `{ stdout, stderr, exitCode }` for the shell and Python handlers.
fn shell_json(output: ShellOutput) -> Value {
    json!({
        "stdout": output.stdout,
        "stderr": output.stderr,
        "exitCode": output.exit_code,
    })
}

/// `{ path, resolvedPath, truncated, content }` for `file_read`.
fn file_read_json(output: FileReadOutput) -> Value {
    json!({
        "path": output.path,
        "resolvedPath": output.resolved_path.to_string_lossy(),
        "truncated": output.truncated,
        "content": output.content,
    })
}

/// `{ command, cwd, stdout, stderr, exitCode, signal? }` for `playwright_cli`.
/// `signal` is omitted unless the run was killed by a signal, as in TypeScript.
fn playwright_json(result: PlaywrightResult) -> Value {
    let mut object = Map::new();
    object.insert("command".to_string(), json!(result.command));
    object.insert("cwd".to_string(), json!(result.cwd));
    object.insert("stdout".to_string(), json!(result.stdout));
    object.insert("stderr".to_string(), json!(result.stderr));
    object.insert("exitCode".to_string(), json!(result.exit_code));
    if let Some(signal) = result.signal {
        object.insert("signal".to_string(), json!(signal));
    }
    Value::Object(object)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use betaclaw_core::model_hub::http::HttpTransport;
    use betaclaw_core::personas::PersonaWorkspace;
    use betaclaw_core::skills::exec_approval::ExecApprovalStore;
    use betaclaw_core::skills::types::{SkillEnv, SkillExecConfig};
    use betaclaw_core::world_model::db::drive_sync;
    use serde_json::{Map, Value};

    use super::{CoreSkillDispatcher, SkillDispatcher, SkillInvocation};
    use crate::model_hub_transport::ReqwestTransport;

    fn dispatcher(root: &std::path::Path) -> CoreSkillDispatcher {
        let transport: Arc<dyn HttpTransport + Send + Sync> = Arc::new(ReqwestTransport::new());
        CoreSkillDispatcher::new(
            transport,
            None,
            SkillEnv {
                personas: PersonaWorkspace::new(root.join("personas")),
                approvals: ExecApprovalStore::new(root.join("approvals.json")),
                exec: SkillExecConfig::from_env(),
            },
        )
    }

    /// Runs one call to completion on a temporary runtime. The `http_request` gate is pinned
    /// off, so the tests never read the host environment.
    fn call(name: &str, args: &Map<String, Value>) -> Result<Value, String> {
        let root = std::env::temp_dir().join(format!("skills-{}", uuid::Uuid::new_v4().simple()));
        let dispatcher = dispatcher(&root).with_http_request_enabled(false);
        drive_sync(dispatcher.dispatch(SkillInvocation {
            name,
            args,
            bypass_approval: false,
            workspace_cwd: None,
        }))
        .expect("runtime available")
    }

    #[test]
    fn an_unknown_skill_is_unsupported() {
        let args = Map::new();
        assert_eq!(
            call("no_such_skill", &args),
            Err("Unsupported skill: no_such_skill".to_string())
        );
    }

    #[test]
    fn a_write_without_a_path_reports_the_handler_error() {
        let args = Map::new();
        assert_eq!(
            call("write", &args),
            Err("write requires path.".to_string())
        );
    }

    /// The names added in S11 reach their core handler instead of the `Unsupported` arm.
    #[test]
    fn the_extended_names_reach_their_core_handlers() {
        let args = Map::new();
        assert_eq!(call("read", &args), Err("read requires path.".to_string()));
        assert_eq!(
            call("exec", &args),
            Err("shell_execute requires command.".to_string())
        );
        assert_eq!(
            call("python_execute", &args),
            Err("python_execute requires code.".to_string())
        );
    }

    /// `http_request` is gated by `BETACLAW_HTTP_SKILL_ENABLED`; disabled, it returns the
    /// TypeScript error object and never touches the network.
    #[test]
    fn http_request_is_gated_and_returns_the_disabled_object() {
        let args = Map::new();
        let result = call("http_request", &args).expect("handled");
        assert_eq!(
            result["error"],
            "http_request skill is disabled. Set BETACLAW_HTTP_SKILL_ENABLED=true in your environment to enable it."
        );
    }
}
