//! Conversation summaries, session memory and knowledge ingestion: the `SummaryPort`.
//!
//! Port of `src/server/channels/messages/summary.ts` (fallback text and the AI-mode switch),
//! `summaryService.ts` (the refresh is scheduled on the service) and the flags of
//! `autoMemory.ts` and the knowledge config. Storing memories and ingesting the knowledge
//! window need the memory and knowledge stores, which are not wired.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, Weak};

use betaclaw_core::channels::messages::service::execution::ports::PortResult;
use betaclaw_core::channels::messages::service::ports::{
    AutoMemoryCandidate, BoxFuture, ConversationWindowInput, KnowledgeLayerFlags, StoreMemoryInput,
    SummaryPort,
};
use betaclaw_core::channels::messages::service::summary_service::SummaryService;
use betaclaw_core::knowledge::config::resolve_knowledge_config;
use betaclaw_core::knowledge::inline_ingestion_policy::is_inline_knowledge_ingestion_enabled;
use betaclaw_core::memory::service::{resolve_memory_scoped_user_id, MemoryScopeInput};
use betaclaw_core::messages_store::types::{Conversation, StoredMessage};
use serde_json::Value;

use super::{not_wired, BuildError};

/// `summary.ts`: the fallback text keeps at most this many characters of the new chunk.
const FALLBACK_CHUNK_LIMIT: usize = 2500;
/// `summary.ts` and `summaryService.ts`: the stored summary keeps its last characters.
const SUMMARY_LIMIT: usize = 5000;

pub struct SummaryAdapter {
    ai_summary_enabled: bool,
    /// `getAutoSessionMemoryMode()`. `heuristic` is refused at start-up, so this is `off`.
    auto_memory_mode: &'static str,
    inline_ingestion: bool,
    knowledge: KnowledgeLayerFlags,
    /// Set once the summary service exists. A weak handle, because the service owns this port.
    service: OnceLock<Weak<SummaryService>>,
}

impl SummaryAdapter {
    /// Reads the flags from the environment at start-up.
    pub fn from_env(env: &HashMap<String, String>) -> Result<Self, BuildError> {
        let auto_memory_mode = auto_memory_mode(env);
        if auto_memory_mode == "heuristic" {
            return Err(BuildError::Unported(
                "CHAT_AUTO_SESSION_MEMORY=heuristic (autoMemory.ts candidates are not ported)",
            ));
        }
        let knowledge = resolve_knowledge_config(env);
        Ok(Self {
            ai_summary_enabled: is_ai_summary_enabled(env),
            auto_memory_mode: "off",
            inline_ingestion: is_inline_knowledge_ingestion_enabled(env),
            knowledge: KnowledgeLayerFlags {
                layer_enabled: knowledge.layer_enabled,
                episode_enabled: knowledge.episode_enabled,
                ledger_enabled: knowledge.ledger_enabled,
            },
            service: OnceLock::new(),
        })
    }

    /// Connects the summary service that owns this port. Called once, after construction.
    pub fn bind(&self, service: &Arc<SummaryService>) {
        // The first bind wins. A second bind is a start-up mistake and is ignored.
        let _ = self.service.set(Arc::downgrade(service));
    }

    fn bound_service(&self) -> Option<Arc<SummaryService>> {
        self.service.get().and_then(Weak::upgrade)
    }
}

/// `isAiSummaryEnabled` (`summary.ts:16-19`): every mode except `fallback` and `concat`.
fn is_ai_summary_enabled(env: &HashMap<String, String>) -> bool {
    let mode = env
        .get("CHAT_SUMMARY_MODE")
        .map(|value| value.to_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "ai".to_string());
    mode != "fallback" && mode != "concat"
}

/// `getAutoSessionMemoryMode` (`autoMemory.ts:119-130`).
fn auto_memory_mode(env: &HashMap<String, String>) -> &'static str {
    let mode = env
        .get("CHAT_AUTO_SESSION_MEMORY")
        .map(|value| value.trim().to_lowercase())
        .unwrap_or_default();
    match mode.as_str() {
        "" | "off" | "false" | "0" | "no" => "off",
        _ => "heuristic",
    }
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The last `count` characters. TypeScript counts UTF-16 units, so the two differ only
/// for characters outside the basic plane.
fn last_chars(text: &str, count: usize) -> String {
    let total = text.chars().count();
    text.chars().skip(total.saturating_sub(count)).collect()
}

