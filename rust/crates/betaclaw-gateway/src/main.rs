//! HTTP entry point for the Rust gateway.
//!
//! The process owns the public listener. Start-up mirrors `server.ts`: auth and
//! configuration guards run before the port opens, the tick and keepalive
//! intervals start after the listener is bound, and SIGTERM/SIGINT performs an
//! ordered shutdown.

use betaclaw_core::config::GatewayConfig;
use betaclaw_core::gateway::broadcast::run_keepalive_sweep;
use betaclaw_core::gateway::events::TICK;
use betaclaw_gateway::proxy::build_router;
use betaclaw_gateway::state::GatewayRuntime;

#[tokio::main]
async fn main() {
    init_tracing();

    if let Err(error) = run().await {
        // Startup failures must be loud and must never print secret values.
        eprintln!("[gateway] failed to start: {error}");
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
    let config = GatewayConfig::from_env()?;
    tracing::info!(
        bind = %format!("{}:{}", config.hostname, config.port),
        upstream = %config.upstream_origin,
        require_auth = config.require_auth,
        demo_mode = config.demo_mode,
        "Starting Rust gateway"
    );

    let runtime = GatewayRuntime::bind(config).await?;
    let state = runtime.state.clone();

    if state.config.demo_mode {
        tracing::info!("[DEMO] Running in demo mode — all write operations are blocked");
    }

    let app = build_router(state.clone());

    // Tick and keepalive share the 30 s cadence from `server.ts:216-219`.
    let tick_state = state.clone();
    let ticker = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(
            betaclaw_core::gateway::TICK_INTERVAL_MS,
        ));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let now_ms = chrono::Utc::now().timestamp_millis() as u64;
            betaclaw_core::gateway::broadcast::broadcast(
                &tick_state.registry,
                TICK,
                Some(serde_json::json!({ "ts": now_ms })),
            );
            run_keepalive_sweep(&tick_state.registry);
        }
    });

    let shutdown_state = state.clone();
    axum::serve(
        runtime.listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown_signal().await;
        tracing::info!("[gateway] Shutting down...");

        // Stop the heartbeat before closing sockets so no frame is emitted
        // after a close frame.
        ticker.abort();

        // Notify peers, then give them a moment to process the close frame.
        for client in shutdown_state.registry.get_all() {
            client.enqueue_close(1001, "server shutting down");
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    })
    .await?;

    tracing::info!("[gateway] Server closed.");
    Ok(())
}

/// SIGTERM/SIGINT handler. Mirrors `process.on('SIGTERM'|'SIGINT')` in `server.ts`.
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
