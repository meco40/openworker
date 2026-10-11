//! Slice S9 (Master).
//!
//! Port of `src/server/master/` (75 TypeScript files, ~7.8k lines). The
//! directory layout mirrors the TypeScript tree so a reviewer can diff one Rust
//! file against its TypeScript original:
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | `types` | `types.ts` |
//! | `http` | `http.ts` |
//! | `feature_flags` | `featureFlags.ts` |
//! | `repositories` | `repository/*.store.ts` |
//!
//! # Ownership
//!
//! This module root is owned by the S9 lane. Sub-module declarations are added
//! as the packages land; nothing is declared here before its file exists, so the
//! crate keeps compiling between packages.
//!
//! # Deliberately excluded from lane C
//!
//! `cronBridge.ts` (reads `automation/runtime`, S10) and the three
//! `masterActionBridge` consumers (`connectors/gmail/actions.ts`,
//! `execution/runtime/toolRunner.ts`, `app/api/master/gmail/route.ts`) are S9
//! but depend on S6/S10 and are therefore held back — see `.tmp/s8s9s10-plan.md`
//! §6.1 and OP-S9-3/OP-S9-4.

// Sub-modules are declared by the S9 lane as their files land.
