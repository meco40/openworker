export interface TriggerPolicyInput {
  scopeKey: string;
  capability: string;
  now: number;
  timeoutMs: number;
  cooldownMs: number;
  maxConcurrent: number;
  activeForCapability: number;
  activeGlobal: number;
}

export interface TriggerPolicyResult {
  allowed: boolean;
  reason?: 'cooldown_active' | 'capacity_exhausted' | 'budget_exceeded';
}

const lastCapabilityTriggerAt = new Map<string, number>();

function triggerKey(scopeKey: string, capability: string): string {
  return `${scopeKey}::${capability}`;
}

export function evaluateTriggerPolicy(input: TriggerPolicyInput): TriggerPolicyResult {
  const key = triggerKey(input.scopeKey, input.capability);
  const lastAt = lastCapabilityTriggerAt.get(key) ?? 0;
  if (input.now > lastAt && input.now - lastAt < input.cooldownMs) {
    return { allowed: false, reason: 'cooldown_active' };
  }
  if (
    input.activeGlobal >= input.maxConcurrent ||
    input.activeForCapability >= input.maxConcurrent
  ) {
    return { allowed: false, reason: 'capacity_exhausted' };
  }
  if (input.timeoutMs <= 0) {
    return { allowed: false, reason: 'budget_exceeded' };
  }
  lastCapabilityTriggerAt.set(key, input.now);
  return { allowed: true };
}

export function resetTriggerPolicyState(): void {
  lastCapabilityTriggerAt.clear();
}
