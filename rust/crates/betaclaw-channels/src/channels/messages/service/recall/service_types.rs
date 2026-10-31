//! Recall settings of the chat recall service. The shared memory helpers and the
//! `LastRecallState` shape of `service/types.ts` live in
//! [`crate::channels::messages::service::types`].
//!
//! [`RecallSettings`] replaces the environment and config reads that the
//! TypeScript code performs inside recall. The caller fills it in.

use crate::memory::types::MemoryProviderKind;

/// The configuration values that the recall service reads on each request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecallSettings {
    /// `resolveKnowledgeConfig().layerEnabled`.
    pub knowledge_layer_enabled: bool,
    /// `resolveKnowledgeConfig().retrievalEnabled`.
    pub knowledge_retrieval_enabled: bool,
    /// `isKnowledgePreIngestOnRecallEnabled()`.
    pub knowledge_pre_ingest_on_recall: bool,
    /// `isWorldModelCanonical(getWorldModelConfig().mode)`.
    pub world_model_canonical: bool,
    /// `getMemoryProviderKind()`. The caller maps a failure to `Mem0`, which is
    /// what the TypeScript `catch` does.
    pub memory_provider: MemoryProviderKind,
    /// `isMem0PreferencesOnly()`.
    pub mem0_preferences_only: bool,
    /// `isMem0FactualWriteBlocked()`.
    pub mem0_factual_write_blocked: bool,
    /// `isStrictEvidenceRecallEnabled()`.
    pub strict_evidence_enabled: bool,
    /// `getChatRecallSlowThresholdMs()`, used only to escalate the trace log.
    pub slow_threshold_ms: i64,
}
