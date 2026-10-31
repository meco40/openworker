//! Port of `src/server/channels/messages/service/execution/buildExecution.ts`.
//!
//! Autonomous and build-mode directives, the tool-call budget, and the workspace
//! preflight that runs `pwd`/`ls` before a build turn. The budget comes from
//! `resolveAutonomousBuildMaxToolCalls()` in `core/configuration.ts`, which
//! belongs to Agent C. It is passed in as `autonomous_build_max_tool_calls`.

use serde_json::json;

use crate::channels::messages::service::subagent::utils::{non_empty, object};
use crate::messages_store::types::{ChannelType, Conversation, StoredMessage};

use super::ports::{PortResult, ToolManagerPort};
use crate::channels::messages::service::ports::SendResponse;
use crate::channels::messages::service::tool_manager::ToolCallRequest;
use crate::channels::messages::service::types::ToolExecutionResult;

/// Input of [`build_autonomous_execution_directive`].
#[derive(Debug, Clone, Copy)]
pub struct DirectiveParams<'a> {
    pub workspace_cwd: Option<&'a str>,
    pub build_intent: bool,
    pub is_autonomous_persona: bool,
}

/// The persona fields that the budget reads (`activePersona.maxToolCalls`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ActivePersona {
    pub max_tool_calls: Option<u32>,
}

/// Input of [`resolve_max_tool_calls`].
#[derive(Debug, Clone, Copy)]
pub struct MaxToolCallsParams {
    pub is_autonomous_persona: bool,
    pub active_persona: Option<ActivePersona>,
    pub build_intent: bool,
    pub override_max_tool_calls: Option<u32>,
    pub autonomous_build_max_tool_calls: u32,
}

/// `buildAutonomousExecutionDirective`. Returns `None` for a plain chat turn.
pub fn build_autonomous_execution_directive(params: &DirectiveParams<'_>) -> Option<String> {
    if !params.build_intent && !params.is_autonomous_persona {
        return None;
    }

    let shared = [
        "- Tool-Calls silent ausfuehren — NICHT beschreiben was du tun wirst, einfach tun.",
        "- Polling-Loops strikt verboten: ausreichend Timeout nutzen statt rapid-retry. Min. 5s Pause zwischen Wiederholungen.",
        "- Bei 2+ identischen Tool-Calls mit gleichem Ergebnis: Strategie sofort wechseln, nicht weiter wiederholen.",
        "- Bei Fehlern: Fehlerausgabe vollstaendig lesen und Root Cause verstehen BEVOR du retry machst.",
    ];
    let workspace_line = non_empty(params.workspace_cwd)
        .map(|cwd| format!("- Aktives Workspace-Verzeichnis: {cwd}"));

    let head: &[&str] = if params.is_autonomous_persona {
        &[
            "AUTONOMOUS AGENT MODE:",
            "- Du bist ein autonomer Agent. Handele eigenstaendig end-to-end ohne Rueckfragen.",
            "- Nutze alle verfuegbaren Tools aktiv: Shell, Filesystem, Browser, Python, HTTP, Web-Search, PDF.",
            "- Erkenne und korrigiere Fehler proaktiv. Versuche alternative Strategien wenn ein Ansatz scheitert.",
            "- Gib Zwischenstatus nach jedem wesentlichen Schritt in einem Satz aus.",
            "- Antworte ohne ueberfluessige Codeblöcke; liefere Fakten, Ergebnisse, geaenderte Dateien.",
        ]
    } else {
        &[
            "AUTONOMOUS EXECUTION MODE (build task):",
            "- Arbeite end-to-end im aktiven Projekt-Workspace statt nur Plantext zu geben.",
            "- Nutze Tools aktiv fuer Inspektion, Umsetzung und Verifikation.",
            "- Wenn die Aufgabe coding/build ist, fuehre reale Datei- und CLI-Schritte aus.",
            "- Buendle Shell-Schritte in moeglichst wenige, robuste Befehle statt viele Mini-Calls.",
            "- Antworte ohne Codebloeke; gib stattdessen Status, geaenderte Dateien, Verifikation und Startkommando.",
            "- Nur bei Fehlern kurze, relevante Fehlersnippets zeigen.",
        ]
    };

    let mut lines: Vec<String> = head.iter().map(|line| line.to_string()).collect();
    lines.extend(workspace_line);
    lines.extend(shared.iter().map(|line| line.to_string()));
    Some(lines.join("\n"))
}

