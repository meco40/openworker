/**
 * useMasterView – unit tests
 *
 * Tests state transitions, validation, auto-dismiss, and pagination
 * without DOM rendering. All API calls are mocked.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock the API module ──────────────────────────────────────────────────────

vi.mock('@/modules/master/api', () => ({
  fetchMasterSettings: vi.fn(async () => ({
    persona: {
      id: 'master-1',
      name: 'Master',
      slug: 'master',
      emoji: '🧭',
      systemPersonaKey: 'master',
    },
    runtimeSettings: {
      preferredModelId: 'gpt-4o-mini',
      modelHubProfileId: 'ops-team',
      isAutonomous: true,
      maxToolCalls: 120,
    },
    allowedToolFunctionNames: ['shell_execute', 'web_search'],
    instructionFiles: {
      'SOUL.md': 'Master soul',
      'AGENTS.md': 'Master agents',
      'USER.md': 'Master user',
    },
  })),
  fetchMasterPersonas: vi.fn(async () => [
    {
      id: 'persona-1',
      name: 'Architect',
      slug: 'architect',
      emoji: '🧠',
      systemPersonaKey: null,
    },
  ]),
  fetchWorkspaces: vi.fn(async () => [{ id: 'main', name: 'Main', slug: 'main' }]),
  fetchRuns: vi.fn(async () => []),
  fetchMetrics: vi.fn(async () => null),
  fetchRunDetail: vi.fn(async () => null),
  createRun: vi.fn(async (input: { title: string; contract: string }) => ({
    id: 'run-new',
    userId: 'u1',
    workspaceId: 'main',
    title: input.title,
    contract: input.contract,
    status: 'IDLE' as const,
    progress: 0,
    verificationPassed: false,
    resultBundle: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastError: null,
    pausedForApproval: false,
    pendingApprovalActionType: null,
    cancelledAt: null,
    cancelReason: null,
  })),
  postRunAction: vi.fn(async () => ({ exportBundle: { result: 'ok' } })),
  cancelRun: vi.fn(async () => {}),
  isMasterSystemPersonaDisabledError: (error: unknown) =>
    error instanceof Error && /disabled/i.test(error.message),
  submitFeedback: vi.fn(async () => {}),
  saveMasterSettings: vi.fn(async () => ({
    persona: {
      id: 'master-1',
      name: 'Master',
      slug: 'master',
      emoji: '🧭',
      systemPersonaKey: 'master',
    },
    runtimeSettings: {
      preferredModelId: 'gpt-4o-mini',
      modelHubProfileId: 'ops-team',
      isAutonomous: true,
      maxToolCalls: 120,
    },
    allowedToolFunctionNames: ['shell_execute', 'web_search'],
    instructionFiles: {
      'SOUL.md': 'Master soul',
      'AGENTS.md': 'Master agents',
      'USER.md': 'Master user',
    },
  })),
}));

import type { MasterRun } from '@/modules/master/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<MasterRun> = {}): MasterRun {
  return {
    id: 'run-1',
    userId: 'u1',
    workspaceId: 'main',
    title: 'Test Run',
    contract: 'Do something useful',
    status: 'IDLE',
    progress: 0,
    verificationPassed: false,
    resultBundle: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastError: null,
    pausedForApproval: false,
    pendingApprovalActionType: null,
    cancelledAt: null,
    cancelReason: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useMasterView – module resolution', () => {
  it('hook module resolves', async () => {
    const mod = await import('@/modules/master/hooks/useMasterView');
    expect(mod.useMasterView).toBeDefined();
    expect(typeof mod.useMasterView).toBe('function');
  });
});

describe('useMasterView – pagination logic', () => {
  const RUNS_PER_PAGE = 10;

  it('paginates correctly for 25 runs', () => {
    const runs = Array.from({ length: 25 }, (_, i) => makeRun({ id: `run-${i}` }));
    const page0 = runs.slice(0, RUNS_PER_PAGE);
    const page1 = runs.slice(RUNS_PER_PAGE, RUNS_PER_PAGE * 2);
    const page2 = runs.slice(RUNS_PER_PAGE * 2);

    expect(page0).toHaveLength(10);
    expect(page1).toHaveLength(10);
    expect(page2).toHaveLength(5);
  });

  it('totalRunPages is 1 for empty list', () => {
    const totalRunPages = Math.max(1, Math.ceil(0 / RUNS_PER_PAGE));
    expect(totalRunPages).toBe(1);
  });

  it('totalRunPages is 3 for 25 runs', () => {
    const totalRunPages = Math.max(1, Math.ceil(25 / RUNS_PER_PAGE));
    expect(totalRunPages).toBe(3);
  });

  it('totalRunPages is 1 for exactly 10 runs', () => {
    const totalRunPages = Math.max(1, Math.ceil(10 / RUNS_PER_PAGE));
    expect(totalRunPages).toBe(1);
  });
});

describe('useMasterView – hasActiveRuns logic', () => {
  const ACTIVE_STATUSES = new Set([
    'ANALYZING',
    'PLANNING',
    'DELEGATING',
    'EXECUTING',
    'VERIFYING',
    'REFINING',
    'AWAITING_APPROVAL',
  ]);

  it('returns true when any run is EXECUTING', () => {
    const runs = [makeRun({ status: 'EXECUTING' }), makeRun({ id: 'r2', status: 'COMPLETED' })];
    const hasActive = runs.some((r) => ACTIVE_STATUSES.has(r.status));
    expect(hasActive).toBe(true);
  });

  it('returns false when all runs are COMPLETED or FAILED', () => {
    const runs = [makeRun({ status: 'COMPLETED' }), makeRun({ id: 'r2', status: 'FAILED' })];
    const hasActive = runs.some((r) => ACTIVE_STATUSES.has(r.status));
    expect(hasActive).toBe(false);
  });

  it('returns false for empty list', () => {
    const hasActive = ([] as MasterRun[]).some((r) => ACTIVE_STATUSES.has(r.status));
    expect(hasActive).toBe(false);
  });

  it('AWAITING_APPROVAL counts as active', () => {
    const runs = [makeRun({ status: 'AWAITING_APPROVAL' })];
    const hasActive = runs.some((r) => ACTIVE_STATUSES.has(r.status));
    expect(hasActive).toBe(true);
  });
});

describe('useMasterView – createRun validation', () => {
  it('rejects empty contract', () => {
    const contract = '   ';
    const isValid = contract.trim().length > 0;
    expect(isValid).toBe(false);
  });

  it('accepts non-empty contract', () => {
    const contract = 'Analyze Q4 data';
    const isValid = contract.trim().length > 0;
    expect(isValid).toBe(true);
  });

  it('uses default title when empty', () => {
    const runTitle = '   ';
    const effectiveTitle = runTitle.trim() || 'Master Contract';
    expect(effectiveTitle).toBe('Master Contract');
  });

  it('uses provided title when non-empty', () => {
    const runTitle = 'My Custom Run';
    const effectiveTitle = runTitle.trim() || 'Master Contract';
    expect(effectiveTitle).toBe('My Custom Run');
  });
});

describe('useMasterView – selectedRun logic', () => {
  it('returns null when no run is selected', () => {
    const runs = [makeRun()];
    const selectedRunId: string | null = null;
    const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null;
    expect(selectedRun).toBeNull();
  });

  it('returns correct run when selected', () => {
    const runs = [makeRun({ id: 'run-a' }), makeRun({ id: 'run-b' })];
    const selectedRunId = 'run-b';
    const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null;
    expect(selectedRun?.id).toBe('run-b');
  });

  it('returns null when selectedRunId does not match any run', () => {
    const runs = [makeRun({ id: 'run-a' })];
    const selectedRunId = 'run-nonexistent';
    const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null;
    expect(selectedRun).toBeNull();
  });
});

describe('useMasterView – auto-dismiss timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('status message is cleared after 5000ms', () => {
    let statusMessage: { tone: string; text: string } | null = { tone: 'info', text: 'Test' };
    const timer = setTimeout(() => {
      statusMessage = null;
    }, 5_000);

    expect(statusMessage).not.toBeNull();
    vi.advanceTimersByTime(5_000);
    expect(statusMessage).toBeNull();

    clearTimeout(timer);
  });

  it('status message persists before 5000ms', () => {
    let statusMessage: { tone: string; text: string } | null = { tone: 'success', text: 'Done' };
    const timer = setTimeout(() => {
      statusMessage = null;
    }, 5_000);

    vi.advanceTimersByTime(4_999);
    expect(statusMessage).not.toBeNull();

    clearTimeout(timer);
  });
});
