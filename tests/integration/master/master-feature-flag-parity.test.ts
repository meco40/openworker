import { describe, expect, it } from 'vitest';
import {
  isMasterApprovalControlPlaneEnabled,
  isMasterGenericRuntimeEnabled,
  isMasterOperatorEventsEnabled,
  isMasterSubagentSessionsEnabled,
  isMasterSystemPersonaEnabled,
} from '@/server/master/featureFlags';

describe('master feature flag parity', () => {
  it('defaults all rollout flags to enabled', () => {
    expect(isMasterSystemPersonaEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(isMasterGenericRuntimeEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(isMasterApprovalControlPlaneEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(isMasterSubagentSessionsEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(isMasterOperatorEventsEnabled({} as NodeJS.ProcessEnv)).toBe(true);
  });

  it('respects explicit disabled values', () => {
    const env = {
      NODE_ENV: 'test',
      MASTER_SYSTEM_PERSONA_ENABLED: 'false',
      MASTER_GENERIC_RUNTIME_ENABLED: 'off',
      MASTER_APPROVAL_CONTROL_PLANE_ENABLED: '0',
      MASTER_SUBAGENT_SESSIONS_ENABLED: 'no',
      MASTER_OPERATOR_EVENTS_ENABLED: 'false',
    } satisfies NodeJS.ProcessEnv;

    expect(isMasterSystemPersonaEnabled(env)).toBe(false);
    expect(isMasterGenericRuntimeEnabled(env)).toBe(false);
    expect(isMasterApprovalControlPlaneEnabled(env)).toBe(false);
    expect(isMasterSubagentSessionsEnabled(env)).toBe(false);
    expect(isMasterOperatorEventsEnabled(env)).toBe(false);
  });
});
