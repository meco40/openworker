//! Slice S13 / Phase 3: Task Workspace Cleanup Runtime in Rust.
//!
//! Mirrors `src/server/tasks/workspaceCleanupRuntime.ts`:
//! - Queries active task IDs from `tasks.db`.
//! - Calls `betaclaw_core::tasks::workspace::cleanup_orphan_task_workspaces`.
//! - Runs on startup (if `TASK_WORKSPACES_CLEANUP_STARTUP=true`, default) and on interval
//!   (default 30 min / 1,800,000 ms, configurable via `TASK_WORKSPACES_CLEANUP_INTERVAL_MS`).
//! - Controlled by `TASK_WORKSPACES_CLEANUP_ENABLED` (default true).

use std::path::PathBuf;
use std::time::Duration;

use crate::background::BackgroundTask;
use betaclaw_core::tasks::workspace::{
    cleanup_orphan_task_workspaces, resolve_cleanup_max_removals, resolve_root, CleanupReport,
};

use crate::state::SharedState;

pub const DEFAULT_CLEANUP_INTERVAL_MS: u64 = 1_800_000; // 30 minutes

pub type WorkspaceCleanupHandle = BackgroundTask;

pub struct WorkspaceCleanup;

impl WorkspaceCleanup {
    pub fn is_enabled_from_env() -> bool {
        let cleanup_mode = std::env::var("BETACLAW_WORKSPACE_CLEANUP").ok();
        Self::parse_enabled(cleanup_mode.as_deref())
            && parse_boolean_env("TASK_WORKSPACES_CLEANUP_ENABLED", true)
    }

    pub fn parse_enabled(val: Option<&str>) -> bool {
        match val {
            Some(v) => v.trim().eq_ignore_ascii_case("rust"),
            None => false,
        }
    }

    pub fn should_run_startup() -> bool {
        parse_boolean_env("TASK_WORKSPACES_CLEANUP_STARTUP", true)
    }

    pub fn resolve_interval_ms() -> u64 {
        Self::parse_interval_ms(
            std::env::var("TASK_WORKSPACES_CLEANUP_INTERVAL_MS")
                .ok()
                .as_deref(),
        )
    }

    pub fn parse_interval_ms(val: Option<&str>) -> u64 {
        val.and_then(|v| v.parse::<u64>().ok())
            .filter(|&ms| ms > 0)
            .unwrap_or(DEFAULT_CLEANUP_INTERVAL_MS)
    }

    /// Runs one workspace cleanup pass.
    pub fn run_once(state: &SharedState, source: &str) -> CleanupReport {
        Self::run_once_at(
            state,
            source,
            resolve_root(),
            resolve_cleanup_max_removals(),
        )
    }

    fn run_once_at(
        state: &SharedState,
        source: &str,
        task_root: PathBuf,
        max_removals: usize,
    ) -> CleanupReport {
        let active_task_ids = {
            let conn = state.tasks.tasks.connection();
            let mut stmt = match conn.prepare("SELECT id FROM tasks") {
                Ok(s) => s,
                Err(err) => {
                    tracing::error!(error = %err, source = %source, "[task-workspaces] failed to query tasks");
                    return CleanupReport::default();
                }
            };
            let ids_res = stmt.query_map([], |row| row.get::<_, String>(0));
            match ids_res {
                Ok(iter) => iter.filter_map(Result::ok).collect::<Vec<String>>(),
                Err(err) => {
                    tracing::error!(error = %err, source = %source, "[task-workspaces] query_map failed");
                    return CleanupReport::default();
                }
            }
        };

        match cleanup_orphan_task_workspaces(&task_root, &active_task_ids, max_removals) {
            Ok(report) => {
                tracing::info!(
                    source = %source,
                    scanned = report.scanned,
                    removed = report.removed,
                    kept = report.kept,
                    skipped = report.skipped,
                    active = active_task_ids.len(),
                    "[task-workspaces] cleanup completed"
                );
                report
            }
            Err(err) => {
                tracing::error!(
                    error = %err,
                    source = %source,
                    "[task-workspaces] cleanup execution failed"
                );
                CleanupReport::default()
            }
        }
    }

    /// Runs one workspace cleanup pass on a blocking thread.
    pub async fn run_once_async(state: SharedState, source: &'static str) -> CleanupReport {
        tokio::task::spawn_blocking(move || Self::run_once(&state, source))
            .await
            .unwrap_or_default()
    }

