//! Port of `src/server/knowledge/ingestion/` (the ingestion pipeline of S7).
//!
//! One module per TypeScript file. The four files that depend on the World
//! Model (`messageProcessor`, `service`, `factExtractor`, `taskCompletion`) use
//! the ports in [`world_model_port`] and [`types`]; the S6 lane implements them.
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`constants`] | `ingestion/constants.ts` |
//! | [`emotion_tracker`] | `ingestion/emotionTracker.ts` |
//! | [`quality_checks`] | `ingestion/qualityChecks.ts` |
//! | [`episode_extractor`] | `ingestion/episodeExtractor.ts` |
//! | [`event_extractor`] | `ingestion/eventExtractor.ts` |
//! | [`entity_extractor`] | `ingestion/entityExtractor.ts` |
//! | [`fact_extractor`] | `ingestion/factExtractor.ts` (World Model: [`world_model_port`]) |
//! | [`task_completion`] | `ingestion/taskCompletion.ts` (World Model: [`world_model_port`]) |
//! | [`message_processor`] | `ingestion/messageProcessor.ts` (World Model: [`world_model_port`]) |
//! | [`service`] | `ingestion/service.ts` (World Model: [`world_model_port`]) |
//! | [`types`] | `ingestion/types.ts` |
//! | [`world_model_port`] | the S6 surface of the four files above (Rust-only seam) |
//! | [`test_support`] | Rust-only test doubles |

pub mod constants;
pub mod emotion_tracker;
pub mod entity_extractor;
pub mod episode_extractor;
pub mod event_extractor;
pub mod fact_extractor;
pub mod message_processor;
pub mod quality_checks;
pub mod service;
pub mod task_completion;
pub mod types;
pub mod world_model_adapter;
pub mod world_model_port;

#[cfg(test)]
pub mod test_support;
