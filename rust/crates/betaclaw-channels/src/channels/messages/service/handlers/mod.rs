//! Port of `src/server/channels/messages/service/handlers/` (S8).

pub mod memory_handler;
pub mod shell_inference;
pub mod web_ui_handler;

pub use memory_handler::{
    handle_memory_save, MemorySaveOutcome, MemorySaveParams, MemoryStoreRequest, MemoryWritePort,
};
pub use shell_inference::{
    handle_inferred_shell_question, ShellInferenceDeps, ShellInferenceParams,
};
pub use web_ui_handler::{
    handle_web_ui_message, InboundPort, InboundRequest, WebUiHandlerDeps, WebUiMessageParams,
    WebUiMessageResult,
};
