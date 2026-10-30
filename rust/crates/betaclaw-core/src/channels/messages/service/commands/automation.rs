//! Port of `src/server/channels/messages/service/commands/automationCommand.ts` (S8).
//!
//! The cron parser (`server/automation/commands.ts`) and the automation service
//! (`server/automation/service.ts`, S10) are reached through [`AutomationPort`]. Deviation: a
//! failing `getAutomationService()` is not reported on its own. Each port method returns its own
//! error, and the `run` branch turns that into the `❌` reply.

use crate::channels::messages::service::commands::types::reply;
use crate::channels::messages::service::execution::ports::PortError;
use crate::channels::messages::service::ports::SendResponse;
use crate::messages_store::types::{ChannelType, Conversation, StoredMessage};

/// `AutomationRule` fields the reply uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub cron_expression: String,
    pub timezone: String,
    pub next_run_at: Option<String>,
}

/// `CreateAutomationRuleInput` as the `/cron add` and `/cron every` branches fill it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewAutomationRule {
    pub user_id: String,
    pub name: String,
    pub cron_expression: String,
    pub timezone: String,
    pub prompt: String,
    pub enabled: bool,
}

/// `AutomationRun` fields the reply uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationRun {
    pub id: String,
    pub rule_id: String,
}

/// Result of `parseCronCommand`. `add` and `every` share one variant, because the handler
/// treats them the same. The `every` interval is not read here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CronCommand {
    Create {
        cron_expression: String,
        timezone: String,
        prompt: String,
        name: Option<String>,
    },
    List,
    Pause(String),
    Resume(String),
    Remove(String),
    Run(String),
    Unsupported {
        reason: String,
    },
}

pub trait AutomationPort: Send + Sync {
    /// `parseCronCommand` over the full `/cron ...` text.
    fn parse_cron_command(&self, full_command: &str) -> CronCommand;

    fn list_rules(&self, user_id: &str) -> Result<Vec<AutomationRule>, PortError>;

    fn create_rule(&self, input: NewAutomationRule) -> Result<AutomationRule, PortError>;

    /// `updateRule(id, userId, { enabled })`. `None` if the rule does not exist for the user.
    fn update_rule_enabled(
        &self,
        rule_id: &str,
        user_id: &str,
        enabled: bool,
    ) -> Result<Option<AutomationRule>, PortError>;

    fn delete_rule(&self, rule_id: &str, user_id: &str) -> Result<bool, PortError>;

    fn create_manual_run(&self, rule_id: &str, user_id: &str) -> Result<AutomationRun, PortError>;
}

/// `parsed.prompt.slice(0, 40)`. JS slices UTF-16 code units, so the cut follows that unit count.
/// A cut through a surrogate pair becomes U+FFFD, because Rust strings cannot hold lone surrogates.
fn js_prefix(text: &str, units: usize) -> String {
    let utf16: Vec<u16> = text.encode_utf16().take(units).collect();
    String::from_utf16_lossy(&utf16)
}

fn next_run_label(next_run_at: &Option<String>) -> &str {
    match next_run_at.as_deref() {
        Some(next) if !next.is_empty() => next,
        _ => "n/a",
    }
}

