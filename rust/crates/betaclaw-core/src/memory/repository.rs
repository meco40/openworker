//! The provider-neutral repository contract of the memory store.
//!
//! Port of `src/server/memory/repository.ts` and the storage-facing value
//! objects of the same file. The trait used to live next to its first
//! implementation in [`super::sqlite`]; it is the contract every provider
//! implements, so it belongs beside the types, not inside the SQLite module
//! (open point OP-15).
//!
//! | TypeScript                                       | Rust |
//! | ------------------------------------------------ | ---- |
//! | `repository.ts:15-34` (`MemoryRepository`)        | [`MemoryRepository`] |
//! | `repository.ts:26-31` (`updateMany` update object)| [`MemoryNodeUpdates`] |
//!
//! # Shape
//!
//! The trait is re-exported verbatim from `sqlite/repository.rs`, where it was
//! first defined, so the public shape does not change. The Rust trait
//! additionally carries the three class-only reads the provider client calls
//! ([`MemoryRepository::list_all_nodes_with_scope`],
//! [`MemoryRepository::get_node_by_id`], [`MemoryRepository::list_node_history`]);
//! the TypeScript interface omits them because the client holds the concrete
//! class rather than the interface.

use crate::memory::errors::MemoryError;
use crate::memory::types::{
    MemoryListPageInput, MemoryListPageResult, MemoryNode, MemoryNodeHistoryRow,
    MemoryNodeWithScope, MemoryType,
};

/// `MemoryRepository` from `src/server/memory/repository.ts:15-34`.
pub trait MemoryRepository {
    /// `listNodes` — `repository.ts:16`, `sqliteMemoryRepository.ts:132-140`.
    fn list_nodes(
        &self,
        persona_id: &str,
        user_id: Option<&str>,
    ) -> Result<Vec<MemoryNode>, MemoryError>;

    /// `listNodesPage` — `repository.ts:17-21`, `sqliteMemoryRepository.ts:142-185`.
    fn list_nodes_page(
        &self,
        persona_id: &str,
        input: &MemoryListPageInput,
        user_id: Option<&str>,
    ) -> Result<MemoryListPageResult, MemoryError>;

    /// `listAllNodes` — `repository.ts:22`, `sqliteMemoryRepository.ts:187-189`.
    fn list_all_nodes(&self, user_id: Option<&str>) -> Result<Vec<MemoryNode>, MemoryError>;

    /// `insertNode` — `repository.ts:23`, `sqliteMemoryRepository.ts:212-238`.
    fn insert_node(
        &self,
        persona_id: &str,
        node: &MemoryNode,
        user_id: Option<&str>,
    ) -> Result<(), MemoryError>;

    /// `updateNode` — `repository.ts:24`, `sqliteMemoryRepository.ts:240-267`.
    fn update_node(
        &self,
        persona_id: &str,
        node: &MemoryNode,
        user_id: Option<&str>,
    ) -> Result<(), MemoryError>;

    /// `deleteNode` — `repository.ts:25`, `sqliteMemoryRepository.ts:312-318`.
    fn delete_node(
        &self,
        persona_id: &str,
        node_id: &str,
        user_id: Option<&str>,
    ) -> Result<i64, MemoryError>;

    /// `updateMany` — `repository.ts:26-31`, `sqliteMemoryRepository.ts:320-359`.
    fn update_many(
        &self,
        persona_id: &str,
        node_ids: &[String],
        updates: &MemoryNodeUpdates,
        user_id: Option<&str>,
    ) -> Result<i64, MemoryError>;

    /// `deleteMany` — `repository.ts:32`, `sqliteMemoryRepository.ts:361-377`.
    fn delete_many(
        &self,
        persona_id: &str,
        node_ids: &[String],
        user_id: Option<&str>,
    ) -> Result<i64, MemoryError>;

    /// `deleteByPersona` — `repository.ts:33`, `sqliteMemoryRepository.ts:379-385`.
    fn delete_by_persona(
        &self,
        persona_id: &str,
        user_id: Option<&str>,
    ) -> Result<i64, MemoryError>;

    /// `listAllNodesWithScope` — `sqliteMemoryRepository.ts:191-210`.
    fn list_all_nodes_with_scope(
        &self,
        user_id: Option<&str>,
    ) -> Result<Vec<MemoryNodeWithScope>, MemoryError>;

    /// `getNodeById` — `sqliteMemoryRepository.ts:269-279`.
    fn get_node_by_id(&self, node_id: &str) -> Result<Option<MemoryNodeWithScope>, MemoryError>;

    /// `listNodeHistory` — `sqliteMemoryRepository.ts:281-301`.
    fn list_node_history(&self, node_id: &str) -> Result<Vec<MemoryNodeHistoryRow>, MemoryError>;
}

/// The inline update object of `updateMany` — `repository.ts:26-31`.
///
/// `{ type?: MemoryType; importance?: number }`: both keys are optional, and an
/// absent key means "leave that column alone".
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct MemoryNodeUpdates {
    pub node_type: Option<MemoryType>,
    pub importance: Option<f64>,
}
