import { describe, expect, it } from 'vitest';
import type { GatewayState, MemoryEntry, ScheduledTask } from '../../../types';
import { buildPersonalityMatrix } from '../../../lib/personalityMatrix';

function memoryEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: crypto.randomUUID(),
    type: 'fact',
    content: 'x',
    timestamp: '2026-02-01T10:00:00.000Z',
    importance: 5,
    ...overrides,
  };
}

function task(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: crypto.randomUUID(),
    targetTime: '2026-02-15T10:00:00.000Z',
    content: 'reminder',
    platform: 'Slack',
    status: 'pending',
    ...overrides,
  } as ScheduledTask;
}

function gatewayState(overrides: Partial<GatewayState>): GatewayState {
  return {
    version: 'test',
    uptime: 0,
    cpuUsage: 0,
    memoryUsage: 0,
    activeSessions: 0,
    onboarded: true,
    totalTokens: 0,
    eventHistory: [],
    trafficData: [],
    memoryEntries: [],
    scheduledTasks: [],
    ...overrides,
  };
}

describe('buildPersonalityMatrix', () => {
  it('keeps every score inside 0..100 even with extreme input volume', () => {
    const now = new Date('2026-02-14T12:00:00.000Z');
    const state = gatewayState({
      memoryEntries: Array.from({ length: 80 }, (_, i) =>
        memoryEntry({
          id: `mem-${i}`,
          type: i % 2 === 0 ? 'preference' : 'fact',
          importance: 10,
          timestamp: '2026-02-14T08:00:00.000Z',
        }),
      ),
      scheduledTasks: Array.from({ length: 40 }, (_, i) =>
        task({
          id: `task-${i}`,
          status: i % 3 === 0 ? 'triggered' : 'pending',
          targetTime: '2026-02-15T10:00:00.000Z',
        }),
      ),
    });

    const { stats } = buildPersonalityMatrix(state, now);

    expect(stats).toHaveLength(5);
    stats.forEach((entry) => {
      expect(entry.A).toBeGreaterThanOrEqual(0);
      expect(entry.A).toBeLessThanOrEqual(100);
      expect(entry.fullMark).toBe(100);
    });
  });

  it('weights recent memory higher than very old memory', () => {
    const now = new Date('2026-02-14T12:00:00.000Z');
    const recent = gatewayState({
      memoryEntries: [
        memoryEntry({
          type: 'preference',
          importance: 8,
          timestamp: '2026-02-14T11:00:00.000Z',
        }),
      ],
    });
    const old = gatewayState({
      memoryEntries: [
        memoryEntry({
          type: 'preference',
          importance: 8,
          timestamp: '2025-05-01T11:00:00.000Z',
        }),
      ],
    });

    const recentScore = buildPersonalityMatrix(recent, now).stats.find(
      (entry) => entry.subject === 'Communication',
    )?.A;
    const oldScore = buildPersonalityMatrix(old, now).stats.find(
      (entry) => entry.subject === 'Communication',
    )?.A;

    expect(recentScore).toBeDefined();
    expect(oldScore).toBeDefined();
    expect(recentScore!).toBeGreaterThan(oldScore!);
  });

  it('uses semantically clear axis labels and derives focus from the weakest dimension', () => {
    const now = new Date('2026-02-14T12:00:00.000Z');
    const state = gatewayState({
      memoryEntries: [
        memoryEntry({
          type: 'preference',
          importance: 9,
          timestamp: '2026-02-14T10:00:00.000Z',
        }),
        memoryEntry({
          type: 'avoidance',
          importance: 8,
          timestamp: '2026-02-14T10:00:00.000Z',
        }),
      ],
      scheduledTasks: [
        task({
          status: 'triggered',
          targetTime: '2026-02-13T11:00:00.000Z',
        }),
      ],
    });

    const result = buildPersonalityMatrix(state, now);

    expect(result.stats.map((entry) => entry.subject)).toContain('Boundaries');
    expect(result.focus.toLowerCase()).toContain('workflow');
  });
});
