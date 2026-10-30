//! Message routing and command handlers: the `CommandPort`.
//!
//! `route_message` is a port of `src/server/channels/messages/messageRouter.ts`, a pure
//! prefix match. `handle_command` runs the core handlers of `commands/` with the production
//! ports: approval, shell, persona, project, automation (`/cron`) and subagent.

use std::sync::Arc;

use serde_json::{Map, Value};

use betaclaw_core::automation::commands::{parse_cron_command, ParsedCronCommand};
use betaclaw_core::automation::service::AutomationService;
use betaclaw_core::automation::sqlite_repository::SqliteAutomationRepository;
use betaclaw_core::automation::types::{CreateAutomationRuleInput, UpdateAutomationRuleInput};
use betaclaw_core::channels::messages::service::commands::approval::handle_approval_command;
use betaclaw_core::channels::messages::service::commands::automation::{
    handle_automation_command, AutomationPort, AutomationRule, AutomationRun, CronCommand,
    NewAutomationRule,
};
use betaclaw_core::channels::messages::service::commands::persona::handle_persona_command;
use betaclaw_core::channels::messages::service::commands::project::{
    handle_project_command, ProjectDeps,
};
use betaclaw_core::channels::messages::service::commands::shell::handle_shell_command;
use betaclaw_core::channels::messages::service::commands::subagent::handle_subagent_command;
use betaclaw_core::channels::messages::service::commands::types::{
    CommandHandlerDeps, SubagentManagerPort,
};
use betaclaw_core::channels::messages::service::execution::ports::{PortResult, ToolManagerPort};
use betaclaw_core::channels::messages::service::orchestration::subagent_tool_approval::SubagentCommandDeps;
use betaclaw_core::channels::messages::service::ports::{
    BoxFuture, ChatStore, CommandInput, CommandKind, CommandPort, PersonaPort, RouteResult,
    RouteTarget, SendResponse,
};
use betaclaw_core::channels::messages::service::subagent::registry::SubagentRunRecord;
use betaclaw_core::channels::messages::service::subagent::types::{
    RunSubagentParams, StartSubagentRunParams, SubagentManagerDeps,
};
use betaclaw_core::channels::messages::service::tool_manager::ToolManager;
use betaclaw_core::channels::messages::service::types::SubagentDispatchContext;
use betaclaw_core::messages_store::types::{ChannelType, Conversation, StoredMessage};

use crate::families::tasks::UnwiredPromptRunner;

use super::failed;
use super::tools::ToolPort;
use super::unwired::SubagentManagerAdapter;

const SESSION_COMMANDS: [&str; 2] = ["/new", "/reset"];
const APPROVAL_COMMANDS: [&str; 2] = ["/approve", "/deny"];
const SHELL_COMMANDS: [&str; 2] = ["/shell", "/bash"];
const SUBAGENT_COMMANDS: [&str; 3] = ["/subagents", "/kill", "/steer"];

/// `lower === command || lower.startsWith(command + ' ')`.
fn matches_command(lower: &str, command: &str) -> bool {
    lower == command
        || lower
            .strip_prefix(command)
            .is_some_and(|rest| rest.starts_with(' '))
}

/// `trimmed.slice(command.length).trim()`. The command is ASCII, so counting characters
/// keeps the payload aligned with the TypeScript slice.
fn payload_after(trimmed: &str, command: &str) -> String {
    trimmed
        .chars()
        .skip(command.chars().count())
        .collect::<String>()
        .trim()
        .to_string()
}

fn routed(trimmed: &str, target: RouteTarget, command: &str) -> RouteResult {
    RouteResult {
        target,
        payload: Some(payload_after(trimmed, command)),
        command: Some(command.to_string()),
    }
}

/// `routeMessage(content)` (`messageRouter.ts`). The first matching prefix wins; anything
/// else is a chat message.
pub fn route_message(content: &str) -> RouteResult {
    let trimmed = content.trim();
    let lower = trimmed.to_lowercase();

    for command in SESSION_COMMANDS {
        if matches_command(&lower, command) {
            return routed(trimmed, RouteTarget::SessionCommand, command);
        }
    }
    if matches_command(&lower, "/persona") {
        return routed(trimmed, RouteTarget::PersonaCommand, "/persona");
    }
    if matches_command(&lower, "/cron") {
        return routed(trimmed, RouteTarget::AutomationCommand, "/cron");
    }
    if matches_command(&lower, "/project") {
        return routed(trimmed, RouteTarget::ProjectCommand, "/project");
    }
    for command in APPROVAL_COMMANDS {
        if matches_command(&lower, command) {
            return routed(trimmed, RouteTarget::ApprovalCommand, command);
        }
    }
    for command in SHELL_COMMANDS {
        if matches_command(&lower, command) {
            return routed(trimmed, RouteTarget::ShellCommand, command);
        }
    }
    for command in SUBAGENT_COMMANDS {
        if matches_command(&lower, command) {
            return routed(trimmed, RouteTarget::SubagentCommand, command);
        }
    }
    if trimmed.starts_with('!') {
        return routed(trimmed, RouteTarget::ShellCommand, "!");
    }

    RouteResult {
        target: RouteTarget::None,
        payload: Some(trimmed.to_string()),
        command: None,
    }
}

