//! Port of `src/server/automation/executor.ts`.
//!
//! Deviation: TypeScript aborts an `AbortSignal` when the timeout fires and lets the prompt
//! runner clean up. This port drops the runner future when the timeout fires, which cancels
//! it at its next await point. The runner (S8) must therefore release resources through
//! `Drop`, not through a signal.

use std::time::Duration;

use super::error::AutomationError;
use super::service::{PromptRunInput, PromptRunner};

/// Default run timeout in milliseconds (`DEFAULT_TIMEOUT_MS` in TypeScript).
pub const DEFAULT_TIMEOUT_MS: u64 = 60_000;
/// Summary stored when the runner returns none or an empty one.
pub const DEFAULT_SUMMARY: &str = "Automation run completed.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRunExecutionInput {
    pub user_id: String,
    pub prompt: String,
    /// `None`, zero or a negative value means the default timeout.
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRunExecutionResult {
    pub summary: String,
}

/// `executeAgentRunAction`: runs one prompt under a timeout.
pub async fn execute_agent_run_action<R: PromptRunner>(
    input: AgentRunExecutionInput,
    runner: &R,
) -> Result<AgentRunExecutionResult, AutomationError> {
    let timeout_ms = match input.timeout_ms {
        Some(value) if value > 0 => value,
        _ => DEFAULT_TIMEOUT_MS,
    };
    let run = runner.run_prompt(PromptRunInput {
        user_id: input.user_id,
        prompt: input.prompt,
    });
    match tokio::time::timeout(Duration::from_millis(timeout_ms), run).await {
        Err(_) => Err(AutomationError::Timeout(timeout_ms)),
        Ok(Err(message)) => Err(AutomationError::Run(message)),
        Ok(Ok(output)) => Ok(AgentRunExecutionResult {
            summary: output
                .summary
                .filter(|summary| !summary.is_empty())
                .unwrap_or_else(|| DEFAULT_SUMMARY.to_string()),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::service::PromptRunOutput;

    struct SlowRunner;

    impl PromptRunner for SlowRunner {
        async fn run_prompt(&self, _input: PromptRunInput) -> Result<PromptRunOutput, String> {
            tokio::time::sleep(Duration::from_secs(5)).await;
            Ok(PromptRunOutput::default())
        }
    }

    struct BlankSummaryRunner;

    impl PromptRunner for BlankSummaryRunner {
        async fn run_prompt(&self, _input: PromptRunInput) -> Result<PromptRunOutput, String> {
            Ok(PromptRunOutput {
                summary: Some(String::new()),
            })
        }
    }

    #[tokio::test]
    async fn a_run_past_its_timeout_is_reported_as_a_timeout() {
        let input = AgentRunExecutionInput {
            user_id: "u1".to_string(),
            prompt: "slow".to_string(),
            timeout_ms: Some(10),
        };
        let error = execute_agent_run_action(input, &SlowRunner)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "Automation run exceeded timeout (10ms)");
    }

    #[tokio::test]
    async fn a_blank_summary_falls_back_to_the_default_text() {
        let input = AgentRunExecutionInput {
            user_id: "u1".to_string(),
            prompt: "quick".to_string(),
            timeout_ms: None,
        };
        let result = execute_agent_run_action(input, &BlankSummaryRunner)
            .await
            .expect("run succeeds");
        assert_eq!(result.summary, DEFAULT_SUMMARY);
    }
}