pub async fn handle_automation_command(
    conversation: &Conversation,
    payload: &str,
    platform: ChannelType,
    external_chat_id: &str,
    automation: &dyn AutomationPort,
    sender: &dyn SendResponse,
) -> Result<StoredMessage, PortError> {
    let full_command = if payload.is_empty() {
        "/cron".to_string()
    } else {
        format!("/cron {payload}")
    };
    let parsed = automation.parse_cron_command(&full_command);
    let user_id = conversation.user_id.as_str();

    match parsed {
        CronCommand::List => {
            let rules = automation.list_rules(user_id)?;
            if rules.is_empty() {
                return reply(
                    sender,
                    conversation,
                    "⏱️ Keine Cron-Regeln vorhanden.\nNutze z. B.: `/cron add \"0 10 * * *\" --tz \"Europe/Berlin\" --prompt \"Gib mir ein Briefing\"`",
                    platform,
                    external_chat_id,
                )
                .await;
            }
            let lines: Vec<String> = rules
                .iter()
                .map(|rule| {
                    format!(
                        "• {} **{}** (`{}`)\n  `{}` @ {}\n  next: {}",
                        if rule.enabled { "✓" } else { "⏸️" },
                        rule.name,
                        rule.id,
                        rule.cron_expression,
                        rule.timezone,
                        next_run_label(&rule.next_run_at),
                    )
                })
                .collect();
            let text = format!("⏱️ **Cron-Regeln:**\n{}", lines.join("\n"));
            reply(sender, conversation, &text, platform, external_chat_id).await
        }

        CronCommand::Create {
            cron_expression,
            timezone,
            prompt,
            name,
        } => {
            let name = name
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| js_prefix(&prompt, 40));
            let rule = automation.create_rule(NewAutomationRule {
                user_id: user_id.to_string(),
                name,
                cron_expression,
                timezone,
                prompt,
                enabled: true,
            })?;
            let text = format!(
                "✓ Cron-Regel erstellt: **{}**\nID: `{}`\nSchedule: `{}` ({})\nNächster Lauf: {}",
                rule.name,
                rule.id,
                rule.cron_expression,
                rule.timezone,
                next_run_label(&rule.next_run_at),
            );
            reply(sender, conversation, &text, platform, external_chat_id).await
        }

        CronCommand::Pause(rule_id) => {
            let text = match automation.update_rule_enabled(&rule_id, user_id, false)? {
                Some(rule) => format!("⏸️ Regel **{}** pausiert.", rule.name),
                None => format!("❌ Regel `{rule_id}` nicht gefunden."),
            };
            reply(sender, conversation, &text, platform, external_chat_id).await
        }

        CronCommand::Resume(rule_id) => {
            let text = match automation.update_rule_enabled(&rule_id, user_id, true)? {
                Some(rule) => format!("▶️ Regel **{}** aktiviert.", rule.name),
                None => format!("❌ Regel `{rule_id}` nicht gefunden."),
            };
            reply(sender, conversation, &text, platform, external_chat_id).await
        }

        CronCommand::Remove(rule_id) => {
            let text = if automation.delete_rule(&rule_id, user_id)? {
                format!("🗑️ Regel `{rule_id}` gelöscht.")
            } else {
                format!("❌ Regel `{rule_id}` nicht gefunden.")
            };
            reply(sender, conversation, &text, platform, external_chat_id).await
        }

        CronCommand::Run(rule_id) => {
            // The TS try block covers the reply too: a failing reply is reported as `❌`.
            let attempt = match automation.create_manual_run(&rule_id, user_id) {
                Ok(run) => {
                    let text = format!(
                        "🚀 Manueller Run erstellt: `{}` (Regel: `{}`).",
                        run.id, run.rule_id
                    );
                    reply(sender, conversation, &text, platform, external_chat_id).await
                }
                Err(error) => Err(error),
            };
            match attempt {
                Ok(message) => Ok(message),
                Err(error) => {
                    let text = format!("❌ {}", error);
                    reply(sender, conversation, &text, platform, external_chat_id).await
                }
            }
        }

        CronCommand::Unsupported { reason } => {
            let text = format!(
                "⚠️ {reason}\n\nUnterstützt:\n• /cron list\n• /cron add \"<cron>\" --tz \"<TZ>\" --prompt \"<Text>\"\n• /cron every \"10m|1h|1d\" --prompt \"<Text>\"\n• /cron pause <id>\n• /cron resume <id>\n• /cron remove <id>\n• /cron run <id>"
            );
            reply(sender, conversation, &text, platform, external_chat_id).await
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::channels::messages::service::commands::fakes::RecordingSender;
    use crate::channels::messages::service::conversation::fakes::conversation;

    /// Automation double with a canned parse result and a configurable run error.
    struct FakeAutomation {
        parsed: CronCommand,
        rules: Vec<AutomationRule>,
        run_error: Option<String>,
        created: Mutex<Vec<NewAutomationRule>>,
    }

    fn rule(id: &str, name: &str, enabled: bool) -> AutomationRule {
        AutomationRule {
            id: id.to_string(),
            name: name.to_string(),
            enabled,
            cron_expression: "0 10 * * *".to_string(),
            timezone: "Europe/Berlin".to_string(),
            next_run_at: None,
        }
    }

    impl AutomationPort for FakeAutomation {
        fn parse_cron_command(&self, _full_command: &str) -> CronCommand {
            self.parsed.clone()
        }

        fn list_rules(&self, _user_id: &str) -> Result<Vec<AutomationRule>, PortError> {
            Ok(self.rules.clone())
        }

        fn create_rule(&self, input: NewAutomationRule) -> Result<AutomationRule, PortError> {
            let created = rule("rule-new", &input.name, input.enabled);
            self.created.lock().unwrap().push(input);
            Ok(created)
        }

        fn update_rule_enabled(
            &self,
            rule_id: &str,
            _user_id: &str,
            enabled: bool,
        ) -> Result<Option<AutomationRule>, PortError> {
            Ok(self
                .rules
                .iter()
                .find(|r| r.id == rule_id)
                .map(|r| AutomationRule {
                    enabled,
                    ..r.clone()
                }))
        }

        fn delete_rule(&self, rule_id: &str, _user_id: &str) -> Result<bool, PortError> {
            Ok(self.rules.iter().any(|r| r.id == rule_id))
        }

        fn create_manual_run(
            &self,
            rule_id: &str,
            _user_id: &str,
        ) -> Result<AutomationRun, PortError> {
            match &self.run_error {
                Some(message) => Err(PortError::Failed(message.clone())),
                None => Ok(AutomationRun {
                    id: "run-1".to_string(),
                    rule_id: rule_id.to_string(),
                }),
            }
        }
    }

    fn fake(parsed: CronCommand) -> FakeAutomation {
        FakeAutomation {
            parsed,
            rules: Vec::new(),
            run_error: None,
            created: Mutex::new(Vec::new()),
        }
    }

    #[tokio::test]
    async fn list_without_rules_points_to_the_add_syntax() {
        let automation = fake(CronCommand::List);
        let sender = RecordingSender::default();
        let conv = conversation("c1", "user-1", None, "WebChat");

        handle_automation_command(
            &conv,
            "",
            ChannelType::WebChat,
            "chat",
            &automation,
            &sender,
        )
        .await
        .unwrap();

        assert!(sender
            .last()
            .content
            .starts_with("⏱️ Keine Cron-Regeln vorhanden."));
    }

    #[tokio::test]
    async fn create_without_name_uses_the_first_forty_prompt_units() {
        let prompt = "x".repeat(50);
        let automation = fake(CronCommand::Create {
            cron_expression: "0 10 * * *".to_string(),
            timezone: "Europe/Berlin".to_string(),
            prompt: prompt.clone(),
            name: Some(String::new()),
        });
        let sender = RecordingSender::default();
        let conv = conversation("c1", "user-1", None, "WebChat");

        handle_automation_command(
            &conv,
            "x",
            ChannelType::WebChat,
            "chat",
            &automation,
            &sender,
        )
        .await
        .unwrap();

        let created = automation.created.lock().unwrap();
        assert_eq!(created[0].name, "x".repeat(40));
        assert!(created[0].enabled);
        assert_eq!(created[0].user_id, "user-1");
        assert!(sender.last().content.contains("ID: `rule-new`"));
    }

    #[tokio::test]
    async fn pause_of_an_unknown_rule_reports_not_found() {
        let automation = fake(CronCommand::Pause("missing".to_string()));
        let sender = RecordingSender::default();
        let conv = conversation("c1", "user-1", None, "WebChat");

        handle_automation_command(
            &conv,
            "missing",
            ChannelType::WebChat,
            "chat",
            &automation,
            &sender,
        )
        .await
        .unwrap();

        assert_eq!(sender.last().content, "❌ Regel `missing` nicht gefunden.");
    }

    #[tokio::test]
    async fn run_failure_is_reported_with_the_port_message() {
        let mut automation = fake(CronCommand::Run("rule-1".to_string()));
        automation.run_error = Some("Regel ist pausiert".to_string());
        let sender = RecordingSender::default();
        let conv = conversation("c1", "user-1", None, "WebChat");

        handle_automation_command(
            &conv,
            "rule-1",
            ChannelType::WebChat,
            "chat",
            &automation,
            &sender,
        )
        .await
        .unwrap();

        assert_eq!(sender.last().content, "❌ Regel ist pausiert");
    }

    #[tokio::test]
    async fn unsupported_shows_the_reason_and_the_supported_forms() {
        let automation = fake(CronCommand::Unsupported {
            reason: "Unknown /cron subcommand".to_string(),
        });
        let sender = RecordingSender::default();
        let conv = conversation("c1", "user-1", None, "WebChat");

        handle_automation_command(
            &conv,
            "x",
            ChannelType::WebChat,
            "chat",
            &automation,
            &sender,
        )
        .await
        .unwrap();

        let text = sender.last().content;
        assert!(text.starts_with("⚠️ Unknown /cron subcommand\n\nUnterstützt:"));
        assert!(text.ends_with("• /cron run <id>"));
    }
}
