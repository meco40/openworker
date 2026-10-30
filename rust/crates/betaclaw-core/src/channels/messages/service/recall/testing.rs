//! Test doubles for the recall ports, and fixture builders. Compiled for tests only.

use std::sync::Mutex;

use crate::memory::service::{MemoryStoreInput, RecallRequest};
use crate::memory::types::{
    MemoryFeedbackSignal, MemoryNode, MemoryProviderKind, MemoryRecallMatch, MemoryRecallResult,
    MemoryType,
};
use crate::messages_store::{
    Conversation, MessageRepositoryError, SearchMessagesOptions, StoredMessage,
};
use crate::world_model::retrieval::index::{
    RetrievalContextResult, RetrievalSource, RetrieveContextInput,
};

use super::ports::{
    KnowledgeRetrieveInput, RecallChatSearch, RecallKnowledge, RecallMemory, RecallSourceError,
    RecallWorldModel,
};
use super::service_types::RecallSettings;
use super::types::{CandidateSource, StrictRecallCandidate};
use super::utils::normalize_for_match;

const NO_MEMORY: &str = "No relevant memories found.";

/// A chat-sourced candidate with zero hits and score. Tests set what they need.
pub fn candidate(text: &str, created_at: Option<&str>) -> StrictRecallCandidate {
    StrictRecallCandidate {
        source: CandidateSource::Chat,
        role: "user".to_string(),
        text: text.to_string(),
        created_at: created_at.map(str::to_string),
        normalized: normalize_for_match(text),
        topic_hits: 0,
        time_hits: 0,
        score: 0.0,
    }
}

/// A conversation with the fixed id `conv-1` and user `user-1`.
pub fn conversation(channel: &str, persona_id: Option<&str>) -> Conversation {
    Conversation {
        id: "conv-1".to_string(),
        channel_type: channel.to_string(),
        external_chat_id: None,
        user_id: "user-1".to_string(),
        workspace_id: None,
        title: "Chat".to_string(),
        model_override: None,
        persona_id: persona_id.map(str::to_string),
        created_at: "2026-10-01T00:00:00.000Z".to_string(),
        updated_at: "2026-10-01T00:00:00.000Z".to_string(),
    }
}

pub fn stored(id: &str, role: &str, content: &str, created_at: &str) -> StoredMessage {
    StoredMessage {
        id: id.to_string(),
        conversation_id: "conv-1".to_string(),
        seq: None,
        role: role.to_string(),
        content: content.to_string(),
        platform: "WebChat".to_string(),
        external_msg_id: None,
        sender_name: None,
        metadata: None,
        created_at: created_at.to_string(),
    }
}

pub fn settings() -> RecallSettings {
    RecallSettings {
        knowledge_layer_enabled: false,
        knowledge_retrieval_enabled: false,
        knowledge_pre_ingest_on_recall: false,
        world_model_canonical: false,
        memory_provider: MemoryProviderKind::Mem0,
        mem0_preferences_only: false,
        mem0_factual_write_blocked: false,
        strict_evidence_enabled: false,
        slow_threshold_ms: 1500,
    }
}

pub fn memory_match(id: &str, content: &str, timestamp: &str) -> MemoryRecallMatch {
    MemoryRecallMatch {
        node: MemoryNode {
            id: id.to_string(),
            node_type: MemoryType::Fact,
            content: content.to_string(),
            embedding: Vec::new(),
            importance: 3.0,
            confidence: 0.5,
            timestamp: timestamp.to_string(),
            metadata: None,
        },
        similarity: 0.9,
        score: 0.9,
    }
}

pub fn memory_result(context: &str, matches: Vec<MemoryRecallMatch>) -> MemoryRecallResult {
    MemoryRecallResult {
        context: context.to_string(),
        matches,
    }
}

pub fn no_memory() -> MemoryRecallResult {
    memory_result(NO_MEMORY, Vec::new())
}

fn empty_world_model() -> RetrievalContextResult {
    RetrievalContextResult {
        structured: Vec::new(),
        full_text: Vec::new(),
        vector: Vec::new(),
        source: RetrievalSource::None,
        enabled: true,
        assertions: None,
        tasks: None,
        relations: None,
        open_loops: None,
        graphiti: None,
    }
}

/// Answers every call with a fixed result and counts the calls.
pub struct FakeWorldModel {
    pub result: Result<RetrievalContextResult, RecallSourceError>,
    pub calls: Mutex<usize>,
}