/// The command handlers of the service, with the ports they read.
pub struct Commands {
    pub personas: Arc<dyn PersonaPort>,
    pub tools: Arc<ToolManager>,
    pub history: Arc<dyn ChatStore>,
    pub subagents: Arc<SubagentManagerAdapter>,
    pub subagent_deps: Arc<SubagentCommandDeps>,
    pub automation_db_path: String,
}

impl CommandPort for Commands {
    fn route_message(&self, content: &str) -> RouteResult {
        route_message(content)
    }

    fn handle_command(
        &self,
        kind: CommandKind,
        input: CommandInput,
    ) -> BoxFuture<'_, PortResult<StoredMessage>> {
        Box::pin(async move { self.run(kind, input).await })
    }
}

impl Commands {
    async fn run(&self, kind: CommandKind, input: CommandInput) -> PortResult<StoredMessage> {
        let conversation: &Conversation = &input.conversation;
        let payload = input.payload.clone().unwrap_or_default();
        let command = input.command.clone();
        let platform: ChannelType = input.platform;
        let chat = input.external_chat_id.clone();

        match kind {
            CommandKind::Approval => {
                let deps = self.deps(&input);
                handle_approval_command(
                    conversation,
                    &payload,
                    command.as_deref(),
                    platform,
                    &chat,
                    &deps,
                    &*input.approvals,
                )
                .await
            }
            CommandKind::Shell => {
                let deps = self.deps(&input);
                handle_shell_command(conversation, &payload, platform, &chat, &deps).await
            }
            CommandKind::Persona => {
                handle_persona_command(
                    conversation,
                    &payload,
                    platform,
                    &chat,
                    &*input.repo,
                    Some(&*self.personas),
                    &*input.send,
                )
                .await
            }
            CommandKind::Project => {
                let deps = ProjectDeps {
                    projects: Some(&*input.repo),
                    personas: Some(&*self.personas),
                };
                handle_project_command(conversation, &payload, platform, &chat, &deps, &*input.send)
                    .await
            }
            CommandKind::Automation => {
                let automation = SqliteAutomationPort {
                    db_path: self.automation_db_path.clone(),
                };
                handle_automation_command(
                    conversation,
                    &payload,
                    platform,
                    &chat,
                    &automation,
                    &*input.send,
                )
                .await
            }
            CommandKind::Subagent => {
                let deps = self.deps(&input);
                let context = SubagentDispatchContext {
                    conversation: conversation.clone(),
                    platform,
                    external_chat_id: chat,
                };
                handle_subagent_command(&context, &payload, command.as_deref(), &deps).await
            }
        }
    }

    fn deps(&self, input: &CommandInput) -> CommandDeps {
        CommandDeps {
            send: input.send.clone(),
            tools: ToolPort(self.tools.clone()),
            history: self.history.clone(),
            subagents: self.subagents.clone(),
            subagent_deps: self.subagent_deps.clone(),
        }
    }
}

struct SqliteAutomationPort {
    db_path: String,
}

impl SqliteAutomationPort {
    fn service(&self) -> PortResult<AutomationService<UnwiredPromptRunner>> {
        let repo = SqliteAutomationRepository::open(&self.db_path).map_err(failed)?;
        Ok(AutomationService::new(repo, UnwiredPromptRunner))
    }
}

fn to_command_rule(rule: betaclaw_core::automation::types::AutomationRule) -> AutomationRule {
    AutomationRule {
        id: rule.id,
        name: rule.name,
        enabled: rule.enabled,
        cron_expression: rule.cron_expression,
        timezone: rule.timezone,
        next_run_at: rule.next_run_at,
    }
}

impl AutomationPort for SqliteAutomationPort {
    fn parse_cron_command(&self, full_command: &str) -> CronCommand {
        match parse_cron_command(full_command) {
            ParsedCronCommand::Add {
                cron_expression,
                timezone,
                prompt,
                name,
            }
            | ParsedCronCommand::Every {
                cron_expression,
                timezone,
                prompt,
                name,
                ..
            } => CronCommand::Create {
                cron_expression,
                timezone,
                prompt,
                name,
            },
            ParsedCronCommand::List => CronCommand::List,
            ParsedCronCommand::Pause { rule_id } => CronCommand::Pause(rule_id),
            ParsedCronCommand::Resume { rule_id } => CronCommand::Resume(rule_id),
            ParsedCronCommand::Remove { rule_id } => CronCommand::Remove(rule_id),
            ParsedCronCommand::Run { rule_id } => CronCommand::Run(rule_id),
            ParsedCronCommand::Unsupported { reason } => CronCommand::Unsupported { reason },
        }
    }

