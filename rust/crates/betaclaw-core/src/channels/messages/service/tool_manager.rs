//! Port of `src/server/channels/messages/service/toolManager.ts`.
//!
//! Owns the pending tool approvals and the command gate. The skill registry, the
//! command policy, the exec approval store, the Python and Playwright command builders
//! and `dispatchSkill` sit behind [`ToolBackend`]. The approval switch
//! (`requiresInteractiveToolApproval`) is a closure, because TypeScript reads the
//! environment on every call.
//!
//! Lengths follow JavaScript: the 50 000 output cap and the truncation offset count
//! UTF-16 units.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};
use uuid::Uuid;

use crate::channels::messages::service::core::types::lock;
use crate::channels::messages::service::execution::ports::PortResult;
use crate::channels::messages::service::ports::{
    SkillDispatchContext, SkillRow, SubagentToolInvoker, ToolBackend,
};
use crate::channels::messages::service::types::{
    PendingToolApproval, ResolvedToolContext, ToolExecutionResult, TOOL_APPROVAL_TTL_MS,
    TOOL_OUTPUT_MAX_CHARS,
};
use crate::channels::messages::service::utils::js_regex::{slice_utf16, utf16_len};
use crate::messages_store::types::{ChannelType, Conversation};

/// Input of `executeToolFunctionCall` (`toolManager.ts:150-160`).
#[derive(Debug, Clone)]
pub struct ToolCallRequest {
    pub conversation: Conversation,
    pub platform: ChannelType,
    pub external_chat_id: String,
    pub function_name: String,
    /// Model-supplied arguments. A non-object value becomes `{}` (`normalizeToolArgs`).
    pub args: Value,
    pub workspace_cwd: Option<String>,
    pub installed_functions: HashSet<String>,
    pub tool_id: Option<String>,
    pub skip_approval_check: bool,
}

/// The call details that a pending approval records (`createPendingApproval` params).
pub struct PendingDraft<'a> {
    pub tool_function_name: &'a str,
    pub tool_id: Option<&'a str>,
    pub args: Map<String, Value>,
    pub command: Option<&'a str>,
}

/// Tool manager of one service instance (`ToolManager` class).
pub struct ToolManager {
    backend: Arc<dyn ToolBackend>,
    requires_interactive_approval: Box<dyn Fn() -> bool + Send + Sync>,
    invoke_subagent_tool_call: Option<Arc<dyn SubagentToolInvoker>>,
    pending_approvals: Mutex<HashMap<String, PendingToolApproval>>,
}

impl ToolManager {
    pub fn new(
        backend: Arc<dyn ToolBackend>,
        requires_interactive_approval: Box<dyn Fn() -> bool + Send + Sync>,
        invoke_subagent_tool_call: Option<Arc<dyn SubagentToolInvoker>>,
    ) -> Self {
        Self {
            backend,
            requires_interactive_approval,
            invoke_subagent_tool_call,
            pending_approvals: Mutex::new(HashMap::new()),
        }
    }

    /// `prunePendingToolApprovals(now)` (`toolManager.ts:31-37`).
    pub fn prune_pending_tool_approvals(&self, now_ms: i64) {
        lock(&self.pending_approvals)
            .retain(|_, pending| now_ms - pending.created_at_ms <= TOOL_APPROVAL_TTL_MS);
    }

    /// `formatToolOutput(value)` (`toolManager.ts:39-63`).
    pub fn format_tool_output(&self, value: &Value) -> String {
        let output = match value {
            Value::String(text) => text.clone(),
            other => serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string()),
        };
        let trimmed = output.trim();
        let length = utf16_len(trimmed);
        if length <= TOOL_OUTPUT_MAX_CHARS {
            return trimmed.to_string();
        }

