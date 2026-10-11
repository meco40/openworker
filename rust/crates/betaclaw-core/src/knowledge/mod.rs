//! Slice S7 (Knowledge).
//!
//! Port of `src/server/knowledge/` (95 TypeScript files, ~9.7k lines). The
//! directory layout mirrors the TypeScript tree so a reviewer can diff one Rust
//! file against its TypeScript original:
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | `config` | `config.ts` |
//! | `repositories` | `repositories/*.ts` |
//! | `retrieval` | `retrieval/**` |
//!
//! # Ownership
//!
//! This module root is owned by the S7 lane. Sub-module declarations are added
//! as the packages land; nothing is declared here before its file exists, so the
//! crate keeps compiling between packages.

// Sub-modules are declared by the S7 lane as their files land.
