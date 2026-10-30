//! Port of `src/server/channels/messages/service/commands/memoryCommand.ts` (S8).
//!
//! TypeScript exports `handleMemorySave` from both `commands/memoryCommand.ts` and
//! `handlers/memoryHandler.ts`. Only the handler is on the dispatch path
//! (`inbound/stages/prepareDispatchStage.ts`), and the command export is a re-export without
//! callers. The Rust side keeps one implementation, the handler, and re-exports it here under the
//! command path. Its store port is [`MemoryWritePort`](crate::channels::messages::service::handlers::memory_handler::MemoryWritePort).

pub use crate::channels::messages::service::handlers::memory_handler::handle_memory_save;
