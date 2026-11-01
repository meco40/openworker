//! Standalone binary entry point for the Rust scheduler (`betaclaw-scheduler`).
//!
//! Replaces `scheduler.ts` in Slice S13: runs startup configuration guards,
//! builds the shared application state without opening an HTTP listener port,
//! starts the Automation, Knowledge, and World-Model background workers, and
//! performs an ordered shutdown on `SIGTERM` / `SIGINT`.
//!
//! `betaclaw-scheduler migrate [--provision-roles] [--apply]` is a one-shot
//! subcommand for the Compose `migrate` service. It replaces
//! `scripts/world-model-migrate.ts` and `scripts/world-model-provision-roles.ts`
//! (Phase 1 of `docs/TS_BACKEND_REMOVAL_PLAN.md`). It applies the World-Model
//! migrations, optionally provisions the runtime roles, and exits. Without a
//! subcommand the binary runs the scheduler as before.
//!
//! The other one-shot subcommands are Phase 3 ports of the operations scripts, implemented
//! in `betaclaw_gateway::world_model_ops`: `provision-roles [--apply]`, `verify-rls`,
//! `reconcile`, `rebuild-projections`, `backfill`, `workspaces-cleanup`,
//! `attachments-consistency`, `knowledge-ingest`, `memory-reset`,
//! `memory-cleanup-noise`, `memory-backfill-channel-scope`,
//! `memory-migrate-to-postgres`, `graphiti-evaluate` and `drill`. `drill-lease-child` is
//! the child process of the `drill` restart scenario and not meant for operators.
//! `scripts/rust-scheduler-ops.mjs` runs them with `.env.local` loaded, as the
//! `pnpm run` commands do.

/// The subcommands, for the message of an unknown one.
const USAGE: &str = "usage: betaclaw-scheduler [migrate [--provision-roles] [--apply] | provision-roles [--apply] | verify-rls | reconcile [flags] | rebuild-projections [flags] | backfill [flags] | workspaces-cleanup [--json] | attachments-consistency [flags] | knowledge-ingest [flags] | memory-reset | memory-cleanup-noise [flags] | memory-backfill-channel-scope | memory-migrate-to-postgres [flags] | graphiti-evaluate [flags] | drill [--scenario <name>]]";

use std::collections::HashMap;
use std::time::Duration;

use betaclaw_core::config::GatewayConfig;
use betaclaw_core::world_model::config::world_model_config_from_process_env;
use betaclaw_core::world_model::db::PgExecutor;
use betaclaw_core::world_model::driver::{PgPoolSettings, SqlxPgExecutor};
use betaclaw_core::world_model::migrations::{
    run_world_model_migrations_with_admin_pool, MigrationSettings,
};
use betaclaw_core::world_model::role_provisioning::{provision_roles, RolePasswords};
use betaclaw_gateway::scheduler_runtime::start_scheduler_runtime;
use betaclaw_gateway::state::GatewayRuntime;
use betaclaw_gateway::world_model_ops;

/// How long the one-shot command waits for a connection (`connectionTimeoutMillis`
/// of the provisioning script).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

