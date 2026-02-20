import { describe, expect, it } from 'vitest';
import {
  applyOperatorProfileToConfig,
  computeOperatorUsageSnapshot,
  parseOperatorProfileFromConfig,
  type OperatorProfileState,
} from '../../../src/modules/profile/operatorProfileConfig';

describe('operatorProfileConfig', () => {
  it('parses safe defaults when operator config is missing', () => {
    const parsed = parseOperatorProfileFromConfig({
      gateway: { port: 8080, host: '127.0.0.1', logLevel: 'info' },
    });

    expect(parsed.displayName).toBe('OpenClaw Operator');
    expect(parsed.primaryContact).toBe('operator@openclaw.io');
    expect(parsed.localUuid).toBe('');
    expect(parsed.workspaceSlots).toBe(12);
    expect(parsed.dailyTokenBudget).toBe(250_000);
  });

  it('parses persisted operator profile and limits', () => {
    const parsed = parseOperatorProfileFromConfig({
      gateway: { port: 8080, host: '127.0.0.1', logLevel: 'info' },
      operator: {
        profile: {
          displayName: 'Local Operator',
          primaryContact: 'local@example.com',
          localUuid: 'OC-LOCAL-123',
        },
        limits: {
          workspaceSlots: 24,
          dailyTokenBudget: 1_000_000,
        },
      },
    });

    expect(parsed).toEqual<OperatorProfileState>({
      displayName: 'Local Operator',
      primaryContact: 'local@example.com',
      localUuid: 'OC-LOCAL-123',
      workspaceSlots: 24,
      dailyTokenBudget: 1_000_000,
    });
  });

  it('applies profile data into config while preserving other keys', () => {
    const baseConfig = {
      gateway: { port: 8080, host: '127.0.0.1', logLevel: 'info' },
      ui: { defaultView: 'dashboard' },
    };

    const next = applyOperatorProfileToConfig(baseConfig, {
      displayName: 'Operator A',
      primaryContact: 'a@example.com',
      localUuid: 'OC-A',
      workspaceSlots: 30,
      dailyTokenBudget: 600_000,
    });

    expect(next.ui).toEqual({ defaultView: 'dashboard' });
    expect(next.operator).toEqual({
      profile: {
        displayName: 'Operator A',
        primaryContact: 'a@example.com',
        localUuid: 'OC-A',
      },
      limits: {
        workspaceSlots: 30,
        dailyTokenBudget: 600_000,
      },
    });
  });

  it('computes usage values from metrics and configured limits', () => {
    const usage = computeOperatorUsageSnapshot(
      { workspaceSlots: 20, dailyTokenBudget: 500 },
      {
        tokensToday: 125,
        rooms: { totalRooms: 7, runningRooms: 2, totalMembers: 0, totalMessages: 0 },
      },
    );

    expect(usage.workspaceUsed).toBe(7);
    expect(usage.workspaceTotal).toBe(20);
    expect(usage.activeAgents).toBe(2);
    expect(usage.remainingBudgetPercent).toBe(75);
    expect(usage.tokensToday).toBe(125);
  });
});
