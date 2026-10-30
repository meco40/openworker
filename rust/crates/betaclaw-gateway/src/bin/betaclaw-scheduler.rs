//! Standalone binary entry point for the Rust scheduler (`betaclaw-scheduler`).
//!
//! Replaces `scheduler.ts` in Slice S13: runs startup configuration guards,
//! builds the shared application state without opening an HTTP listener port,
//! starts the Automation, Knowledge, and World-Model background workers, and
//! performs an ordered shutdown on `SIGTERM` / `SIGINT`.

use std::collections::HashMap;

use betaclaw_core::config::GatewayConfig;
use betaclaw_gateway::scheduler_runtime::start_scheduler_runtime;
use betaclaw_gateway::state::GatewayRuntime;

#[tokio::main]
async fn main() {
    if std::env::args().any(|arg| arg == "--version" || arg == "-V") {
        println!("betaclaw-scheduler {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    init_tracing();

    if let Err(error) = run().await {
        eprintln!("[automation-scheduler] startup failed: {error}");
        std::process::exit(1);
    }
}

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("[automation-scheduler] resolving configuration");
    let config = GatewayConfig::from_env()?;
    let env: HashMap<String, String> = std::env::vars().collect();
    tracing::info!("[automation-scheduler] initializing shared stores");
    let state = GatewayRuntime::init_state(config)?;
    let scheduler = start_scheduler_runtime(state, env).await?;

    shutdown_signal().await;
    tracing::info!("[automation-scheduler] Shutting down with 6s timeout...");
    let drain_future = async {
        scheduler.shutdown().await;
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    };
    if tokio::time::timeout(std::time::Duration::from_secs(6), drain_future)
        .await
        .is_err()
    {
        tracing::warn!("[automation-scheduler] Graceful shutdown timed out; forcing exit");
    }
    Ok(())
}

/// SIGTERM/SIGINT handler. Mirrors `process.on('SIGTERM'|'SIGINT')` in `scheduler.ts:97-98`.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(error) => {
                tracing::warn!(error = %error, "Failed to install SIGTERM handler");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}
