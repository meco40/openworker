//! Log service: category and level resolution plus the gateway broadcast hook.
//!
//! Port of `src/logging/logService.ts`. Level and category mapping is part of the
//! observable behaviour of `/api/logs/ingest` and the `log.entry` event, so the
//! tables are copied exactly.

use std::sync::Arc;

use serde_json::Value;

use super::repository::{LogCategory, LogEntry, LogLevel, LogRepository};
use crate::gateway::broadcast::broadcast_to_subscribed;
use crate::gateway::events::LOG_ENTRY;
use crate::gateway::registry::ClientRegistry;

/// `TYPE_LEVEL_MAP` from `logService.ts:6-13`.
fn type_level(event_type: &str) -> Option<LogLevel> {
    match event_type {
        "AUTH" | "CHAN" | "TOOL" | "SYS" | "MEM" | "TASK" => Some(LogLevel::Info),
        _ => None,
    }
}

/// `SOURCE_CATEGORY_MAP` from `logService.ts:15-24`.
pub fn resolve_category(source: &str) -> LogCategory {
    match source.to_ascii_uppercase().as_str() {
        "AUTH" => LogCategory::Security,
        "CHAN" => LogCategory::Channel,
        "TOOL" => LogCategory::Tooling,
        "SYS" => LogCategory::System,
        "MEM" => LogCategory::Memory,
        "TASK" => LogCategory::Worker,
        "BRIDGE" => LogCategory::Integration,
        "GATEWAY" => LogCategory::System,
        _ => LogCategory::System,
    }
}

/// Level for a client-supplied system event, escalating on message content.
///
/// Port of `logFromSystemEvent()`.
pub fn resolve_level(event_type: &str, message: &str) -> LogLevel {
    let base = type_level(event_type).unwrap_or(LogLevel::Info);
    let lower = message.to_ascii_lowercase();

    if lower.contains("failed") || lower.contains("error") || lower.contains("lost") {
        return LogLevel::Error;
    }
    if lower.contains("warning") || lower.contains("spike") || lower.contains("timeout") {
        return LogLevel::Warn;
    }
    base
}

/// Persists a log entry and fans it out to subscribed gateway clients.
pub fn log(
    repository: &LogRepository,
    registry: Option<&Arc<ClientRegistry>>,
    level: LogLevel,
    source: &str,
    message: &str,
    metadata: Option<&Value>,
    category: Option<LogCategory>,
) -> Result<LogEntry, crate::logging::repository::LogRepositoryError> {
    let normalized_source = source.to_ascii_uppercase();
    let category = category.unwrap_or_else(|| resolve_category(&normalized_source));
    let entry = repository.insert_log(level, &normalized_source, message, metadata, category)?;

    if let Some(registry) = registry {
        broadcast_to_subscribed(registry, "logs", LOG_ENTRY, Some(to_value(&entry)));
    }
    Ok(entry)
}

/// Client-submitted event path used by `POST /api/logs/ingest`.
pub fn log_from_system_event(
    repository: &LogRepository,
    registry: Option<&Arc<ClientRegistry>>,
    event_type: &str,
    message: &str,
) -> Result<LogEntry, crate::logging::repository::LogRepositoryError> {
    let level = resolve_level(event_type, message);
    log(repository, registry, level, event_type, message, None, None)
}

fn to_value(entry: &LogEntry) -> Value {
    serde_json::to_value(entry).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_categories_like_typescript() {
        assert_eq!(resolve_category("AUTH"), LogCategory::Security);
        assert_eq!(resolve_category("chan"), LogCategory::Channel);
        assert_eq!(resolve_category("TOOL"), LogCategory::Tooling);
        assert_eq!(resolve_category("MEM"), LogCategory::Memory);
        assert_eq!(resolve_category("TASK"), LogCategory::Worker);
        assert_eq!(resolve_category("BRIDGE"), LogCategory::Integration);
        assert_eq!(resolve_category("GATEWAY"), LogCategory::System);
        assert_eq!(resolve_category("UNKNOWN"), LogCategory::System);
    }

    #[test]
    fn resolves_levels_with_message_escalation() {
        assert_eq!(resolve_level("AUTH", "signed in"), LogLevel::Info);
        assert_eq!(resolve_level("AUTH", "login failed"), LogLevel::Error);
        assert_eq!(resolve_level("SYS", "connection error"), LogLevel::Error);
        assert_eq!(resolve_level("SYS", "connection LOST"), LogLevel::Error);
        assert_eq!(resolve_level("SYS", "queue warning"), LogLevel::Warn);
        assert_eq!(resolve_level("SYS", "latency spike"), LogLevel::Warn);
        assert_eq!(resolve_level("SYS", "request timeout"), LogLevel::Warn);
        assert_eq!(resolve_level("WHATEVER", "nothing special"), LogLevel::Info);
    }

    #[test]
    fn persists_and_broadcasts() {
        let repository = LogRepository::open(":memory:").unwrap();
        let registry = Arc::new(crate::gateway::registry::ClientRegistry::new());
        let (tx, mut rx) = tokio::sync::mpsc::channel(4);
        registry.register(crate::gateway::client::ClientHandle::new(
            "c0", "u1", "v2", 0, tx,
        ));
        registry.get("c0").unwrap().add_subscription("logs");

        let entry =
            log_from_system_event(&repository, Some(&registry), "AUTH", "session failed").unwrap();
        assert_eq!(entry.level, LogLevel::Error);
        assert_eq!(entry.category, LogCategory::Security);

        let message = rx.try_recv().expect("expected a broadcast frame");
        match message {
            crate::gateway::client::Outbound::Text(text) => {
                let frame = crate::gateway::protocol::parse_frame(&text).unwrap();
                match frame {
                    crate::gateway::protocol::GatewayFrame::Event(event) => {
                        assert_eq!(event.event, LOG_ENTRY);
                        assert_eq!(event.seq, Some(1));
                    }
                    other => panic!("unexpected frame {other:?}"),
                }
            }
            other => panic!("unexpected outbound {other:?}"),
        }
    }
}
