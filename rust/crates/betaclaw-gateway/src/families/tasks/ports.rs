//! Ports to the parts of the runtime that other slices own.
//!
//! The TypeScript routes call four things outside the task domain: the
//! Mission Control runtime client (`getBetaClawClient`, S8), the installed skills
//! (`getSkillRepository`, S11), the automation prompt runner (S8) and the browser
//! check of a deliverable (`deliverableTester.ts`). The family takes them as
//! traits. The `Unwired*` types are the defaults until the integrator passes the
//! real implementations. They fail the way the TypeScript route fails when the
//! runtime is down.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

use betaclaw_core::auth::principal::get_principal_user_id;
use betaclaw_core::automation::service::{PromptRunInput, PromptRunOutput, PromptRunner};
use betaclaw_core::channels::messages::service::inbound::handle_inbound::{
    InboundOptions, InboundParams,
};
use betaclaw_core::channels::ws::ports::WebUiMessage;
use betaclaw_core::messages_store::types::ChannelType;
use betaclaw_core::skills::store::SkillRepository;
use betaclaw_core::tasks::repository::TaskRepository;
use betaclaw_core::tasks::testing::queue::DeliverableRunner;
use betaclaw_core::tasks::testing::{DeliverableRef, TestResult};
use serde_json::{json, Value};

use crate::families::chat_runtime;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A failed runtime call. The text is what the TypeScript route logs.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct RuntimeError(pub String);

/// `getBetaClawClient()`: the connection to the runtime and its RPC calls.
pub trait BetaClawRuntime: Send + Sync {
    fn is_connected(&self) -> bool;
    fn connect(&self) -> BoxFuture<'_, Result<(), RuntimeError>>;
    /// `client.call(method, params)`. The method names are those of `src/lib/betaclaw/client.ts`.
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, RuntimeError>>;
}

/// The installed execution tools: `skillRepo.listSkills().filter(s => s.installed).length`.
pub trait SkillInventory: Send + Sync {
    /// The error text when the store cannot be read.
    fn installed_count(&self) -> Result<usize, String>;
}

/// The `skills` table of `betaclaw_core::skills::store`, read the way `prepareDispatch.ts:89` reads it.
pub struct SkillStoreInventory(pub Arc<SkillRepository>);

impl SkillInventory for SkillStoreInventory {
    fn installed_count(&self) -> Result<usize, String> {
        let skills = self.0.list_skills().map_err(|fault| fault.0)?;
        Ok(skills.iter().filter(|skill| skill.installed).count())
    }
}

/// The browser check of a deliverable. Without a browser runtime every check fails,
/// so the job ends `failed` and the queue moves on.
pub struct UnwiredDeliverableRunner;

impl DeliverableRunner for UnwiredDeliverableRunner {
    fn run(&self, _deliverable: &DeliverableRef) -> Result<TestResult, String> {
        Err("Automated browser tests are not wired yet (Playwright runner)".to_string())
    }
}

fn not_wired() -> RuntimeError {
    RuntimeError("Mission Control runtime client is not wired (S8)".to_string())
}

/// No runtime: never connected, every call fails.
pub struct UnwiredRuntime;

impl BetaClawRuntime for UnwiredRuntime {
    fn is_connected(&self) -> bool {
        false
    }

    fn connect(&self) -> BoxFuture<'_, Result<(), RuntimeError>> {
        Box::pin(async { Err(not_wired()) })
    }

    fn call<'a>(
        &'a self,
        _method: &'a str,
        _params: Value,
    ) -> BoxFuture<'a, Result<Value, RuntimeError>> {
        Box::pin(async { Err(not_wired()) })
    }
}

/// No skill inventory: nothing is installed, so dispatch answers 409 until S11 is wired.
pub struct NoSkills;

impl SkillInventory for NoSkills {
    fn installed_count(&self) -> Result<usize, String> {
        Ok(0)
    }
}

