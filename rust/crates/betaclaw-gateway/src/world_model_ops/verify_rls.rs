//! `betaclaw-scheduler verify-rls` replaces `pnpm run world-model:verify-rls`
//! (`scripts/world-model-verify-rls.ts`). The checks live in
//! `betaclaw_world_model::world_model::role_verification`.
//!
//! Usage: `betaclaw-scheduler verify-rls`, with `WORLD_MODEL_APP_DATABASE_URL` and
//! `WORLD_MODEL_WORKER_DATABASE_URL` in the environment. Exit status 0 when every
//! check passes, 1 otherwise (and on a connection failure). Like the script, the
//! arguments are ignored.

use betaclaw_core::world_model::role_verification::{
    has_failures, probe_source_id, report_lines, verify_app_role, verify_worker_role, RlsCheck,
    APP_DATABASE_URL_ENV, WORKER_DATABASE_URL_ENV,
};

use super::{connect_url, env_trimmed, process_env};

/// The probe rows are removed again by the run, so the pool of one is enough.
const POOL_MAX: i64 = 1;
const POOL_IDLE_MS: i64 = 5_000;

/// Runs the verification and prints the report. Returns the exit status.
pub async fn run(_args: &[String]) -> i32 {
    match verify().await {
        Ok(checks) => {
            for line in report_lines(&checks) {
                println!("{line}");
            }
            if has_failures(&checks) {
                1
            } else {
                0
            }
        }
        Err(message) => {
            eprintln!("{message}");
            1
        }
    }
}

/// The order of the script: the app URL is required and verified first, the worker
/// URL only afterwards, and nothing is printed before both have run.
async fn verify() -> Result<Vec<RlsCheck>, String> {
    let env = process_env();
    let probe = probe_source_id(chrono::Utc::now().timestamp_millis());
    let mut checks = Vec::new();

    let app_url = required_url(&env, APP_DATABASE_URL_ENV)?;
    let app = connect_url(&app_url, POOL_MAX, POOL_IDLE_MS)
        .await
        .map_err(|error| error.into_message())?;
    let app_outcome = verify_app_role(&app, &probe, &mut checks).await;
    app.close().await;
    app_outcome.map_err(|error| error.into_message())?;

    let worker_url = required_url(&env, WORKER_DATABASE_URL_ENV)?;
    let worker = connect_url(&worker_url, POOL_MAX, POOL_IDLE_MS)
        .await
        .map_err(|error| error.into_message())?;
    let worker_outcome = verify_worker_role(&worker, &mut checks).await;
    worker.close().await;
    worker_outcome.map_err(|error| error.into_message())?;

    Ok(checks)
}

/// `requireUrl(name)` (`world-model-verify-rls.ts:37-41`).
fn required_url(
    env: &std::collections::HashMap<String, String>,
    name: &str,
) -> Result<String, String> {
    env_trimmed(env, name)
        .ok_or_else(|| format!("{name} is required. Run world-model:provision-roles first."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn a_missing_url_names_the_variable_and_the_next_step() {
        let env: HashMap<String, String> = [(APP_DATABASE_URL_ENV.to_string(), "   ".to_string())]
            .into_iter()
            .collect();
        assert_eq!(
            required_url(&env, APP_DATABASE_URL_ENV).unwrap_err(),
            "WORLD_MODEL_APP_DATABASE_URL is required. Run world-model:provision-roles first."
        );
    }

    #[test]
    fn the_url_is_trimmed() {
        let env: HashMap<String, String> = [(
            WORKER_DATABASE_URL_ENV.to_string(),
            " postgresql://w@h/db \n".to_string(),
        )]
        .into_iter()
        .collect();
        assert_eq!(
            required_url(&env, WORKER_DATABASE_URL_ENV).unwrap(),
            "postgresql://w@h/db"
        );
    }
}
