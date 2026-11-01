//! Shared ownership and bounded draining for the background jobs in `server.ts`.

use std::time::Duration;
use tokio::sync::watch;
use tokio::task::JoinHandle;

/// Switches that choose who runs a background job. The Node implementations were
/// removed, so the only owners are `rust` and `off`.
pub const JOB_SWITCHES: [&str; 3] = [
    "BETACLAW_TELEGRAM_POLLER",
    "BETACLAW_SWARM_RUNNER",
    "BETACLAW_WORKSPACE_CLEANUP",
];

/// Parses one job switch. Unset or blank means `rust`. `node` and unknown values are
/// errors, so a stale setting stops the process instead of silently disabling a job.
pub fn parse_job_owner(name: &str, value: Option<&str>) -> Result<&'static str, String> {
    let normalized = value.unwrap_or_default().trim().to_ascii_lowercase();
    match normalized.as_str() {
        "" | "rust" => Ok("rust"),
        "off" | "false" | "0" => Ok("off"),
        "node" => Err(format!(
            "{name}=node is no longer supported: the Node implementation of this job was removed. Use {name}=rust or {name}=off."
        )),
        _ => Err(format!(
            "{name} has an unknown value (`{normalized}`). Use rust or off; unset means rust."
        )),
    }
}

/// Owner of one job from the process environment, `rust` or `off`.
pub fn job_owner(name: &str) -> Result<&'static str, String> {
    parse_job_owner(name, std::env::var(name).ok().as_deref())
}

/// Checks every job switch. Both binaries call this before they open a port or start a job.
pub fn validate_job_switches() -> Result<(), String> {
    for name in JOB_SWITCHES {
        job_owner(name)?;
    }
    Ok(())
}

pub struct BackgroundTask {
    pub(crate) stop: watch::Sender<bool>,
    pub(crate) task: JoinHandle<()>,
}

impl BackgroundTask {
    pub async fn stop(mut self) {
        let _ = self.stop.send(true);
        if tokio::time::timeout(Duration::from_secs(5), &mut self.task)
            .await
            .is_err()
        {
            tracing::warn!("Background job did not drain within 5s; aborting");
            self.task.abort();
            let _ = self.task.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_switch_parsing_defaults_to_rust_and_refuses_node() {
        for unset in [None, Some(""), Some("   ")] {
            assert_eq!(parse_job_owner("X", unset), Ok("rust"));
        }
        for value in [Some("rust"), Some("RUST"), Some("  rust  ")] {
            assert_eq!(parse_job_owner("X", value), Ok("rust"));
        }
        for value in [Some("off"), Some("OFF"), Some("false"), Some("0")] {
            assert_eq!(parse_job_owner("X", value), Ok("off"));
        }
        let node = parse_job_owner("BETACLAW_SWARM_RUNNER", Some("node")).unwrap_err();
        assert!(node.contains("BETACLAW_SWARM_RUNNER=node"), "{node}");
        assert!(node.contains("removed"), "{node}");
        assert!(parse_job_owner("X", Some("yes")).is_err());
    }

    #[tokio::test]
    async fn stop_waits_for_the_in_flight_round() {
        let (stop, mut signal) = watch::channel(false);
        let (finished, done) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            signal.changed().await.unwrap();
            tokio::time::sleep(Duration::from_millis(20)).await;
            finished.send(()).unwrap();
        });
        BackgroundTask { stop, task }.stop().await;
        done.await.expect("round finished before stop returned");
    }
}
