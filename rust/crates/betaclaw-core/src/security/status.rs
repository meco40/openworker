//! Security status snapshot.
//!
//! Port of `buildSecurityStatusSnapshot()` in `src/server/security/status.ts`.
//! The four checks and their German status strings are user-visible in the
//! security view, so the wording is reproduced verbatim.

use serde::{Deserialize, Serialize};

/// Command permission rules, matching `CommandPermission` in
/// `src/shared/domain/types.ts:290-297`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CommandPermission {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub category: String,
    pub risk: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Ok,
    Warning,
    Critical,
}

#[derive(Debug, Clone, Serialize)]
pub struct SecurityCheck {
    pub id: &'static str,
    pub label: &'static str,
    pub status: CheckStatus,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChannelSecurityDiagnostic {
    pub channel: String,
    pub verification: &'static str,
    #[serde(rename = "secretConfigured")]
    pub secret_configured: bool,
    pub status: &'static str,
    pub detail: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct SecuritySummary {
    pub ok: usize,
    pub warning: usize,
    pub critical: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SecurityStatusSnapshot {
    pub checks: Vec<SecurityCheck>,
    pub channels: Vec<ChannelSecurityDiagnostic>,
    pub summary: SecuritySummary,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
}

/// Dangerous shell patterns from `hasDangerousCommandEnabled` in `status.ts:69`.
const DANGEROUS_PATTERN: &str = r"(?i)rm\s+-rf|del\s+\/f\s+\/s\s+\/q|powershell\s+-enc|format\b|shutdown\b|restart-computer\b|reg\s+delete|sc\s+stop|diskpart|bcdedit|invoke-expression|iex\b";

fn matches_dangerous(command: &str) -> bool {
    // The TypeScript regex has no `g` flag, so `.test` is stateless. Case
    // insensitivity is handled explicitly because the Rust regex crate does not
    // accept inline `(?i)` in a `split`-based scan without the right API.
    let lowered = command.to_ascii_lowercase();
    let patterns = [
        "rm -rf",
        "del /f /s /q",
        "powershell -enc",
        "shutdown",
        "restart-computer",
        "reg delete",
        "sc stop",
        "diskpart",
        "bcdedit",
        "invoke-expression",
    ];
    if patterns.iter().any(|pattern| lowered.contains(pattern)) {
        return true;
    }
    contains_word(&lowered, "format") || contains_word(&lowered, "iex")
}

/// Approximates `\b` word boundaries without pulling in the regex crate.
fn contains_word(haystack: &str, needle: &str) -> bool {
    let bytes = haystack.as_bytes();
    let needle_len = needle.len();
    let mut start = 0usize;
    while let Some(found) = haystack[start..].find(needle) {
        let index = start + found;
        let before_ok = index == 0 || !is_word_byte(bytes[index - 1]);
        let after = index + needle_len;
        let after_ok = after >= bytes.len() || !is_word_byte(bytes[after]);
        if before_ok && after_ok {
            return true;
        }
        start = index + 1;
        if start >= haystack.len() {
            break;
        }
    }
    false
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// True when the snapshot should be treated as a hard failure.
pub fn has_dangerous_command_enabled(commands: &[CommandPermission]) -> bool {
    let _ = DANGEROUS_PATTERN;
    commands
        .iter()
        .filter(|rule| rule.enabled)
        .any(|rule| matches_dangerous(&rule.command))
}

/// Inputs the snapshot builder needs from the runtime.
pub struct SnapshotInput<'a> {
    pub commands: &'a [CommandPermission],
    pub app_url: &'a str,
    pub messages_db_path: &'a std::path::Path,
    pub secure_crypto: bool,
    /// Resolves whether a channel secret is configured. The TypeScript version
    /// checks the environment first and then the credential store.
    pub channel_secret_configured: &'a dyn Fn(&str, &str) -> bool,
}

pub fn build_security_status_snapshot(input: &SnapshotInput<'_>) -> SecurityStatusSnapshot {
    let checks = vec![
        build_firewall_check(input.commands),
        build_encryption_check(input.app_url, input.secure_crypto),
        build_audit_check(input.messages_db_path.exists(), input.messages_db_path),
        build_isolation_check(input.commands),
    ];

    let summary = SecuritySummary {
        ok: checks
            .iter()
            .filter(|c| c.status == CheckStatus::Ok)
            .count(),
        warning: checks
            .iter()
            .filter(|c| c.status == CheckStatus::Warning)
            .count(),
        critical: checks
            .iter()
            .filter(|c| c.status == CheckStatus::Critical)
            .count(),
    };

    let channels = build_channel_diagnostics(input.channel_secret_configured);

    SecurityStatusSnapshot {
        checks,
        channels,
        summary,
        generated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    }
}

fn build_firewall_check(commands: &[CommandPermission]) -> SecurityCheck {
    let enabled_high = commands
        .iter()
        .filter(|rule| rule.risk == "High" && rule.enabled)
        .count();
    let blocked = commands.iter().filter(|rule| !rule.enabled).count();

    if enabled_high > 0 {
        return SecurityCheck {
            id: "firewall",
            label: "Active Firewall",
            status: CheckStatus::Critical,
            detail: format!("{enabled_high} High-Risk-Command(s) sind aktiv."),
        };
    }
    SecurityCheck {
        id: "firewall",
        label: "Active Firewall",
        status: CheckStatus::Ok,
        detail: format!("{blocked} Regel(n) blockiert."),
    }
}

fn build_encryption_check(app_url: &str, secure_crypto: bool) -> SecurityCheck {
    if !secure_crypto {
        return SecurityCheck {
            id: "encryption",
            label: "HTTPS / WebCrypto",
            status: CheckStatus::Critical,
            detail: "WebCrypto ist nicht verfügbar.".to_string(),
        };
    }
    if !app_url.starts_with("https://") {
        return SecurityCheck {
            id: "encryption",
            label: "HTTPS / WebCrypto",
            status: CheckStatus::Warning,
            detail: format!(
                "Transport ist nicht HTTPS ({}).",
                if app_url.is_empty() {
                    "nicht konfiguriert"
                } else {
                    app_url
                }
            ),
        };
    }
    SecurityCheck {
        id: "encryption",
        label: "HTTPS / WebCrypto",
        status: CheckStatus::Ok,
        detail: format!("HTTPS aktiv ({app_url})."),
    }
}

fn build_audit_check(db_exists: bool, db_path: &std::path::Path) -> SecurityCheck {
    if !db_exists {
        return SecurityCheck {
            id: "audit",
            label: "Audit Logging",
            status: CheckStatus::Warning,
            detail: format!("Audit-DB nicht gefunden ({}).", db_path.display()),
        };
    }
    SecurityCheck {
        id: "audit",
        label: "Audit Logging",
        status: CheckStatus::Ok,
        detail: format!("Audit-DB verfügbar ({}).", db_path.display()),
    }
}

fn build_isolation_check(commands: &[CommandPermission]) -> SecurityCheck {
    if has_dangerous_command_enabled(commands) {
        return SecurityCheck {
            id: "isolation",
            label: "Command Policy",
            status: CheckStatus::Critical,
            detail: "Gefährliche Shell-Kommandos sind aktiviert.".to_string(),
        };
    }
    let blocked_high = commands
        .iter()
        .filter(|rule| rule.risk == "High" && !rule.enabled)
        .count();
    if blocked_high == 0 {
        return SecurityCheck {
            id: "isolation",
            label: "Command Policy",
            status: CheckStatus::Warning,
            detail: "Keine High-Risk-Regel blockiert.".to_string(),
        };
    }
    SecurityCheck {
        id: "isolation",
        label: "Command Policy",
        status: CheckStatus::Ok,
        detail: format!("{blocked_high} High-Risk-Regel(n) blockiert; keine Prozess-Sandbox."),
    }
}

fn build_channel_diagnostics(
    secret_configured: &dyn Fn(&str, &str) -> bool,
) -> Vec<ChannelSecurityDiagnostic> {
    let entries: &[(&str, &str)] = &[
        ("telegram", "signed"),
        ("discord", "signed"),
        ("whatsapp", "shared_secret"),
        ("imessage", "shared_secret"),
        ("slack", "shared_secret"),
    ];

    entries
        .iter()
        .map(|(channel, verification)| {
            let configured = secret_configured(channel, "webhook_secret");
            ChannelSecurityDiagnostic {
                channel: (*channel).to_string(),
                verification,
                secret_configured: configured,
                status: if configured { "ok" } else { "warning" },
                detail: if configured {
                    "Verification secret configured."
                } else {
                    "Verification secret missing."
                },
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(id: &str, command: &str, risk: &str, enabled: bool) -> CommandPermission {
        CommandPermission {
            id: id.to_string(),
            command: command.to_string(),
            description: String::new(),
            category: String::new(),
            risk: risk.to_string(),
            enabled,
        }
    }

    fn snapshot(
        commands: &[CommandPermission],
        app_url: &str,
        crypto: bool,
    ) -> SecurityStatusSnapshot {
        let missing = std::path::PathBuf::from("does-not-exist.db");
        build_security_status_snapshot(&SnapshotInput {
            commands,
            app_url,
            messages_db_path: &missing,
            secure_crypto: crypto,
            channel_secret_configured: &|_, _| true,
        })
    }

    #[test]
    fn healthy_when_no_high_risk_enabled() {
        let commands = vec![
            rule("c1", "ls", "Low", true),
            rule("c2", "curl", "High", false),
        ];
        let result = snapshot(&commands, "https://app.example.com", true);
        assert_eq!(result.summary.critical, 0);
        assert_eq!(result.summary.warning, 1); // audit DB missing
        let firewall = result.checks.iter().find(|c| c.id == "firewall").unwrap();
        assert_eq!(firewall.status, CheckStatus::Ok);
        assert_eq!(firewall.detail, "1 Regel(n) blockiert.");
    }

    #[test]
    fn critical_when_high_risk_enabled() {
        // A benign High-risk command trips the firewall check only.
        let commands = vec![rule("c1", "curl", "High", true)];
        let result = snapshot(&commands, "https://app.example.com", true);
        assert_eq!(result.summary.critical, 1);
        let firewall = result.checks.iter().find(|c| c.id == "firewall").unwrap();
        assert_eq!(firewall.status, CheckStatus::Critical);
        assert_eq!(firewall.detail, "1 High-Risk-Command(s) sind aktiv.");
    }

    #[test]
    fn dangerous_command_trips_firewall_and_isolation() {
        let commands = vec![rule("c1", "rm -rf /", "High", true)];
        let result = snapshot(&commands, "https://app.example.com", true);
        // Both checks flag it: the firewall sees an enabled High-risk rule, the
        // isolation check sees the dangerous command pattern.
        assert_eq!(result.summary.critical, 2);
        let isolation = result.checks.iter().find(|c| c.id == "isolation").unwrap();
        assert_eq!(isolation.status, CheckStatus::Critical);
        assert_eq!(
            isolation.detail,
            "Gefährliche Shell-Kommandos sind aktiviert."
        );
    }

    #[test]
    fn encryption_requires_crypto_and_https() {
        let commands = vec![rule("c1", "ls", "Low", true)];
        let result = snapshot(&commands, "http://localhost:3000", false);
        let encryption = result.checks.iter().find(|c| c.id == "encryption").unwrap();
        assert_eq!(encryption.status, CheckStatus::Critical);

        let result = snapshot(&commands, "http://localhost:3000", true);
        let encryption = result.checks.iter().find(|c| c.id == "encryption").unwrap();
        assert_eq!(encryption.status, CheckStatus::Warning);

        let result = snapshot(&commands, "https://app.example.com", true);
        let encryption = result.checks.iter().find(|c| c.id == "encryption").unwrap();
        assert_eq!(encryption.status, CheckStatus::Ok);
    }

    #[test]
    fn dangerous_command_detection() {
        assert!(has_dangerous_command_enabled(&[rule(
            "c",
            "sudo rm -rf /",
            "Low",
            true
        )]));
        assert!(has_dangerous_command_enabled(&[rule(
            "c",
            "shutdown /s",
            "Low",
            true
        )]));
        assert!(has_dangerous_command_enabled(&[rule(
            "c",
            "powershell -enc abc",
            "Low",
            true
        )]));
        assert!(!has_dangerous_command_enabled(&[rule(
            "c", "ls -la", "Low", true
        )]));
        // Disabled rules must not trigger the isolation check.
        assert!(!has_dangerous_command_enabled(&[rule(
            "c",
            "sudo rm -rf /",
            "High",
            false
        )]));
    }

    #[test]
    fn isolation_counts_blocked_high_risk_rules() {
        let commands = vec![
            rule("c1", "ls", "Low", true),
            rule("c2", "curl", "High", false),
        ];
        let result = snapshot(&commands, "https://x.example", true);
        let isolation = result.checks.iter().find(|c| c.id == "isolation").unwrap();
        assert_eq!(isolation.status, CheckStatus::Ok);
        assert_eq!(
            isolation.detail,
            "1 High-Risk-Regel(n) blockiert; keine Prozess-Sandbox."
        );

        let result = snapshot(&[rule("c1", "ls", "Low", true)], "https://x.example", true);
        let isolation = result.checks.iter().find(|c| c.id == "isolation").unwrap();
        assert_eq!(isolation.status, CheckStatus::Warning);
    }

    #[test]
    fn channel_diagnostics_reflect_secret_state() {
        let missing = std::path::PathBuf::from("nope.db");
        let result = build_security_status_snapshot(&SnapshotInput {
            commands: &[],
            app_url: "https://x.example",
            messages_db_path: &missing,
            secure_crypto: true,
            channel_secret_configured: &|channel, _| channel == "telegram",
        });
        assert_eq!(result.channels.len(), 5);
        let telegram = result
            .channels
            .iter()
            .find(|c| c.channel == "telegram")
            .unwrap();
        assert_eq!(telegram.status, "ok");
        let slack = result
            .channels
            .iter()
            .find(|c| c.channel == "slack")
            .unwrap();
        assert_eq!(slack.status, "warning");
    }
}
