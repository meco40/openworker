function normalizeFlagValue(value: string | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

export function isMasterSystemPersonaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const normalized = normalizeFlagValue(env.MASTER_SYSTEM_PERSONA_ENABLED);
  if (!normalized) {
    return true;
  }
  return !['0', 'false', 'off', 'no'].includes(normalized);
}
