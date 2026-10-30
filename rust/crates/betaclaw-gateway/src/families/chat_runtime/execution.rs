//! Execution directives and the tool-call budget: the `ExecutionPort`.
//!
//! Port of `src/server/channels/messages/service/execution/buildExecution.ts` as composed by
//! `dispatchModelStage`. The build workspace preflight needs the sandboxed tool runtime,
//! which is not wired.

use std::sync::Arc;

use betaclaw_core::channels::messages::service::core::configuration::resolve_autonomous_build_max_tool_calls;
use betaclaw_core::channels::messages::service::execution::build_execution::{
    build_autonomous_execution_directive, resolve_max_tool_calls as resolve_budget, ActivePersona,
    DirectiveParams, MaxToolCallsParams, PreflightResult,
};
use betaclaw_core::channels::messages::service::execution::ports::PortResult;
use betaclaw_core::channels::messages::service::ports::{
    BoxFuture, ExecutionPort, MaxToolCallsInput, SendResponse,
};
use betaclaw_core::channels::messages::service::tool_manager::ToolManager;
use betaclaw_core::messages_store::types::{ChannelType, Conversation};
use betaclaw_core::model_hub::env::EnvOverrides;

use super::not_wired;

pub struct Execution {
    autonomous_build_max_tool_calls: u32,
}

impl Execution {
    /// Reads `AUTONOMOUS_BUILD_MAX_TOOL_CALLS` once, as `configuration.ts` does per call.
    pub fn from_env(env: &EnvOverrides) -> Self {
        let budget = resolve_autonomous_build_max_tool_calls(env).max(0);
        Self {
            autonomous_build_max_tool_calls: u32::try_from(budget).unwrap_or(u32::MAX),
        }
    }
}

impl ExecutionPort for Execution {
    fn autonomous_execution_directive(
        &self,
        workspace_cwd: Option<String>,
        build_intent: bool,
        is_autonomous_persona: bool,
    ) -> Option<String> {
        build_autonomous_execution_directive(&DirectiveParams {
            workspace_cwd: workspace_cwd.as_deref(),
            build_intent,
            is_autonomous_persona,
        })
    }

    fn resolve_max_tool_calls(&self, input: MaxToolCallsInput) -> i64 {
        let params = MaxToolCallsParams {
            is_autonomous_persona: input.is_autonomous_persona,
            // A persona is present whenever the caller passes its limit; the limit itself is always set.
            active_persona: input.persona_max_tool_calls.map(|max| ActivePersona {
                max_tool_calls: u32::try_from(max).ok(),
            }),
            build_intent: input.build_intent,
            override_max_tool_calls: input
                .override_max_tool_calls
                .and_then(|value| u32::try_from(value).ok()),
            autonomous_build_max_tool_calls: self.autonomous_build_max_tool_calls,
        };
        // An absent budget becomes 0. `normalize_max_tool_calls` clamps both 0 and an absent
        // value to the same floor, so the tool loop behaves the same.
        resolve_budget(&params).map_or(0, i64::from)
    }

    fn run_build_workspace_preflight(
        &self,
        _conversation: Conversation,
        _platform: ChannelType,
        _external_chat_id: String,
        _workspace_cwd: String,
        _tools: Arc<ToolManager>,
        _send: Arc<dyn SendResponse>,
    ) -> BoxFuture<'_, PortResult<PreflightResult>> {
        Box::pin(std::future::ready(Err(not_wired(
            "ExecutionPort",
            "run_build_workspace_preflight",
        ))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(build_intent: bool, autonomous: bool) -> MaxToolCallsInput {
        MaxToolCallsInput {
            is_autonomous_persona: autonomous,
            persona_max_tool_calls: None,
            build_intent,
            override_max_tool_calls: None,
        }
    }

    #[test]
    fn a_plain_chat_turn_has_no_directive_and_a_build_gets_the_budget() {
        let execution = Execution::from_env(&EnvOverrides::new());
        assert_eq!(
            execution.autonomous_execution_directive(None, false, false),
            None
        );
        assert!(execution
            .autonomous_execution_directive(Some("/work".into()), true, false)
            .is_some_and(|text| text.contains("/work")));
        assert_eq!(execution.resolve_max_tool_calls(input(true, false)), 120);
        // A plain chat has no budget, which becomes 0 (normalized to the floor later).
        assert_eq!(execution.resolve_max_tool_calls(input(false, false)), 0);
    }

    #[test]
    fn an_explicit_override_wins_over_the_build_budget() {
        let execution = Execution::from_env(&EnvOverrides::new());
        let mut overridden = input(true, false);
        overridden.override_max_tool_calls = Some(7);
        assert_eq!(execution.resolve_max_tool_calls(overridden), 7);
    }
}