    fn list_rules(&self, user_id: &str) -> PortResult<Vec<AutomationRule>> {
        let service = self.service()?;
        Ok(service
            .list_rules(user_id)
            .map_err(failed)?
            .into_iter()
            .map(to_command_rule)
            .collect())
    }

    fn create_rule(&self, input: NewAutomationRule) -> PortResult<AutomationRule> {
        let service = self.service()?;
        service
            .create_rule(&CreateAutomationRuleInput {
                user_id: input.user_id,
                name: input.name,
                cron_expression: input.cron_expression,
                timezone: input.timezone,
                prompt: input.prompt,
                enabled: input.enabled,
                next_run_at: None,
            })
            .map(to_command_rule)
            .map_err(failed)
    }

    fn update_rule_enabled(
        &self,
        rule_id: &str,
        user_id: &str,
        enabled: bool,
    ) -> PortResult<Option<AutomationRule>> {
        let service = self.service()?;
        service
            .update_rule(
                rule_id,
                user_id,
                &UpdateAutomationRuleInput {
                    enabled: Some(enabled),
                    ..Default::default()
                },
            )
            .map(|opt| opt.map(to_command_rule))
            .map_err(failed)
    }

    fn delete_rule(&self, rule_id: &str, user_id: &str) -> PortResult<bool> {
        let service = self.service()?;
        service.delete_rule(rule_id, user_id).map_err(failed)
    }

    fn create_manual_run(&self, rule_id: &str, user_id: &str) -> PortResult<AutomationRun> {
        let service = self.service()?;
        service
            .create_manual_run(rule_id, user_id)
            .map(|run| AutomationRun {
                id: run.id,
                rule_id: run.rule_id,
            })
            .map_err(failed)
    }
}

/// `CommandHandlerDeps` for the approval, shell and subagent handlers.
struct CommandDeps {
    send: Arc<dyn SendResponse>,
    tools: ToolPort,
    history: Arc<dyn ChatStore>,
    subagents: Arc<SubagentManagerAdapter>,
    subagent_deps: Arc<SubagentCommandDeps>,
}

impl SendResponse for CommandDeps {
    fn send_response<'a>(
        &'a self,
        conversation: &'a Conversation,
        content: &'a str,
        platform: ChannelType,
        external_chat_id: &'a str,
        metadata: Option<Map<String, Value>>,
    ) -> BoxFuture<'a, PortResult<StoredMessage>> {
        self.send
            .send_response(conversation, content, platform, external_chat_id, metadata)
    }
}

impl SubagentManagerDeps for CommandDeps {
    fn start_subagent_run(&self, params: StartSubagentRunParams) -> PortResult<SubagentRunRecord> {
        self.subagent_deps.start_subagent_run(params)
    }

    fn run_subagent(&self, params: RunSubagentParams) {
        self.subagent_deps.run_subagent(params);
    }
}

impl CommandHandlerDeps for CommandDeps {
    fn subagent_manager(&self) -> &dyn SubagentManagerPort {
        self.subagents.as_ref()
    }

    fn tool_manager(&self) -> &dyn ToolManagerPort {
        &self.tools
    }

    fn history(&self) -> &dyn ChatStore {
        &*self.history
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_route_to_their_handlers_and_plain_text_is_chat() {
        let cases = [
            ("/new", RouteTarget::SessionCommand, "/new", ""),
            (
                "  /RESET now ",
                RouteTarget::SessionCommand,
                "/reset",
                "now",
            ),
            (
                "/persona list",
                RouteTarget::PersonaCommand,
                "/persona",
                "list",
            ),
            (
                "/cron 0 9 * * *",
                RouteTarget::AutomationCommand,
                "/cron",
                "0 9 * * *",
            ),
            ("/project x", RouteTarget::ProjectCommand, "/project", "x"),
            (
                "/approve abc",
                RouteTarget::ApprovalCommand,
                "/approve",
                "abc",
            ),
            ("!ls -la", RouteTarget::ShellCommand, "!", "ls -la"),
            ("/bash pwd", RouteTarget::ShellCommand, "/bash", "pwd"),
            ("/kill 3", RouteTarget::SubagentCommand, "/kill", "3"),
        ];
        for (input, target, command, payload) in cases {
            let result = route_message(input);
            assert_eq!(result.target, target, "input {input:?}");
            assert_eq!(result.command.as_deref(), Some(command), "input {input:?}");
            assert_eq!(result.payload.as_deref(), Some(payload), "input {input:?}");
        }

        let chat = route_message("  Hallo /new  ");
        assert_eq!(chat.target, RouteTarget::None);
        assert_eq!(chat.payload.as_deref(), Some("Hallo /new"));
        assert_eq!(chat.command, None);
    }

    #[test]
    fn a_prefix_must_be_followed_by_a_space_or_the_end() {
        assert_eq!(route_message("/newish").target, RouteTarget::None);
        assert_eq!(route_message("/persona-x").target, RouteTarget::None);
    }
}
