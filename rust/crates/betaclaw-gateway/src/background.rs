//! Shared ownership and bounded draining for the background jobs in `server.ts`.

use std::time::Duration;
use tokio::sync::watch;
use tokio::task::JoinHandle;

pub fn job_owner(name: &str) -> &'static str {
    match std::env::var(name)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "rust" => "rust",
        "off" | "false" | "0" => "off",
        _ => "node",
    }
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
