//! Port of `src/server/master/connectors/`.
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`secret_store`] | `connectors/secretStore.ts` |
//! | [`secret_policies`] | `connectors/secretPolicies.ts` |
//! | [`gmail`] | `connectors/gmail/*.ts` |
//!
//! `gmail::actions` runs its send path on the S6
//! [`MasterActionBridge`](crate::master::action_bridge::MasterActionBridge) seam
//! (OP-S9-4).

pub mod gmail;
pub mod secret_policies;
pub mod secret_store;
