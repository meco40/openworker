//! Port of `src/server/automation/commands.ts`: parses the `/cron` chat command.
//!
//! The chat handler that acts on the parsed result (`channels/messages/service/commands/automationCommand.ts`)
//! belongs to S8 and is not ported.

use regex::Regex;

use super::cron_engine::interval_to_cron_expression;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedCronCommand {
    Add {
        cron_expression: String,
        timezone: String,
        prompt: String,
        name: Option<String>,
    },
    Every {
        interval: String,
        cron_expression: String,
        timezone: String,
        prompt: String,
        name: Option<String>,
    },
    List,
    Pause {
        rule_id: String,
    },
    Resume {
        rule_id: String,
    },
    Remove {
        rule_id: String,
    },
    Run {
        rule_id: String,
    },
    Unsupported {
        reason: String,
    },
}

/// `extractQuotedValue`: the text in double quotes right after `flag`. Blank values give `None`.
fn extract_quoted_value(input: &str, flag: &str) -> Option<String> {
    let flag_index = input
        .to_ascii_lowercase()
        .find(&flag.to_ascii_lowercase())?;
    let value_start = flag_index + flag.len();
    let after_flag = input[value_start..].trim_start();
    if !after_flag.starts_with('"') {
        return None;
    }
    let end = after_flag[1..].find('"')? + 1;
    if end <= 1 {
        return None;
    }
    Some(after_flag[1..end].to_string())
}

/// `extractRuleId`: `/cron <action> <id>` and nothing else.
fn extract_rule_id(input: &str, action: &str) -> Option<String> {
    let segments: Vec<&str> = input.split_whitespace().collect();
    if segments.len() != 3 {
        return None;
    }
    if !segments[0].eq_ignore_ascii_case("/cron") || !segments[1].eq_ignore_ascii_case(action) {
        return None;
    }
    Some(segments[2].to_string())
}

/// First capture group of `pattern` in `input`, or an empty string (`match?.[1] || ''`).
fn first_quoted(input: &str, pattern: &str) -> String {
    Regex::new(pattern)
        .ok()
        .and_then(|regex| regex.captures(input))
        .and_then(|captures| captures.get(1))
        .map_or_else(String::new, |found| found.as_str().to_string())
}

pub fn parse_cron_command(content: &str) -> ParsedCronCommand {
    let trimmed = content.trim();
    let lower = trimmed.to_lowercase();

    if !lower.starts_with("/cron") {
        return ParsedCronCommand::Unsupported {
            reason: "Not a /cron command".to_string(),
        };
    }
    if lower == "/cron list" {
        return ParsedCronCommand::List;
    }

    if lower.starts_with("/cron add ") {
        let cron_expression = first_quoted(trimmed, r#"(?i)^/cron\s+add\s+"([^"]+)""#);
        let timezone = extract_quoted_value(trimmed, "--tz").unwrap_or_else(|| "UTC".to_string());
        let prompt = extract_quoted_value(trimmed, "--prompt");
        let name = extract_quoted_value(trimmed, "--name");
        return match prompt {
            Some(prompt) if !cron_expression.is_empty() => ParsedCronCommand::Add {
                cron_expression,
                timezone,
                prompt,
                name,
            },
            _ => ParsedCronCommand::Unsupported {
                reason: "Missing cron expression or prompt for /cron add".to_string(),
            },
        };
    }

    if lower.starts_with("/cron every ") {
        let interval = first_quoted(trimmed, r#"(?i)^/cron\s+every\s+"([^"]+)""#);
        let cron_expression = interval_to_cron_expression(&interval);
        let timezone = extract_quoted_value(trimmed, "--tz").unwrap_or_else(|| "UTC".to_string());
        let prompt = extract_quoted_value(trimmed, "--prompt");
        let name = extract_quoted_value(trimmed, "--name");
        return match (cron_expression, prompt) {
            (Some(cron_expression), Some(prompt)) if !interval.is_empty() => {
                ParsedCronCommand::Every {
                    interval,
                    cron_expression,
                    timezone,
                    prompt,
                    name,
                }
            }
            _ => ParsedCronCommand::Unsupported {
                reason: "Invalid interval or prompt for /cron every".to_string(),
            },
        };
    }

    if let Some(rule_id) = extract_rule_id(trimmed, "pause") {
        return ParsedCronCommand::Pause { rule_id };
    }
    if let Some(rule_id) = extract_rule_id(trimmed, "resume") {
        return ParsedCronCommand::Resume { rule_id };
    }
    if let Some(rule_id) = extract_rule_id(trimmed, "remove") {
        return ParsedCronCommand::Remove { rule_id };
    }
    if let Some(rule_id) = extract_rule_id(trimmed, "run") {
        return ParsedCronCommand::Run { rule_id };
    }

    ParsedCronCommand::Unsupported {
        reason: "Unknown /cron subcommand".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_takes_expression_timezone_prompt_and_name() {
        let parsed = parse_cron_command(
            r#"/cron add "0 9 * * *" --tz "Europe/Berlin" --prompt "Briefing" --name "Morning""#,
        );
        assert_eq!(
            parsed,
            ParsedCronCommand::Add {
                cron_expression: "0 9 * * *".to_string(),
                timezone: "Europe/Berlin".to_string(),
                prompt: "Briefing".to_string(),
                name: Some("Morning".to_string()),
            }
        );
    }

    #[test]
    fn every_converts_the_interval_and_defaults_the_timezone() {
        let parsed = parse_cron_command(r#"/cron every "10m" --prompt "Ping""#);
        assert_eq!(
            parsed,
            ParsedCronCommand::Every {
                interval: "10m".to_string(),
                cron_expression: "*/10 * * * *".to_string(),
                timezone: "UTC".to_string(),
                prompt: "Ping".to_string(),
                name: None,
            }
        );
    }

    #[test]
    fn rule_subcommands_take_an_id_and_incomplete_commands_are_unsupported() {
        assert_eq!(
            parse_cron_command("/cron pause rule-1"),
            ParsedCronCommand::Pause {
                rule_id: "rule-1".to_string()
            }
        );
        assert!(matches!(
            parse_cron_command(r#"/cron add "0 9 * * *""#),
            ParsedCronCommand::Unsupported { .. }
        ));
        assert_eq!(
            parse_cron_command("hello"),
            ParsedCronCommand::Unsupported {
                reason: "Not a /cron command".to_string()
            }
        );
    }
}