#[tokio::main]
async fn main() {
    if std::env::args().any(|arg| arg == "--version" || arg == "-V") {
        println!("betaclaw-scheduler {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let args: Vec<String> = std::env::args().skip(1).collect();
    let rest = &args[args.len().min(1)..];
    match args.first().map(String::as_str) {
        Some("migrate") => {
            exit_on_error(run_migrate(rest).await);
            return;
        }
        Some("provision-roles") => {
            exit_on_error(run_provision_roles(rest).await);
            return;
        }
        Some("verify-rls") => std::process::exit(world_model_ops::verify_rls::run(rest).await),
        Some("reconcile") => std::process::exit(world_model_ops::reconcile::run(rest).await),
        Some("rebuild-projections") => {
            std::process::exit(world_model_ops::rebuild::run(rest).await)
        }
        Some("backfill") => std::process::exit(world_model_ops::backfill::run(rest).await),
        Some("workspaces-cleanup") => {
            std::process::exit(world_model_ops::workspaces::run(rest).await)
        }
        Some("attachments-consistency") => {
            std::process::exit(world_model_ops::attachments::run(rest).await)
        }
        Some("knowledge-ingest") => {
            // The pass logs its warnings like the scheduler does.
            init_cli_tracing();
            std::process::exit(world_model_ops::knowledge_ingest::run(rest).await)
        }
        Some("memory-reset") => std::process::exit(world_model_ops::memory_reset::run(rest).await),
        Some("memory-cleanup-noise") => {
            std::process::exit(world_model_ops::memory_cleanup_noise::run(rest).await)
        }
        Some("memory-backfill-channel-scope") => {
            std::process::exit(world_model_ops::memory_backfill_channel_scope::run(rest).await)
        }
        Some("memory-migrate-to-postgres") => {
            std::process::exit(world_model_ops::memory_migrate_to_postgres::run(rest).await)
        }
        Some("graphiti-evaluate") => {
            std::process::exit(world_model_ops::graphiti_evaluate::run(rest).await)
        }
        Some("drill") => {
            // The scenarios log their degradation warnings like the scheduler does.
            init_cli_tracing();
            std::process::exit(world_model_ops::drill::run(rest).await)
        }
        Some("drill-lease-child") => {
            std::process::exit(world_model_ops::drill::lease_child(rest).await)
        }
        // A mistyped subcommand must not start the scheduler and its workers.
        Some(other) if !other.starts_with('-') => {
            eprintln!("unknown subcommand `{other}`; {USAGE}");
            std::process::exit(2);
        }
        _ => {}
    }

    init_tracing();

    if let Err(error) = run().await {
        eprintln!("[automation-scheduler] startup failed: {error}");
        std::process::exit(1);
    }
}

/// The options of `betaclaw-scheduler migrate`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MigrateOptions {
    provision_roles: bool,
    apply: bool,
}

/// Parses the arguments after `migrate`. `--apply` only means something together
/// with `--provision-roles`, so it is refused alone instead of being ignored.
fn parse_migrate_args(args: &[String]) -> Result<MigrateOptions, String> {
    let mut options = MigrateOptions {
        provision_roles: false,
        apply: false,
    };
    for arg in args {
        match arg.as_str() {
            "--provision-roles" => options.provision_roles = true,
            "--apply" => options.apply = true,
            other => {
                return Err(format!(
                    "unknown argument `{other}`; usage: betaclaw-scheduler migrate [--provision-roles] [--apply]"
                ))
            }
        }
    }
    if options.apply && !options.provision_roles {
        return Err("--apply needs --provision-roles".to_string());
    }
    Ok(options)
}

/// `scripts/world-model-migrate.ts` followed by `scripts/world-model-provision-roles.ts`
/// (`--apply` when given). Migrations always run first, as in the Compose command.
async fn run_migrate(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let options = parse_migrate_args(args)?;

    // Without an admin URL the app pool runs the migrations, as `db.ts:168-171` does.
    // The lazy pool lets the reachability probe report the canonical error itself.
    let app_settings = PgPoolSettings::from_config(&world_model_config_from_process_env());
    let app = SqlxPgExecutor::connect_lazy(&app_settings, CONNECT_TIMEOUT)?;
    let migrations = MigrationSettings::from_env();
    let applied = run_world_model_migrations_with_admin_pool(&app, &migrations).await;
    app.close().await;
    let applied = applied?;
    println!("Applied World-Model migrations: [{}]", applied.join(", "));

    if options.provision_roles {
        provision_roles_once(options.apply).await?;
    }
    Ok(())
}

/// `provision-roles [--apply]`: `scripts/world-model-provision-roles.ts`, read-only
/// without `--apply`. Unlike `migrate` it runs no migration, as the script does not.
async fn run_provision_roles(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let mut apply = false;
    for arg in args {
        match arg.as_str() {
            "--apply" => apply = true,
            other => {
                return Err(format!(
                "unknown argument `{other}`; usage: betaclaw-scheduler provision-roles [--apply]"
            )
                .into())
            }
        }
    }
    provision_roles_once(apply).await
}

/// The provisioning step shared by `migrate --provision-roles` and `provision-roles`.
async fn provision_roles_once(apply: bool) -> Result<(), Box<dyn std::error::Error>> {
    let env: HashMap<String, String> = std::env::vars().collect();
    let admin_url = env
        .get(betaclaw_core::world_model::migrations::ADMIN_DATABASE_URL_ENV)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let admin = match admin_url {
        Some(url) => Some(SqlxPgExecutor::connect_lazy(
            &PgPoolSettings {
                database_url: url,
                pool_max: 1,
                pool_idle_timeout_ms: 5_000,
            },
            CONNECT_TIMEOUT,
        )?),
        None => None,
    };
    let passwords = RolePasswords::from_env(&env);
    let mut report = Vec::new();
    let outcome = provision_roles(
        admin.as_ref().map(|executor| executor as &dyn PgExecutor),
        &passwords,
        apply,
        &mut report,
    )
    .await;
    for line in &report {
        println!("{line}");
    }
    if let Some(admin) = &admin {
        admin.close().await;
    }
    outcome?;
    Ok(())
}

/// Prints the error of a one-shot subcommand and exits with status 1.
fn exit_on_error(result: Result<(), Box<dyn std::error::Error>>) {
    if let Err(error) = result {
        eprintln!("{error}");
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

/// The logging of the one-shot commands: diagnostics go to stderr, so the report on
/// stdout stays clean, as the TypeScript scripts' `console.warn` did.
fn init_cli_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_writer(std::io::stderr)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn migrate_runs_the_migrations_alone_by_default() {
        assert_eq!(
            parse_migrate_args(&args(&[])),
            Ok(MigrateOptions {
                provision_roles: false,
                apply: false
            })
        );
    }

    #[test]
    fn provisioning_without_apply_is_a_dry_run() {
        assert_eq!(
            parse_migrate_args(&args(&["--provision-roles"])),
            Ok(MigrateOptions {
                provision_roles: true,
                apply: false
            })
        );
        assert_eq!(
            parse_migrate_args(&args(&["--provision-roles", "--apply"])),
            Ok(MigrateOptions {
                provision_roles: true,
                apply: true
            })
        );
    }

    #[test]
    fn apply_alone_and_unknown_arguments_are_refused() {
        assert_eq!(
            parse_migrate_args(&args(&["--apply"])),
            Err("--apply needs --provision-roles".to_string())
        );
        let error = parse_migrate_args(&args(&["--force"])).expect_err("unknown");
        assert!(error.contains("unknown argument `--force`"), "{error}");
    }
}
