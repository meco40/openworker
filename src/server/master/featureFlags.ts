function normalizeFlagValue(value: string | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function isEnabledFlag(value: string | undefined, defaultValue = false): boolean {
  const normalized = normalizeFlagValue(value);
  if (!normalized) {
    return defaultValue;
  }
  return !['0', 'false', 'off', 'no'].includes(normalized);
}

export function isMasterSystemPersonaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabledFlag(env.MASTER_SYSTEM_PERSONA_ENABLED, true);
}

export function isMasterGenericRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabledFlag(env.MASTER_GENERIC_RUNTIME_ENABLED, true);
}

export function isMasterApprovalControlPlaneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabledFlag(env.MASTER_APPROVAL_CONTROL_PLANE_ENABLED, true);
}

export function isMasterSubagentSessionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabledFlag(env.MASTER_SUBAGENT_SESSIONS_ENABLED, true);
}

export function isMasterOperatorEventsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabledFlag(env.MASTER_OPERATOR_EVENTS_ENABLED, true);
}
