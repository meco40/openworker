//! Trait port for `src/server/skills/handlers/gatewaySelfHeal.ts`. Not implemented in this slice.
//!
//! `status` reports the facts of the running gateway process, and `restart` schedules a
//! controlled termination. Both belong to the gateway runtime, so the handler side calls this
//! trait. The owner check (`BETACLAW_OWNER_USER_ID` or `PRINCIPAL_USER_ID`) and the action
//! parsing are not ported here. They move to the gateway slice with the runtime.

use serde_json::Value;

use super::types::SkillError;

/// Process facts and restart control of the running gateway.
pub trait GatewayRuntime: Send + Sync {
    /// `status`: the pid, platform, runtime version, uptime in seconds, memory figures and
    /// whether a restart is already scheduled.
    fn status(&self) -> Value;

    /// `restart`: schedules `SIGTERM`, or `SIGKILL` when `force`, after `delay_ms`. The
    /// caller clamps the delay to the TypeScript bounds first.
    fn schedule_restart(
        &self,
        delay_ms: u64,
        force: bool,
        reason: &str,
    ) -> Result<Value, SkillError>;
}