/// No prompt runner: every automation run fails with this text until S8 is wired.
#[derive(Debug, Clone, Copy, Default)]
pub struct UnwiredPromptRunner;

impl PromptRunner for UnwiredPromptRunner {
    async fn run_prompt(&self, _input: PromptRunInput) -> Result<PromptRunOutput, String> {
        Err("automation prompt runner is not wired (S8)".to_string())
    }
}

/// Production prompt runner over the gateway's chat runtime (`defaultRunPrompt` in
/// `src/server/automation/runtime.ts:79-113`). Falls back to the unwired message when
/// the chat runtime has not been bound yet.
#[derive(Clone, Default)]
pub struct GatewayPromptRunner {
    chat: Arc<OnceLock<Arc<chat_runtime::Services>>>,
}

impl GatewayPromptRunner {
    pub fn new(chat: Arc<OnceLock<Arc<chat_runtime::Services>>>) -> Self {
        Self { chat }
    }

    pub fn unwired() -> Self {
        Self {
            chat: Arc::new(OnceLock::new()),
        }
    }
}

impl PromptRunner for GatewayPromptRunner {
    async fn run_prompt(&self, input: PromptRunInput) -> Result<PromptRunOutput, String> {
        let Some(chat) = self.chat.get() else {
            return Err("automation prompt runner is not wired (S8)".to_string());
        };
        let conversation_id = chat
            .ws_messages
            .get_or_create_conversation("WebChat", "default", None, &input.user_id)
            .map_err(|error| error.message)?
            .id;
        let client_message_id = format!("automation-{}", chrono::Utc::now().timestamp_millis());
        let outcome = chat
            .ws_messages
            .handle_web_ui_message(
                WebUiMessage {
                    conversation_id: conversation_id.clone(),
                    content: input.prompt,
                    user_id: input.user_id.clone(),
                    client_message_id: Some(client_message_id),
                    attachments: None,
                },
                None,
            )
            .await
            .map_err(|error| error.message)?;
        let target_conv = outcome
            .new_conversation_id
            .as_deref()
            .unwrap_or(&conversation_id);
        let summary = chat
            .ws_store
            .list_messages(target_conv, 20, None, &input.user_id)
            .ok()
            .and_then(|messages| {
                messages
                    .into_iter()
                    .find(|msg| {
                        msg.get("id").and_then(Value::as_str) == Some(outcome.agent_msg_id.as_str())
                    })
                    .and_then(|msg| {
                        msg.get("content")
                            .and_then(Value::as_str)
                            .map(|text| text.chars().take(500).collect::<String>())
                    })
            });
        Ok(PromptRunOutput { summary })
    }
}

/// Integrated Mission Control runtime client (`BetaClawClient` in
/// `src/lib/betaclaw/client.ts`).
pub struct IntegratedBetaClawRuntime {
    tasks: Arc<TaskRepository>,
    chat: Arc<OnceLock<Arc<chat_runtime::Services>>>,
}

impl IntegratedBetaClawRuntime {
    pub fn new(
        tasks: Arc<TaskRepository>,
        chat: Arc<OnceLock<Arc<chat_runtime::Services>>>,
    ) -> Self {
        Self { tasks, chat }
    }
}

fn map_stored_role_to_gateway_role(role: &str) -> &'static str {
    match role {
        "agent" => "assistant",
        "system" => "system",
        _ => "user",
    }
}

fn is_mission_control_execution_session(session_key: &str) -> bool {
    session_key
        .trim()
        .to_ascii_lowercase()
        .starts_with("agent:main:mission-control-")
}

impl BetaClawRuntime for IntegratedBetaClawRuntime {
    fn is_connected(&self) -> bool {
        self.chat.get().is_some()
    }