/// `resolveMaxToolCalls`. An explicit override wins. An autonomous persona uses
/// its own limit, which may be absent. A build intent uses the configured budget.
pub fn resolve_max_tool_calls(params: &MaxToolCallsParams) -> Option<u32> {
    if let Some(value) = params.override_max_tool_calls {
        return Some(value);
    }
    if params.is_autonomous_persona && params.active_persona.is_some() {
        return params
            .active_persona
            .and_then(|persona| persona.max_tool_calls);
    }
    if params.build_intent {
        return Some(params.autonomous_build_max_tool_calls);
    }
    None
}

/// Result of [`run_build_workspace_preflight`], `ToolExecutionResult` in `core/types.ts`.
#[derive(Debug, Clone, PartialEq)]
pub enum PreflightResult {
    Summary { text: String },
    ApprovalRequired { message: Box<StoredMessage> },
}

/// Input of [`run_build_workspace_preflight`].
#[derive(Debug, Clone, Copy)]
pub struct PreflightParams<'a> {
    pub conversation: &'a Conversation,
    pub platform: ChannelType,
    pub external_chat_id: &'a str,
    pub workspace_cwd: &'a str,
}

/// `runBuildWorkspacePreflight`: runs a read-only listing in the workspace. When
/// the shell tool needs approval, the prompt is sent to the user.
pub async fn run_build_workspace_preflight(
    tool_manager: &dyn ToolManagerPort,
    sink: &dyn SendResponse,
    params: PreflightParams<'_>,
) -> PortResult<PreflightResult> {
    let tool_context = tool_manager.resolve_tool_context().await?;
    let command = if cfg!(windows) {
        "Get-Location; Get-ChildItem -Force | Select-Object -First 30 Name,Mode,Length"
    } else {
        "pwd; ls -la | head -n 40"
    };

    let outcome = tool_manager
        .execute_tool_function_call(ToolCallRequest {
            conversation: params.conversation.clone(),
            platform: params.platform,
            external_chat_id: params.external_chat_id.to_string(),
            function_name: "shell_execute".to_string(),
            args: serde_json::Value::Object(object(json!({ "command": command }))),
            workspace_cwd: Some(params.workspace_cwd.to_string()),
            installed_functions: tool_context.installed_function_names.clone(),
            tool_id: Some(
                tool_context
                    .function_to_skill_id
                    .get("shell_execute")
                    .cloned()
                    .unwrap_or_else(|| "shell-access".to_string()),
            ),
            skip_approval_check: false,
        })
        .await?;

    match outcome {
        ToolExecutionResult::ApprovalRequired { prompt, pending } => {
            let metadata = tool_manager.build_approval_metadata(
                &pending,
                &prompt,
                object(json!({
                    "ok": false,
                    "runtime": "build-workspace-preflight",
                })),
            );
            let message = sink
                .send_response(
                    params.conversation,
                    &prompt,
                    params.platform,
                    params.external_chat_id,
                    Some(metadata),
                )
                .await?;
            Ok(PreflightResult::ApprovalRequired {
                message: Box::new(message),
            })
        }
        ToolExecutionResult::Ok { output } => Ok(PreflightResult::Summary {
            text: format!("[Workspace preflight result]\n{output}"),
        }),
        ToolExecutionResult::Error { output } => Ok(PreflightResult::Summary {
            text: format!("[Workspace preflight failed]\n{output}"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::messages::service::execution::test_doubles::{
        conversation, pending, FakeSink, FakeTools,
    };

    fn directive(build_intent: bool, autonomous: bool) -> Option<String> {
        build_autonomous_execution_directive(&DirectiveParams {
            workspace_cwd: Some("/w"),
            build_intent,
            is_autonomous_persona: autonomous,
        })
    }

    #[test]
    fn plain_chat_turn_has_no_directive() {
        assert_eq!(directive(false, false), None);
    }

    #[test]
    fn directive_header_and_workspace_line_depend_on_mode() {
        let build = directive(true, false).unwrap();
        assert!(build.starts_with("AUTONOMOUS EXECUTION MODE (build task):"));
        assert!(build.contains("- Aktives Workspace-Verzeichnis: /w"));
        assert!(build.ends_with("Bei Fehlern: Fehlerausgabe vollstaendig lesen und Root Cause verstehen BEVOR du retry machst."));

        let autonomous = directive(false, true).unwrap();
        assert!(autonomous.starts_with("AUTONOMOUS AGENT MODE:"));
    }

    #[test]
    fn tool_call_budget_follows_override_persona_then_build() {
        let base = MaxToolCallsParams {
            is_autonomous_persona: false,
            active_persona: None,
            build_intent: true,
            override_max_tool_calls: None,
            autonomous_build_max_tool_calls: 120,
        };
        assert_eq!(resolve_max_tool_calls(&base), Some(120));
        assert_eq!(
            resolve_max_tool_calls(&MaxToolCallsParams {
                override_max_tool_calls: Some(7),
                ..base
            }),
            Some(7)
        );
        let persona_without_limit = MaxToolCallsParams {
            is_autonomous_persona: true,
            active_persona: Some(ActivePersona {
                max_tool_calls: None,
            }),
            ..base
        };
        assert_eq!(resolve_max_tool_calls(&persona_without_limit), None);
        let chat = MaxToolCallsParams {
            build_intent: false,
            ..base
        };
        assert_eq!(resolve_max_tool_calls(&chat), None);
    }

    #[tokio::test]
    async fn preflight_summarises_the_listing() {
        let tools = FakeTools::default();
        tools
            .outcomes
            .lock()
            .unwrap()
            .push_back(ToolExecutionResult::Ok {
                output: "listing".to_string(),
            });
        let conv = conversation("conv-1", "user-1", None);
        let result = run_build_workspace_preflight(
            &tools,
            &FakeSink::default(),
            PreflightParams {
                conversation: &conv,
                platform: ChannelType::WebChat,
                external_chat_id: "web-1",
                workspace_cwd: "/w",
            },
        )
        .await
        .unwrap();

        assert_eq!(
            result,
            PreflightResult::Summary {
                text: "[Workspace preflight result]\nlisting".to_string(),
            }
        );
        let calls = tools.calls.lock().unwrap();
        assert_eq!(calls[0].function_name, "shell_execute");
        assert_eq!(calls[0].tool_id.as_deref(), Some("shell-access"));
        assert_eq!(calls[0].workspace_cwd.as_deref(), Some("/w"));
    }

    #[tokio::test]
    async fn preflight_forwards_an_approval_prompt() {
        let tools = FakeTools::default();
        let conv = conversation("conv-1", "user-1", None);
        tools
            .outcomes
            .lock()
            .unwrap()
            .push_back(ToolExecutionResult::ApprovalRequired {
                prompt: "Run listing?".to_string(),
                pending: Box::new(pending("t", &conv, "shell_execute")),
            });
        let sink = FakeSink::default();
        let result = run_build_workspace_preflight(
            &tools,
            &sink,
            PreflightParams {
                conversation: &conv,
                platform: ChannelType::WebChat,
                external_chat_id: "web-1",
                workspace_cwd: "/w",
            },
        )
        .await
        .unwrap();

        assert!(matches!(result, PreflightResult::ApprovalRequired { .. }));
        let sent = sink.sent();
        assert_eq!(sent[0].content, "Run listing?");
        assert_eq!(
            sent[0].metadata.as_ref().unwrap()["runtime"],
            serde_json::json!("build-workspace-preflight")
        );
    }
}