        let omitted = length - TOOL_OUTPUT_MAX_CHARS;
        format!(
            "{}\n\n⚠️ [Output truncated: {} chars omitted. \
             Use offset/limit params, grep, or file_read with line ranges for full content.]",
            slice_utf16(trimmed, TOOL_OUTPUT_MAX_CHARS),
            group_thousands(omitted)
        )
    }

    /// `buildToolApprovalPrompt(command)` (`toolManager.ts:65-73`).
    pub fn build_tool_approval_prompt(&self, command: &str) -> String {
        [
            "Der angefragte CLI-Befehl braucht eine Freigabe.".to_string(),
            String::new(),
            format!("Command: {command}"),
            String::new(),
            "Waehle: Approve once, Approve always oder Deny.".to_string(),
        ]
        .join("\n")
    }

    /// `buildApprovalMetadata(pending, prompt, extra)` (`toolManager.ts:75-90`).
    /// `extra` comes first, and the approval keys are written after it.
    pub fn build_approval_metadata(
        &self,
        pending: &PendingToolApproval,
        prompt: &str,
        extra: Map<String, Value>,
    ) -> Map<String, Value> {
        let mut metadata = extra;
        metadata.insert("status".into(), "approval_required".into());
        metadata.insert("approvalToken".into(), pending.token.clone().into());
        metadata.insert("approval_token".into(), pending.token.clone().into());
        metadata.insert("approvalPrompt".into(), prompt.into());
        metadata.insert("approval_prompt".into(), prompt.into());
        metadata.insert(
            "approvalToolId".into(),
            pending.tool_id.clone().map_or(Value::Null, Value::String),
        );
        metadata.insert(
            "approvalToolFunction".into(),
            pending.tool_function_name.clone().into(),
        );
        metadata
    }

    /// `createPendingApproval(params)` (`toolManager.ts:92-117`).
    pub fn create_pending_approval(
        &self,
        conversation: &Conversation,
        platform: ChannelType,
        external_chat_id: &str,
        draft: PendingDraft<'_>,
    ) -> PendingToolApproval {
        let PendingDraft {
            tool_function_name,
            tool_id,
            args,
            command,
        } = draft;
        let now = now_ms();
        self.prune_pending_tool_approvals(now);
        let pending = PendingToolApproval {
            token: Uuid::new_v4().to_string(),
            user_id: conversation.user_id.clone(),
            conversation_id: conversation.id.clone(),
            platform,
            external_chat_id: external_chat_id.to_string(),
            tool_function_name: tool_function_name.to_string(),
            tool_id: tool_id.map(str::to_string),
            args,
            command: command.map(str::to_string),
            created_at_ms: now,
        };
        lock(&self.pending_approvals).insert(pending.token.clone(), pending.clone());
        pending
    }

    /// `getSkillRepository().listSkills().filter(installed)` (`prepareDispatchMessages.ts:71-72`).
    pub async fn installed_skills(&self) -> PortResult<Vec<SkillRow>> {
        let rows = self.backend.list_skills().await?;
        Ok(rows.into_iter().filter(|row| row.installed).collect())
    }

    /// `resolveToolContext()` (`toolManager.ts:119-141`).
    pub async fn resolve_tool_context(&self) -> PortResult<ResolvedToolContext> {
        let installed = self.installed_skills().await?;

        let tools = self.backend.map_skills_to_tools(&installed);
        let installed_function_names = installed
            .iter()
            .map(|row| row.function_name.clone())
            .collect();
        let function_to_skill_id = installed
            .iter()
            .map(|row| (row.function_name.clone(), row.id.clone()))
            .collect();

        Ok(ResolvedToolContext {
            tools,
            installed_function_names,
            function_to_skill_id,
        })
    }

    /// `executeToolFunctionCall(params)` (`toolManager.ts:150-291`). Failures are
    /// returned as `Error` results, never as `Err`, like the source's `try/catch`.
    pub async fn execute_tool_function_call(
        &self,
        request: ToolCallRequest,
    ) -> ToolExecutionResult {
        let function_name = request.function_name.as_str();
        let normalized_name = match function_name {
            "exec" => "shell_execute",
            "process" => "process_manager",
            other => other,
        };
        let command_approval_tool = matches!(
            normalized_name,
            "shell_execute" | "playwright_cli" | "python_execute" | "process_manager"
        );
        let args: Map<String, Value> = match &request.args {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        };
        let args_value = Value::Object(args.clone());

        if !request.installed_functions.contains(function_name) {
            return ToolExecutionResult::Error {
                output: format!("Tool \"{function_name}\" ist nicht installiert."),
            };
        }

        if command_approval_tool {
            let action = js_string(args.get("action")).trim().to_lowercase();
            let command = match self.derive_command(normalized_name, &args_value, &args) {
                Ok(command) => command,
                Err(message) => return ToolExecutionResult::Error { output: message },
            };

            if normalized_name == "process_manager" && action == "start" && command.is_empty() {
                return ToolExecutionResult::Error {
                    output: "process_manager action=start requires command.".to_string(),
                };
            }

            if matches!(normalized_name, "shell_execute" | "playwright_cli") && command.is_empty() {
                return ToolExecutionResult::Error {
                    output: if normalized_name == "shell_execute" {
                        "shell_execute requires command.".to_string()
                    } else {
                        "playwright_cli requires args or command.".to_string()
                    },
                };
            }

            if !command.is_empty() {
                let policy = self.backend.evaluate_command_policy(&command);
                if !policy.allowed {
                    return ToolExecutionResult::Error {
                        output: policy
                            .reason
                            .unwrap_or_else(|| "Command blocked by security policy.".to_string()),
                    };
                }

                if (self.requires_interactive_approval)()
                    && !request.skip_approval_check
                    && !self.backend.is_command_approved(&policy.normalized_command)
                {
                    let pending = self.create_pending_approval(
                        &request.conversation,
                        request.platform,
                        &request.external_chat_id,
                        PendingDraft {
                            tool_function_name: function_name,
                            tool_id: request.tool_id.as_deref(),
                            args,
                            command: Some(&policy.normalized_command),
                        },
                    );
                    return ToolExecutionResult::ApprovalRequired {
                        prompt: self.build_tool_approval_prompt(&policy.normalized_command),
                        pending: Box::new(pending),
                    };
                }
            }
        }

        let context = SkillDispatchContext {
            bypass_approval: command_approval_tool && request.skip_approval_check,
            workspace_cwd: request.workspace_cwd.clone(),
            conversation_id: request.conversation.id.clone(),
            user_id: request.conversation.user_id.clone(),
            platform: request.platform,
            external_chat_id: request.external_chat_id.clone(),
            subagent_invoker: self.invoke_subagent_tool_call.clone(),
        };
        let normalized_args = self.backend.normalize_skill_args(&args_value);
        match self
            .backend
            .dispatch_skill(request.function_name.clone(), normalized_args, context)
            .await
        {
            Ok(result) => ToolExecutionResult::Ok {
                output: self.format_tool_output(&result),
            },
            Err(error) => ToolExecutionResult::Error {
                output: error.to_string(),
            },
        }
    }

    /// The `try` block of `executeToolFunctionCall` (`toolManager.ts:181-208`) that
    /// derives the command the approval gate checks.
    fn derive_command(
        &self,
        normalized_name: &str,
        args_value: &Value,
        args: &Map<String, Value>,
    ) -> Result<String, String> {
        let action = js_string(args.get("action")).trim().to_lowercase();
        let command = match normalized_name {
            "shell_execute" => js_string(args.get("command")).trim().to_string(),
            "python_execute" => self
                .backend
                .build_python_command(js_string(args.get("code")).trim()),
            "playwright_cli" => {
                let tokens = self
                    .backend
                    .resolve_playwright_tokens(args_value)
                    .map_err(|error| error.to_string())?;
                self.backend.build_playwright_cli_command(&tokens)
            }
            _ if action == "start" => js_string(args.get("command")).trim().to_string(),
            _ => String::new(),
        };
        Ok(command)
    }

    pub fn get_pending_approval(&self, token: &str) -> Option<PendingToolApproval> {
        lock(&self.pending_approvals).get(token).cloned()
    }

    pub fn delete_pending_approval(&self, token: &str) -> bool {
        lock(&self.pending_approvals).remove(token).is_some()
    }

    pub fn approve_command(&self, command: &str) {
        self.backend.approve_command(command);
    }
}

