//! Port of `src/server/master/execution/runtime/`.
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`types`] | `runtime/types.ts:1-71` |
//! | [`json_parsing`] | `runtime/jsonParsing.ts:1-23` |
//! | [`tool_context`] | `runtime/toolContext.ts:1-18` |
//! | [`capability_control`] | `runtime/capabilityControl.ts:1-31` |
//! | [`capability_output`] | `runtime/capabilityOutput.ts:1-32` |
//! | [`execution_plan`] | `runtime/executionPlan.ts:1-139` |
//! | [`code_generation`] | `runtime/codeGeneration.ts:1-86` |
//! | [`capability_executor`] | `runtime/capabilityExecutor.ts:1-217` |
//! | [`execution_flow`] | `runtime/executionFlow.ts:1-360` |
//! | [`master_execution_runtime`] | `runtime/masterExecutionRuntime.ts:1-131` |
//! | [`tool_runner`] | `runtime/toolRunner.ts:1-274` (on the S6 and S11 seams, OP-S9-4) |

pub mod capability_control;
pub mod capability_executor;
pub mod capability_output;
pub mod code_generation;
pub mod execution_flow;
pub mod execution_plan;
pub mod json_parsing;
pub mod master_execution_runtime;
pub mod tool_context;
pub mod tool_runner;
pub mod types;