impl FakeWorldModel {
    pub fn empty() -> Self {
        Self {
            result: Ok(empty_world_model()),
            calls: Mutex::new(0),
        }
    }

    pub fn failing(message: &str) -> Self {
        Self {
            result: Err(RecallSourceError(message.to_string())),
            calls: Mutex::new(0),
        }
    }
}

impl RecallWorldModel for FakeWorldModel {
    async fn retrieve_context(
        &self,
        _input: &RetrieveContextInput,
    ) -> Result<RetrievalContextResult, RecallSourceError> {
        *self.calls.lock().unwrap() += 1;
        self.result.clone()
    }
}

/// Records the pre-ingest calls and answers retrieval with a fixed context.
pub struct FakeKnowledge {
    pub retrieve_result: Result<String, RecallSourceError>,
    pub ingested_users: Mutex<Vec<String>>,
}

impl FakeKnowledge {
    pub fn with_context(context: &str) -> Self {
        Self {
            retrieve_result: Ok(context.to_string()),
            ingested_users: Mutex::new(Vec::new()),
        }
    }
}

impl RecallKnowledge for FakeKnowledge {
    async fn ensure_ingested(
        &self,
        _conversation_id: &str,
        user_id: &str,
        _persona_id: &str,
    ) -> Result<(), RecallSourceError> {
        self.ingested_users
            .lock()
            .unwrap()
            .push(user_id.to_string());
        Ok(())
    }

    async fn retrieve(
        &self,
        _input: &KnowledgeRetrieveInput<'_>,
    ) -> Result<String, RecallSourceError> {
        self.retrieve_result.clone()
    }
}

/// (persona id, node ids, signal, user id) of one feedback call.
pub type FeedbackRecord = (String, Vec<String>, MemoryFeedbackSignal, String);

/// Records recall requests, stored facts and feedback, and answers recall with
/// a fixed result.
pub struct FakeMemory {
    pub recall_result: Result<MemoryRecallResult, RecallSourceError>,
    pub requests: Mutex<Vec<RecallRequest>>,
    pub stored: Mutex<Vec<MemoryStoreInput>>,
    pub feedback: Mutex<Vec<FeedbackRecord>>,
}

impl FakeMemory {
    pub fn answering(result: Result<MemoryRecallResult, RecallSourceError>) -> Self {
        Self {
            recall_result: result,
            requests: Mutex::new(Vec::new()),
            stored: Mutex::new(Vec::new()),
            feedback: Mutex::new(Vec::new()),
        }
    }
}

impl RecallMemory for FakeMemory {
    async fn recall_detailed(
        &self,
        _persona_id: &str,
        _query: &str,
        _limit: i64,
        _user_id: &str,
        options: &RecallRequest,
    ) -> Result<MemoryRecallResult, RecallSourceError> {
        self.requests.lock().unwrap().push(options.clone());
        self.recall_result.clone()
    }

    async fn register_feedback(
        &self,
        persona_id: &str,
        node_ids: &[String],
        signal: MemoryFeedbackSignal,
        user_id: &str,
    ) -> Result<(), RecallSourceError> {
        self.feedback.lock().unwrap().push((
            persona_id.to_string(),
            node_ids.to_vec(),
            signal,
            user_id.to_string(),
        ));
        Ok(())
    }

    async fn store_memory(&self, input: &MemoryStoreInput) -> Result<(), RecallSourceError> {
        self.stored.lock().unwrap().push(input.clone());
        Ok(())
    }
}

/// Answers every search with the same hits and records the queries.
pub struct FakeChat {
    pub hits: Result<Vec<StoredMessage>, MessageRepositoryError>,
    pub queries: Mutex<Vec<String>>,
}

impl FakeChat {
    pub fn returning(hits: Vec<StoredMessage>) -> Self {
        Self {
            hits: Ok(hits),
            queries: Mutex::new(Vec::new()),
        }
    }

    pub fn failing() -> Self {
        Self {
            hits: Err(MessageRepositoryError::Validation("fts down")),
            queries: Mutex::new(Vec::new()),
        }
    }
}

impl RecallChatSearch for FakeChat {
    fn search_messages(
        &self,
        query: &str,
        _options: &SearchMessagesOptions<'_>,
    ) -> Result<Vec<StoredMessage>, MessageRepositoryError> {
        self.queries.lock().unwrap().push(query.to_string());
        match &self.hits {
            Ok(hits) => Ok(hits.clone()),
            Err(_) => Err(MessageRepositoryError::Validation("fts down")),
        }
    }
}