/// Milliseconds since the Unix epoch, like `Date.now()`.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `String(value || '')` for a model-supplied JSON value. Falsy values (`null`,
/// `false`, `0`, `""`) become the empty string; objects render as `[object Object]`.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => String::new(),
        Some(Value::Bool(true)) => "true".to_string(),
        Some(Value::Number(number)) => match number.as_f64() {
            Some(n) if n == 0.0 || n.is_nan() => String::new(),
            Some(n) if n.fract() == 0.0 && n.abs() < 1e21 => format!("{}", n as i64),
            Some(n) => n.to_string(),
            None => number.to_string(),
        },
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| js_string(Some(item)))
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// Groups digits with commas, the `en-US` form of `Number.prototype.toLocaleString`.
fn group_thousands(value: usize) -> String {
    let digits = value.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages_store::types::Conversation;
    use serde_json::json;
    use std::sync::Mutex as StdMutex;

    fn draft_for_ls<'a>() -> PendingDraft<'a> {
        PendingDraft {
            tool_function_name: "shell_execute",
            tool_id: None,
            args: Map::new(),
            command: Some("ls"),
        }
    }

    fn conversation() -> Conversation {
        Conversation {
            id: "c-1".into(),
            channel_type: "WebChat".into(),
            external_chat_id: Some("chat".into()),
            user_id: "u-1".into(),
            workspace_id: None,
            title: "t".into(),
            model_override: None,
            persona_id: None,
            created_at: "t0".into(),
            updated_at: "t0".into(),
        }
    }

    /// Fake backend that records dispatches and answers from fixed tables.
    #[derive(Default)]
    struct FakeBackend {
        dispatched: StdMutex<Vec<(String, Value)>>,
        rows: Vec<SkillRow>,
        approved: StdMutex<Vec<String>>,
        blocked: bool,
        dispatch_error: Option<String>,
    }

    impl ToolBackend for FakeBackend {
        fn list_skills(
            &self,
        ) -> crate::channels::messages::service::ports::BoxFuture<'_, PortResult<Vec<SkillRow>>>
        {
            let rows = self.rows.clone();
            Box::pin(async move { Ok(rows) })
        }
        fn map_skills_to_tools(&self, installed: &[SkillRow]) -> Vec<Value> {
            installed
                .iter()
                .map(|row| json!({"type": "function", "name": row.function_name}))
                .collect()
        }
        fn evaluate_command_policy(
            &self,
            command: &str,
        ) -> crate::channels::messages::service::ports::CommandPolicy {
            crate::channels::messages::service::ports::CommandPolicy {
                allowed: !self.blocked,
                normalized_command: command.to_string(),
                reason: self.blocked.then(|| "blocked by test policy".to_string()),
            }
        }
        fn is_command_approved(&self, normalized: &str) -> bool {
            self.approved
                .lock()
                .unwrap()
                .iter()
                .any(|c| c == normalized)
        }
        fn approve_command(&self, command: &str) {
            self.approved.lock().unwrap().push(command.to_string());
        }
        fn build_python_command(&self, code: &str) -> String {
            format!("python -c {code}")
        }
        fn resolve_playwright_tokens(&self, _args: &Value) -> PortResult<Vec<String>> {
            Ok(vec!["open".into()])
        }
        fn build_playwright_cli_command(&self, tokens: &[String]) -> String {
            format!("playwright {}", tokens.join(" "))
        }
        fn normalize_skill_args(&self, args: &Value) -> Value {
            args.clone()
        }
        fn dispatch_skill(
            &self,
            function_name: String,
            args: Value,
            _context: SkillDispatchContext,
        ) -> crate::channels::messages::service::ports::BoxFuture<'_, PortResult<Value>> {
            self.dispatched.lock().unwrap().push((function_name, args));
            let error = self.dispatch_error.clone();
            Box::pin(async move {
                match error {
                    Some(message) => Err(message.into()),
                    None => Ok(json!({"ok": true})),
                }
            })
        }
    }

    fn row(id: &str, function: &str, installed: bool) -> SkillRow {
        SkillRow {
            id: id.into(),
            name: id.into(),
            description: "d".into(),
            category: "c".into(),
            installed,
            version: "1".into(),
            function_name: function.into(),
            source: "built-in".into(),
            source_url: None,
            tool_definition: Value::Null,
        }
    }

    fn manager(backend: Arc<FakeBackend>, approvals_required: bool) -> ToolManager {
        ToolManager::new(backend, Box::new(move || approvals_required), None)
    }

    fn request(function: &str, args: Value, installed: &[&str]) -> ToolCallRequest {
        ToolCallRequest {
            conversation: conversation(),
            platform: ChannelType::WebChat,
            external_chat_id: "chat".into(),
            function_name: function.into(),
            args,
            workspace_cwd: None,
            installed_functions: installed.iter().map(|s| s.to_string()).collect(),
            tool_id: Some("skill-1".into()),
            skip_approval_check: false,
        }
    }

    #[test]
    fn long_output_is_truncated_with_utf16_counts() {
        let tm = manager(Arc::new(FakeBackend::default()), false);
        let long = "a".repeat(TOOL_OUTPUT_MAX_CHARS + 1234);
        let out = tm.format_tool_output(&Value::String(long));
        assert!(out.starts_with(&"a".repeat(TOOL_OUTPUT_MAX_CHARS)));
        assert!(out.contains("1,234 chars omitted"), "{out}");
        assert_eq!(tm.format_tool_output(&json!({"a": 1})), "{\n  \"a\": 1\n}");
    }

    #[test]
    fn exec_alias_routes_to_shell_and_requires_a_command() {
        let tm = manager(Arc::new(FakeBackend::default()), false);
        let result =
            futures_block(tm.execute_tool_function_call(request("exec", json!({}), &["exec"])));
        assert_eq!(
            result,
            ToolExecutionResult::Error {
                output: "shell_execute requires command.".into()
            }
        );
    }

    #[test]
    fn uninstalled_tool_is_rejected_before_anything_runs() {
        let backend = Arc::new(FakeBackend::default());
        let tm = manager(backend.clone(), false);
        let result =
            futures_block(tm.execute_tool_function_call(request("web_fetch", json!({}), &[])));
        assert!(matches!(result, ToolExecutionResult::Error { .. }));
        assert!(backend.dispatched.lock().unwrap().is_empty());
    }

    #[test]
    fn blocked_command_is_an_error_with_the_policy_reason() {
        let backend = Arc::new(FakeBackend {
            blocked: true,
            ..Default::default()
        });
        let tm = manager(backend.clone(), false);
        let result = futures_block(tm.execute_tool_function_call(request(
            "shell_execute",
            json!({"command": "rm -rf /"}),
            &["shell_execute"],
        )));
        assert_eq!(
            result,
            ToolExecutionResult::Error {
                output: "blocked by test policy".into()
            }
        );
    }

    #[test]
    fn unapproved_command_creates_a_pending_approval() {
        let backend = Arc::new(FakeBackend::default());
        let tm = manager(backend.clone(), true);
        let result = futures_block(tm.execute_tool_function_call(request(
            "shell_execute",
            json!({"command": "  ls  "}),
            &["shell_execute"],
        )));
        let ToolExecutionResult::ApprovalRequired { prompt, pending } = result else {
            panic!("expected approval_required");
        };
        assert!(prompt.contains("Command: ls"));
        assert_eq!(pending.command.as_deref(), Some("ls"));
        assert_eq!(pending.tool_id.as_deref(), Some("skill-1"));
        assert!(tm.get_pending_approval(&pending.token).is_some());
        assert!(backend.dispatched.lock().unwrap().is_empty(), "nothing ran");
    }

    #[test]
    fn approved_command_dispatches_with_the_original_function_name() {
        let backend = Arc::new(FakeBackend::default());
        backend.approve_command("ls");
        let tm = manager(backend.clone(), true);
        let result = futures_block(tm.execute_tool_function_call(request(
            "exec",
            json!({"command": "ls"}),
            &["exec"],
        )));
        assert!(
            matches!(result, ToolExecutionResult::Ok { .. }),
            "{result:?}"
        );
        assert_eq!(backend.dispatched.lock().unwrap()[0].0, "exec");
    }

    #[test]
    fn dispatch_failure_becomes_an_error_result() {
        let backend = Arc::new(FakeBackend {
            dispatch_error: Some("skill exploded".into()),
            ..Default::default()
        });
        let tm = manager(backend, false);
        let result = futures_block(tm.execute_tool_function_call(request(
            "web_fetch",
            json!({"url": "x"}),
            &["web_fetch"],
        )));
        assert_eq!(
            result,
            ToolExecutionResult::Error {
                output: "skill exploded".into()
            }
        );
    }

    #[test]
    fn pending_approvals_expire_after_the_ttl() {
        let tm = manager(Arc::new(FakeBackend::default()), true);
        let pending = tm.create_pending_approval(
            &conversation(),
            ChannelType::WebChat,
            "chat",
            draft_for_ls(),
        );
        tm.prune_pending_tool_approvals(pending.created_at_ms + TOOL_APPROVAL_TTL_MS);
        assert!(
            tm.get_pending_approval(&pending.token).is_some(),
            "exactly at the TTL it stays"
        );
        tm.prune_pending_tool_approvals(pending.created_at_ms + TOOL_APPROVAL_TTL_MS + 1);
        assert!(tm.get_pending_approval(&pending.token).is_none());
    }

    #[test]
    fn js_string_matches_loose_string_conversion() {
        assert_eq!(js_string(Some(&json!(null))), "");
        assert_eq!(js_string(Some(&json!(0))), "");
        assert_eq!(js_string(Some(&json!(5))), "5");
        assert_eq!(js_string(Some(&json!(true))), "true");
        assert_eq!(js_string(Some(&json!({"a": 1}))), "[object Object]");
    }

    #[test]
    fn metadata_keeps_extra_keys_and_writes_both_spellings() {
        let tm = manager(Arc::new(FakeBackend::default()), true);
        let pending = tm.create_pending_approval(
            &conversation(),
            ChannelType::WebChat,
            "chat",
            draft_for_ls(),
        );
        let mut extra = Map::new();
        extra.insert("ok".into(), Value::Bool(false));
        let meta = tm.build_approval_metadata(&pending, "P", extra);
        assert_eq!(meta["approval_token"], meta["approvalToken"]);
        assert_eq!(meta["approvalToolId"], Value::Null);
        assert_eq!(meta["ok"], Value::Bool(false));
    }

    #[test]
    fn resolve_tool_context_keeps_only_installed_rows() {
        let backend = Arc::new(FakeBackend {
            rows: vec![row("a", "fa", true), row("b", "fb", false)],
            ..Default::default()
        });
        let tm = manager(backend, false);
        let ctx = futures_block(tm.resolve_tool_context()).expect("context");
        assert_eq!(ctx.tools.len(), 1);
        assert!(ctx.installed_function_names.contains("fa"));
        assert!(!ctx.installed_function_names.contains("fb"));
        assert_eq!(
            ctx.function_to_skill_id.get("fa").map(String::as_str),
            Some("a")
        );
    }

    fn futures_block<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(future)
    }
}
