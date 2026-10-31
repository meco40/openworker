//! Port of `src/server/channels/messages/service/recall/search/index.ts`.

pub mod knowledge;
pub mod messages;
pub mod strict;

pub use knowledge::{recall_from_knowledge, KnowledgeRecallOptions};
pub use messages::recall_from_chat;
pub use strict::{
    build_chat_candidates, build_memory_candidates, perform_strict_search,
    recall_from_memory_detailed, StrictSearchResult,
};
