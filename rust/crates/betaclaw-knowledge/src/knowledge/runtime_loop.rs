//! Port of `src/server/knowledge/runtimeLoop.ts` (1-76).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `KnowledgeRuntimeLoopOptions` (`:1-13`) | [`KnowledgeRuntimeLoopOptions`] |
//! | `KnowledgeRuntimeLoop.start` / `stop` (`:22-41`) | [`KnowledgeRuntimeLoop::start`], [`KnowledgeRuntimeLoop::stop`] |
//! | `tick` (`:43-62`) | [`KnowledgeRuntimeLoop::run_tick`] |
//! | `runMaintenance` (`:64-86`) | the private `run_maintenance` |
//!
//! # Deviations
//!
//! * `setInterval(...).unref()` has no Rust counterpart; the task ends with the
//!   runtime, and [`KnowledgeRuntimeLoop::stop`] aborts it.
//! * The tasks are boxed futures, so the caller chooses what they capture.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::task::JoinHandle;
use tracing::warn;

/// A maintenance or ingestion task. The error text is logged.
pub type LoopTask =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> + Send + Sync>;

/// `KnowledgeRuntimeLoopOptions` (`runtimeLoop.ts:1-13`).
#[derive(Clone)]
pub struct KnowledgeRuntimeLoopOptions {
    pub enabled: bool,
    pub interval: Duration,
    pub run_ingestion: LoopTask,
    pub run_cleanup: Option<LoopTask>,
    pub run_reconciliation: Option<LoopTask>,
    pub run_summarization: Option<LoopTask>,
    /// `maintenanceEveryNthTick`, default 10 in the TypeScript.
    pub maintenance_every_nth_tick: u64,
}

/// The state that the timer and the ticks share.
struct Shared {
    options: KnowledgeRuntimeLoopOptions,
    in_flight: AtomicBool,
    tick_count: AtomicU64,
}

/// Clears an in-flight flag when dropped, including on cancellation and unwinding.
struct InFlightReset<'a>(&'a AtomicBool);

impl Drop for InFlightReset<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Shared {
    /// `tick()` (`runtimeLoop.ts:43-62`). A tick that finds a previous one still
    /// running returns at once.
    async fn tick(&self) {
        if self.in_flight.swap(true, Ordering::SeqCst) {
            return;
        }
        // The `finally { this.inFlight = false; }` of the source. A guard, so a
        // panicking task does not leave every later tick skipped.
        let _in_flight = InFlightReset(&self.in_flight);
        let count = self.tick_count.fetch_add(1, Ordering::SeqCst) + 1;

        match (self.options.run_ingestion)().await {
            Ok(()) => {
                // Maintenance runs on every Nth tick, not on each one.
                let every = self.options.maintenance_every_nth_tick;
                if every > 0 && count.is_multiple_of(every) {
                    self.run_maintenance().await;
                }
            }
            Err(error) => warn!(error = %error, "[knowledge] ingestion tick failed"),
        }
    }

    /// `runMaintenance()` (`runtimeLoop.ts:64-86`). Each task is independent: a
    /// failure is logged and the next one still runs.
    async fn run_maintenance(&self) {
        let tasks = [
            (&self.options.run_cleanup, "cleanup failed"),
            (&self.options.run_reconciliation, "reconciliation failed"),
            (&self.options.run_summarization, "summarization failed"),
        ];
        for (task, label) in tasks {
            let Some(task) = task else {
                continue;
            };
            if let Err(error) = task().await {
                warn!(error = %error, "[knowledge] {label}");
            }
        }
    }
}

/// `KnowledgeRuntimeLoop` (`runtimeLoop.ts:15-86`).
pub struct KnowledgeRuntimeLoop {
    shared: Arc<Shared>,
    timer: Mutex<Option<JoinHandle<()>>>,
}

impl KnowledgeRuntimeLoop {
    pub fn new(options: KnowledgeRuntimeLoopOptions) -> Self {
        Self {
            shared: Arc::new(Shared {
                options,
                in_flight: AtomicBool::new(false),
                tick_count: AtomicU64::new(0),
            }),
            timer: Mutex::new(None),
        }
    }

    /// `start()` (`runtimeLoop.ts:22-31`): a first tick at once, then one per
    /// interval. Does nothing when disabled or already started. Needs a running
    /// tokio runtime.
    pub fn start(&self) {
        if !self.shared.options.enabled {
            return;
        }
        let mut timer = self.timer.lock().expect("loop timer lock");
        if timer.is_some() {
            return;
        }
        let shared = Arc::clone(&self.shared);
        let interval = self.shared.options.interval;
        *timer = Some(tokio::spawn(async move {
            // `tokio::time::interval` completes its first tick at once, like the
            // immediate `void this.tick()` of the TypeScript.
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let shared = Arc::clone(&shared);
                // Each tick is its own task, so a slow one does not delay the
                // timer; `in_flight` skips the overlap.
                tokio::spawn(async move { shared.tick().await });
            }
        }));
    }

    /// `stop()` (`runtimeLoop.ts:33-41`). A tick already running is not cancelled.
    pub fn stop(&self) {
        if let Some(handle) = self.timer.lock().expect("loop timer lock").take() {
            handle.abort();
        }
    }

    /// One tick, awaited. The timer calls the same logic.
    pub async fn run_tick(&self) {
        self.shared.tick().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn counting_task(counter: Arc<AtomicUsize>) -> LoopTask {
        Arc::new(move || {
            let counter = Arc::clone(&counter);
            Box::pin(async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        })
    }

    fn options(
        ingestion: Arc<AtomicUsize>,
        cleanup: Arc<AtomicUsize>,
        enabled: bool,
    ) -> KnowledgeRuntimeLoopOptions {
        KnowledgeRuntimeLoopOptions {
            enabled,
            interval: Duration::from_secs(3600),
            run_ingestion: counting_task(ingestion),
            run_cleanup: Some(counting_task(cleanup)),
            run_reconciliation: None,
            run_summarization: None,
            maintenance_every_nth_tick: 3,
        }
    }

    #[tokio::test]
    async fn maintenance_runs_on_every_nth_tick_only() {
        let ingestion = Arc::new(AtomicUsize::new(0));
        let cleanup = Arc::new(AtomicUsize::new(0));
        let loop_ =
            KnowledgeRuntimeLoop::new(options(Arc::clone(&ingestion), Arc::clone(&cleanup), true));
        for _ in 0..7 {
            loop_.run_tick().await;
        }
        assert_eq!(ingestion.load(Ordering::SeqCst), 7);
        // Ticks 3 and 6 run the maintenance.
        assert_eq!(cleanup.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_disabled_loop_never_starts_its_timer() {
        let loop_ = KnowledgeRuntimeLoop::new(options(
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
            false,
        ));
        loop_.start();
        assert!(loop_.timer.lock().expect("lock").is_none());
    }
}
