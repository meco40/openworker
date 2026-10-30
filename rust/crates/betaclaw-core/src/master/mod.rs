//! Slice S9 (Master).
//!
//! Port of `src/server/master/` (75 TypeScript files, ~7.2k lines). The
//! directory layout mirrors the TypeScript tree so a reviewer can diff one Rust
//! file against its TypeScript original:
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`types`] | `shared/masterTypes.ts` + `types.ts` |
//! | [`http`] | `http.ts` |
//! | [`feature_flags`] | `featureFlags.ts` |
//! | [`migrations`] | `migrations.ts` |
//! | [`repository`] | `repository.ts`, `repository/helpers.ts`, `repository/mappers.ts` (and the `*.store.ts` files as they land) |
//! | [`lifecycle`] | `lifecycle.ts` |
//! | [`safety`] | `safety.ts` |
//! | [`verification`] | `verification.ts` |
//! | [`live_events`] | `liveEvents.ts` (+ `MasterInvalidationResource` from `shared/eventsTypes.ts`) |
//! | [`notes`] | `notes.ts` |
//! | [`orchestrator`] | `orchestrator.ts` |
//! | [`runtime`] | `runtime.ts` |
//! | [`learning`] | `learning.ts` |
//! | [`system_persona`] | `systemPersona.ts` |
//! | [`runtime_persona`] | `runtimePersona.ts` |
//! | [`metrics`] | `metrics.ts` |
//! | [`system_ops`] | `systemOps.ts` |
//! | [`reminders`] | `reminders.ts` |
//! | [`workspace_scope`] | `workspaceScope.ts` |
//! | [`approvals`] | `approvals/service.ts` |
//! | [`delegation`] | `delegation/*.ts` |
//! | [`execution`] | `execution/*.ts` + `execution/runtime/*.ts` |
//! | [`capabilities`] | `capabilities/*.ts` |
//! | [`connectors`] | `connectors/**` |
//! | [`cron_bridge`] | `cronBridge.ts` (S10 seam [`cron_bridge::AutomationRuntimePort`]) |
//! | [`action_bridge`] | `world-model/services/masterActionBridge.ts` (S6 seam [`action_bridge::MasterActionBridge`]) |
//! | [`toolforge`] | `toolforge/*.ts` (without the sandbox body) |
//! | [`tool_policy`] | `toolPolicy/service.ts` |
//!
//! # Cross-package seams opened by this lane
//!
//! Three P2 modules consume packages that have not landed yet. Instead of
//! stubbing or duplicating them, each one is an explicit trait whose
//! implementation belongs to the owning package: [`learning`] holds
//! `CapabilityUnderstandingCycle` (P5, `capabilities/understandingLoop.ts`) and
//! [`live_events`] holds `MasterEventPublisher` (the process-wide event bus of
//! S13), both defaulting to a logging no-op exactly like the S5 port of
//! `memory/lifecycle.ts`. [`orchestrator`] declares the `DelegationDispatcherPort`
//! and `ActionLedgerPort` seams (OP-S9-7), implemented by [`delegation::dispatcher`]
//! and [`execution::action_ledger`] respectively.
//!
//! # Cross-package seams opened by this lane (continued)
//!
//! The P4 execution runtime adds four more seams rather than importing or
//! stubbing packages that have not landed:
//!
//! * `execution::runtime::execution_plan::MasterModelDispatch` — the model-hub
//!   dispatch entry (OP-S9-8);
//! * `execution::runtime::capability_executor::MasterToolRunner` — `runTool` from
//!   the excluded `toolRunner.ts` (OP-S9-4/OP-S9-14);
//! * `execution::approval_policy::ToolPolicyResolver` — `resolveToolPolicy` of
//!   P5 `toolPolicy/service.ts` (OP-S9-13);
//! * `delegation::subagent_pool::SubagentHeartbeatScheduler` and
//!   `execution::runtime::master_execution_runtime::RuntimeLeaseHeartbeat` — the
//!   two process-wide timers (OP-S9-11/OP-S9-15).
//!
//! Package P5 (capabilities / connectors / toolforge / tool policy) closes three
//! of those seams and opens two of its own:
//!
//! * `execution::approval_policy::ToolPolicyResolver` is implemented by
//!   `tool_policy::service::ToolPolicyServiceResolver` (OP-S9-13);
//! * `learning::CapabilityUnderstandingCycle` is implemented by
//!   `capabilities::understanding_loop::UnderstandingLoop` (OP-S9-6), which adds
//!   the `capabilities::understanding_loop::CapabilityRuntimePersona` seam for the
//!   runtime-persona resolution it cannot otherwise reach (OP-S9-16);
//! * `toolforge::sandbox_runner::ToolForgeSandboxRunner` is the S11 sandbox seam
//!   (OP-S9-2); the sandbox body itself is not ported.
//!
//! `connectors::secret_store` takes the S4 crypto primitives (`aes_gcm`, the
//! CSPRNG and the base64url encoder) and `connectors::gmail::client` takes the S4
//! `HttpTransport` (OP-16), so neither adds a second crypto or HTTP path. The
//! Node-lenient key decoding, the process-wide Gmail mock mailbox and the
//! fail-closed gate adapter are OP-S9-18/OP-S9-19/OP-S9-20.
//!
//! The measured import check of `.tmp/s8s9s10-plan.md` §4.3 is corrected here:
//! `delegation/**` imports only `@/server/master/**`, so there is **no** S8
//! subagent-runtime seam in this package.
//!
//! # Ownership
//!
//! This module root is owned by the S9 lane. Sub-module declarations are added
//! as the packages land; nothing is declared here before its file exists, so the
//! crate keeps compiling between packages.
//!
//! # Seams to packages not yet ported
//!
//! The S6, S10 and S11 calls of the Master consumers are declared as traits and
//! implemented by their owning packages: [`action_bridge::MasterActionBridge`]
//! (`bridgeMasterAction`, S6), [`cron_bridge::AutomationRuntimePort`]
//! (`automation/runtime`, S10, OP-S9-3) and
//! `execution::runtime::tool_runner::SkillDispatcher` (`dispatchSkill`, S11).
//! `connectors::gmail::actions` and `execution::runtime::tool_runner` are ported
//! on top of these seams. This crate provides no implementation of them, and the
//! route `app/api/master/gmail/route.ts` is outside `master/**` and not ported
//! (OP-S9-4). See OP-S9-3, OP-S9-4 and OP-S9-14.

pub mod action_bridge;
pub mod approvals;
pub mod capabilities;
pub mod connectors;
pub mod cron_bridge;
pub mod delegation;
pub mod execution;
pub mod feature_flags;
pub mod http;
pub mod learning;
pub mod lifecycle;
pub mod live_events;
pub mod metrics;
pub mod migrations;
pub mod notes;
pub mod orchestrator;
pub mod reminders;
pub mod repository;
pub mod runtime;
pub mod runtime_persona;
pub mod safety;
pub mod system_ops;
pub mod system_persona;
pub mod tool_policy;
pub mod toolforge;
pub mod types;
pub mod verification;
pub mod workspace_scope;