/// `buildFallbackSummary` (`summary.ts:3-14`).
fn fallback_summary(previous: &str, messages: &[(String, String)]) -> String {
    let chunk: String = messages
        .iter()
        .map(|(role, content)| format!("[{role}] {}", collapse_whitespace(content)))
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(FALLBACK_CHUNK_LIMIT)
        .collect();
    if chunk.is_empty() {
        return last_chars(previous, SUMMARY_LIMIT);
    }
    if previous.is_empty() {
        return chunk;
    }
    last_chars(&format!("{previous}\n{chunk}"), SUMMARY_LIMIT)
}

impl SummaryPort for SummaryAdapter {
    fn is_ai_summary_enabled(&self) -> bool {
        self.ai_summary_enabled
    }

    fn build_fallback_summary(&self, previous: &str, messages: &[(String, String)]) -> String {
        fallback_summary(previous, messages)
    }

    fn is_auto_session_memory_enabled(&self) -> bool {
        self.auto_memory_mode != "off"
    }

    fn auto_session_memory_mode(&self) -> String {
        self.auto_memory_mode.to_string()
    }

    fn build_auto_memory_candidates(
        &self,
        _messages: &[StoredMessage],
    ) -> Vec<AutoMemoryCandidate> {
        // ponytail: candidates are only built when auto session memory is on, and `from_env`
        // refuses that mode. Nothing reaches this method yet.
        Vec::new()
    }

    fn resolve_memory_user_id(&self, conversation: &Conversation) -> String {
        resolve_memory_scoped_user_id(MemoryScopeInput {
            user_id: Some(&conversation.user_id),
            channel_type: Some(&conversation.channel_type),
            external_chat_id: conversation.external_chat_id.as_deref(),
        })
    }

    fn store_memory(&self, _input: StoreMemoryInput) -> BoxFuture<'_, PortResult<()>> {
        Box::pin(std::future::ready(Err(not_wired(
            "SummaryPort",
            "store_memory",
        ))))
    }

    fn is_inline_knowledge_ingestion_enabled(&self) -> bool {
        self.inline_ingestion
    }

    fn knowledge_layer_flags(&self) -> KnowledgeLayerFlags {
        self.knowledge
    }

    fn ingest_conversation_window(
        &self,
        _input: ConversationWindowInput,
    ) -> BoxFuture<'_, PortResult<()>> {
        Box::pin(std::future::ready(Err(not_wired(
            "SummaryPort",
            "ingest_conversation_window",
        ))))
    }

    fn trace_auto_session_memory(&self, name: &str, fields: Value) {
        tracing::debug!(trace = %name, fields = %fields, "auto session memory");
    }

    fn clear_in_flight(&self, conversation_id: &str) {
        if let Some(service) = self.bound_service() {
            service.clear_in_flight(conversation_id);
        }
    }

    fn schedule_summary_refresh(&self, conversation: Conversation) {
        let Some(service) = self.bound_service() else {
            return;
        };
        // summaryService.ts: the refresh is started and not awaited by its callers.
        tokio::spawn(async move {
            if let Err(error) = service
                .maybe_refresh_conversation_summary(&conversation)
                .await
            {
                tracing::warn!(%error, "conversation summary refresh failed");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_summary_collapses_whitespace_and_appends_to_the_previous_text() {
        let messages = vec![
            ("user".to_string(), "  hallo \n welt ".to_string()),
            ("agent".to_string(), "ja".to_string()),
        ];
        assert_eq!(
            fallback_summary("", &messages),
            "[user] hallo welt [agent] ja"
        );
        assert_eq!(
            fallback_summary("alt", &messages),
            "alt\n[user] hallo welt [agent] ja"
        );
        assert_eq!(fallback_summary("alt", &[]), "alt");
    }

    #[test]
    fn ai_summary_is_on_unless_the_mode_is_fallback_or_concat() {
        let mut env = HashMap::new();
        assert!(is_ai_summary_enabled(&env));
        env.insert("CHAT_SUMMARY_MODE".into(), "Concat".into());
        assert!(!is_ai_summary_enabled(&env));
    }

    #[test]
    fn the_heuristic_auto_memory_mode_is_refused_at_start_up() {
        let env: HashMap<String, String> = [(
            "CHAT_AUTO_SESSION_MEMORY".to_string(),
            "heuristic".to_string(),
        )]
        .into();
        assert!(matches!(
            SummaryAdapter::from_env(&env),
            Err(BuildError::Unported(_))
        ));
        let off = SummaryAdapter::from_env(&HashMap::new()).expect("defaults are off");
        assert!(!off.is_auto_session_memory_enabled());
    }
}
