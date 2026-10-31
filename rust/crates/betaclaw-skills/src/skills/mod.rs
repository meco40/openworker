//! Port of `src/server/skills/` (S11): shell/python/process/playwright handlers and
//! the exec approval gate that guards them. Submodules name their TypeScript source.

pub mod activation;
pub mod builtin_skills;
pub mod db_query;
pub mod exec_approval;
pub mod execution_cwd;
pub mod file_read;
pub mod node_command_policy;
pub mod playwright_cli;
pub mod playwright_cli_command;
pub mod process_manager;
pub mod python_execute;
pub mod runtime_config;
pub mod shell_execute;
pub mod skill_md;
pub mod store;
pub mod types;

pub mod apply_patch_compat;
pub mod browser_snapshot;
pub mod coding_compat;
pub mod gateway_self_heal;
pub mod http_request;
pub mod http_text;
pub mod memory_compat;
pub mod notifications;
pub mod pdf_generate;
pub mod vision_analyze;
pub mod web_fetch;
pub mod web_search;
pub mod workspace_fs;

mod capped_exec;