    fn connect(&self) -> BoxFuture<'_, Result<(), RuntimeError>> {
        let connected = self.is_connected();
        Box::pin(async move {
            if connected {
                Ok(())
            } else {
                Err(not_wired())
            }
        })
    }

    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, RuntimeError>> {
        Box::pin(async move {
            let Some(chat) = self.chat.get() else {
                return Err(not_wired());
            };
            let user_id = get_principal_user_id();
            match method {
                "chat.send" => {
                    let session_key = params
                        .get("sessionKey")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim();
                    let message = params
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim();
                    let idempotency_key = params
                        .get("idempotencyKey")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string);
                    if !session_key.is_empty() && !message.is_empty() {
                        let mc_exec = is_mission_control_execution_session(session_key);
                        let directive = mc_exec.then(|| {
                            [
                                "MISSION CONTROL EXECUTION MODE:",
                                "- Perform real task execution via tool calls. Do not output pseudo commands or plans.",
                                "- Use shell_execute/file tools to create and verify real artifacts.",
                                "- On Windows, use PowerShell-compatible commands.",
                                "- After execution, provide concise factual results and include TASK_COMPLETE: <summary>.",
                            ]
                            .join("\n")
                        });
                        let result = chat
                            .message_service
                            .handle_inbound(InboundParams {
                                platform: ChannelType::WebChat,
                                external_chat_id: session_key.to_string(),
                                content: message.to_string(),
                                sender_name: None,
                                external_msg_id: None,
                                user_id: Some(user_id),
                                client_message_id: idempotency_key,
                                attachment_metadata: None,
                                on_stream_delta: None,
                                opts: InboundOptions {
                                    skip_project_guard: true,
                                    execution_directive: directive,
                                    max_tool_calls: mc_exec.then_some(120),
                                    require_tool_call: mc_exec,
                                },
                            })
                            .await
                            .map_err(|error| RuntimeError(error.to_string()))?;
                        let metadata = result
                            .agent_msg
                            .metadata
                            .as_deref()
                            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                            .filter(Value::is_object);
                        let mut out = json!({
                            "userMsgId": result.user_msg.id,
                            "agentMsgId": result.agent_msg.id,
                            "conversationId": result.user_msg.conversation_id,
                            "agentContent": result.agent_msg.content,
                        });
                        if let Some(meta) = metadata {
                            out["agentMetadata"] = meta;
                        }
                        return Ok(out);
                    }
                    Err(RuntimeError(
                        "chat.send requires {sessionKey,message} or {conversationId,content}"
                            .to_string(),
                    ))
                }
                "chat.history" => {
                    let session_key = params
                        .get("sessionKey")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim();
                    let conversation_id = params
                        .get("conversationId")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim();
                    let limit = params
                        .get("limit")
                        .and_then(Value::as_i64)
                        .filter(|&n| n > 0)
                        .unwrap_or(50);
                    let resolved_conv_id = if !session_key.is_empty() {
                        Some(
                            chat.ws_messages
                                .get_or_create_conversation("WebChat", session_key, None, &user_id)
                                .map_err(|error| RuntimeError(error.message))?
                                .id,
                        )
                    } else if !conversation_id.is_empty() {
                        Some(conversation_id.to_string())
                    } else {
                        None
                    };
                    let rows = match resolved_conv_id {
                        Some(conv_id) => chat
                            .ws_store
                            .list_messages(&conv_id, limit, None, &user_id)
                            .map_err(|error| RuntimeError(error.message))?,
                        None => Vec::new(),
                    };
                    let messages: Vec<Value> = rows
                        .into_iter()
                        .map(|msg| {
                            let role = msg.get("role").and_then(Value::as_str).unwrap_or("user");
                            let content = msg.get("content").and_then(Value::as_str).unwrap_or("");
                            let timestamp =
                                msg.get("createdAt").and_then(Value::as_str).unwrap_or("");
                            json!({
                                "role": map_stored_role_to_gateway_role(role),
                                "content": [{ "type": "text", "text": content }],
                                "timestamp": timestamp,
                            })
                        })
                        .collect();
                    Ok(json!({ "messages": messages }))
                }
                "sessions.list" => {
                    let connection = self.tasks.connection();
                    let mut stmt = connection
                        .prepare(
                            "SELECT betaclaw_session_id, channel, status
                             FROM betaclaw_sessions
                             ORDER BY created_at DESC",
                        )
                        .map_err(|e| RuntimeError(e.to_string()))?;
                    let rows = stmt
                        .query_map([], |row| {
                            let id: String = row.get(0)?;
                            let channel: Option<String> = row.get(1)?;
                            let status: Option<String> = row.get(2)?;
                            Ok(json!({
                                "id": id,
                                "channel": channel.unwrap_or_else(|| "mission-control".to_string()),
                                "status": status.unwrap_or_else(|| "active".to_string()),
                            }))
                        })
                        .map_err(|e| RuntimeError(e.to_string()))?
                        .collect::<Result<Vec<Value>, _>>()
                        .map_err(|e| RuntimeError(e.to_string()))?;
                    Ok(Value::Array(rows))
                }
                "agents.list" => {
                    let connection = self.tasks.connection();
                    let mut stmt = connection
                        .prepare(
                            "SELECT id, name, model, status
                             FROM agents
                             WHERE source = 'gateway' OR gateway_agent_id IS NOT NULL
                             ORDER BY created_at DESC",
                        )
                        .map_err(|e| RuntimeError(e.to_string()))?;
                    let rows = stmt
                        .query_map([], |row| {
                            let id: String = row.get(0)?;
                            let name: String = row.get(1)?;
                            let model: Option<String> = row.get(2)?;
                            let status: Option<String> = row.get(3)?;
                            let mut entry = json!({
                                "id": id,
                                "name": name,
                                "status": status.unwrap_or_else(|| "standby".to_string()),
                                "channel": "mission-control",
                            });
                            if let Some(m) = model.filter(|s| !s.is_empty()) {
                                entry["model"] = json!(m);
                            }
                            Ok(entry)
                        })
                        .map_err(|e| RuntimeError(e.to_string()))?
                        .collect::<Result<Vec<Value>, _>>()
                        .map_err(|e| RuntimeError(e.to_string()))?;
                    Ok(Value::Array(rows))
                }
                "node.list" => Ok(json!([])),
                "node.describe" => {
                    let node_id = params
                        .get("node_id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim();
                    Ok(json!({ "id": node_id, "capabilities": [] }))
                }
                other => Err(RuntimeError(format!(
                    "Unsupported BetaClaw method in integrated mode: {other}"
                ))),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use betaclaw_core::skills::store::InstallSkillInput;
    use serde_json::json;

    use super::*;

    fn install(repository: &SkillRepository, id: &str) {
        repository
            .install_skill(&InstallSkillInput {
                id: Some(id.to_string()),
                name: id.to_string(),
                description: "test skill".to_string(),
                category: "test".to_string(),
                version: "1.0.0".to_string(),
                function_name: id.to_string(),
                source: "built-in".to_string(),
                source_url: None,
                tool_definition: json!({}),
                handler_path: None,
            })
            .expect("install skill");
    }

    #[test]
    fn only_installed_skills_are_counted() {
        let repository = Arc::new(SkillRepository::in_memory().expect("open skills"));
        install(&repository, "shell");
        install(&repository, "web-search");
        repository
            .set_installed("web-search", false)
            .expect("uninstall skill");

        let inventory = SkillStoreInventory(repository);
        assert_eq!(inventory.installed_count(), Ok(1));
    }

    #[test]
    fn an_empty_store_has_no_installed_tools() {
        let repository = Arc::new(SkillRepository::in_memory().expect("open skills"));
        install(&repository, "shell");
        repository
            .set_installed("shell", false)
            .expect("uninstall skill");

        assert_eq!(SkillStoreInventory(repository).installed_count(), Ok(0));
    }
}
