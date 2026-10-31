//! Port of `src/server/channels/messages/service/commands/` (S8). `index.ts` maps to the
//! re-exports below. `types` carries the shared ports and the command-facing shapes.

pub mod approval;
pub mod automation;
pub mod memory;
pub mod persona;
pub mod project;
pub mod shell;
pub mod subagent;
pub mod types;

#[cfg(test)]
pub(crate) mod fakes;

pub use approval::handle_approval_command;
pub use automation::handle_automation_command;
pub use memory::handle_memory_save;
pub use persona::handle_persona_command;
pub use project::handle_project_command;
pub use shell::handle_shell_command;
pub use subagent::handle_subagent_command;
pub use types::CommandHandlerDeps;