    /// Starts the periodic workspace cleanup runtime.
    pub fn start(state: SharedState) -> Option<WorkspaceCleanupHandle> {
        if !Self::is_enabled_from_env() {
            tracing::info!("[task-workspaces] cleanup runtime disabled via env");
            return None;
        }

        let interval_ms = Self::resolve_interval_ms();
        let (stop, mut signal) = tokio::sync::watch::channel(false);
        let task = tokio::spawn(async move {
            if Self::should_run_startup() {
                Self::run_once_async(state.clone(), "startup").await;
            }
            loop {
                tokio::select! {
                    _ = signal.changed() => break,
                    _ = tokio::time::sleep(Duration::from_millis(interval_ms)) => {}
                }
                if *signal.borrow() {
                    break;
                }
                Self::run_once_async(state.clone(), "interval").await;
            }
        });
        Some(BackgroundTask { stop, task })
    }
}

fn parse_boolean_env(key: &str, fallback: bool) -> bool {
    parse_boolean(std::env::var(key).ok().as_deref(), fallback)
}

pub fn parse_boolean(val: Option<&str>, fallback: bool) -> bool {
    match val {
        Some(v) => {
            let normalized = v.trim().to_lowercase();
            match normalized.as_str() {
                "1" | "true" | "yes" | "on" => true,
                "0" | "false" | "no" | "off" => false,
                _ => fallback,
            }
        }
        None => fallback,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_preserves_active_workspaces_and_enforces_the_removal_limit() {
        let root = std::env::temp_dir().join(format!("cleanup-{}", uuid::Uuid::new_v4()));
        let mut config = betaclaw_core::config::GatewayConfig::from_env().unwrap();
        config.messages_db_path = ":memory:".into();
        config.personas_db_path = ":memory:".into();
        config.auth_db_path = ":memory:".into();
        config.logs_db_path = ":memory:".into();
        let state = std::sync::Arc::new(crate::state::AppState::new(config).unwrap());
        let active = state
            .tasks
            .tasks
            .create_task(
                &root,
                &betaclaw_core::tasks::validation::CreateTaskInput {
                    title: "Active cleanup test".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let active_path =
            betaclaw_core::tasks::workspace::ensure_task_workspace(&root, &active.id, "task")
                .unwrap();
        let a = betaclaw_core::tasks::workspace::ensure_task_workspace(&root, "orphan-a", "task")
            .unwrap();
        let b = betaclaw_core::tasks::workspace::ensure_task_workspace(&root, "orphan-b", "task")
            .unwrap();
        assert_eq!(
            WorkspaceCleanup::run_once_at(&state, "test", root.clone(), 1).removed,
            1
        );
        assert!(active_path.is_dir());
        assert_eq!(
            [a.exists(), b.exists()].into_iter().filter(|v| *v).count(),
            1
        );
        assert_eq!(
            WorkspaceCleanup::run_once_at(&state, "test", root.clone(), 10).removed,
            1
        );
        assert!(active_path.is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn test_parse_boolean_env() {
        assert!(!parse_boolean(Some("false"), true));
        assert!(!parse_boolean(Some("off"), true));
        assert!(!parse_boolean(Some("0"), true));
        assert!(!parse_boolean(Some("no"), true));

        assert!(parse_boolean(Some("1"), false));
        assert!(parse_boolean(Some("true"), false));
        assert!(parse_boolean(Some("yes"), false));
        assert!(parse_boolean(Some("on"), false));

        assert!(parse_boolean(None, true));
        assert!(!parse_boolean(None, false));
    }

    #[test]
    fn test_parse_enabled_table() {
        assert!(!WorkspaceCleanup::parse_enabled(None));
        assert!(!WorkspaceCleanup::parse_enabled(Some("")));
        assert!(!WorkspaceCleanup::parse_enabled(Some("node")));
        assert!(!WorkspaceCleanup::parse_enabled(Some("off")));
        assert!(!WorkspaceCleanup::parse_enabled(Some("false")));
        assert!(WorkspaceCleanup::parse_enabled(Some("rust")));
        assert!(WorkspaceCleanup::parse_enabled(Some("RUST")));
        assert!(WorkspaceCleanup::parse_enabled(Some("  rust  ")));
    }

    #[test]
    fn test_resolve_interval_ms() {
        assert_eq!(WorkspaceCleanup::parse_interval_ms(Some("60000")), 60_000);
        assert_eq!(
            WorkspaceCleanup::parse_interval_ms(None),
            DEFAULT_CLEANUP_INTERVAL_MS
        );
        assert_eq!(
            WorkspaceCleanup::parse_interval_ms(Some("0")),
            DEFAULT_CLEANUP_INTERVAL_MS
        );
    }
}
