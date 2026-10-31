//! Port of `src/server/world-model/worldModel.ts:1-263` — the public entry point
//! of the World Model slice.
//!
//! The TypeScript file is a pure re-export barrel: it has no behaviour and no
//! `createWorldModel` factory (an earlier note in [`crate::world_model`] claimed
//! one; the grep is empty). It flattens the slice's public surface into a single
//! module so callers write `import { … } from '@/server/world-model/worldModel'`.
//!
//! # Why this is not a one-to-one `pub use` list
//!
//! Rust cannot re-export ~180 TS names mechanically for two reasons:
//!
//! 1. **The slice is not fully ported yet.** Several barrel sources have no Rust
//!    module (`services/embeddingWorker`, `services/proactiveChannelDelivery`,
//!    `services/projectionRetryWorker` and the `retrieval` index). A `pub use` of
//!    a non-existent path does not compile.
//! 2. **Some names live in a module that the port keeps separate.** The
//!    TypeScript flattens them, the Rust keeps one module per file (the crate
//!    convention). Flattening them here would re-create the very ambiguity the
//!    module layout avoids (e.g. `recordObservation` is defined in the
//!    observation service and re-exported by the event service).
//!
//! The port therefore re-exports the pieces the barrel exposes via `export *`
//! (`config`, `mode`, `types`) plus the scope, lifecycle, policy and metric
//! vocabulary under their source names. The remaining names of
//! `worldModel.ts` stay reachable at their module paths and are listed below as
//! the porting backlog.
//!
//! # Deferred barrel groups (not in this file yet)
//!
//! `db`, `repositories/*`, `services/*` (event/observation/assertion/action/
//! canonical-task/prospective/open-loop/standing-intent/correction/entity),
//! `projector/*`, `retrieval/*`, `embeddings/*`, `graphiti/*`, `outboxDispatcher`,
//! `bridge`, `runtime/*`, `consolidation/*`. Each is available as
//! `crate::world_model::<module>`.

// `export * from '@/server/world-model/config'` (`worldModel.ts:6`).
pub use crate::world_model::config::*;
// `export * from '@/server/world-model/mode'` (`worldModel.ts:7`).
pub use crate::world_model::mode::*;
// `export * from '@/server/world-model/types'` (`worldModel.ts:8`).
pub use crate::world_model::types::*;
// `export { scopeWhere, scopeKey, sameScope, scopeParts }` and
// `export type { WorldModelScope }` (`worldModel.ts:60-61`).
pub use crate::world_model::scope::{
    same_scope, scope_key, scope_parts, scope_where, ScopeParts, WorldModelScope,
};
// `export { buildScopeWhere, retentionCutoffDays, exportWorldModelScope,
// hashWorldModelExport, restoreWorldModelScope, deleteWorldModelScope,
// purgeWorldModelRetention }` (`worldModel.ts:77-85`).
pub use crate::world_model::data_lifecycle::{
    build_scope_where, delete_world_model_scope, export_world_model_scope, hash_world_model_export,
    purge_world_model_retention, restore_world_model_scope, retention_cutoff_days,
};
// `export { isMem0PrimaryMemory, … }` (`worldModel.ts:152-158`).
pub use crate::world_model::mem0_policy::*;
