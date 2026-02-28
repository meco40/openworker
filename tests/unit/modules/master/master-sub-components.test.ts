/**
 * Master sub-components – unit tests
 *
 * Tests RunStatusBadge, RunList, ApprovalDecisionForm, MetricsPanel
 * using renderToStaticMarkup (no DOM required).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RunStatusBadge } from '@/modules/master/components/RunStatusBadge';
import { RunList } from '@/modules/master/components/RunList';
import { ApprovalDecisionForm } from '@/modules/master/components/ApprovalDecisionForm';
import { MetricsPanel } from '@/modules/master/components/MetricsPanel';
import type { MasterRun, MasterRunStatus, MasterMetrics } from '@/modules/master/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<MasterRun> = {}): MasterRun {
  return {
    id: 'run-1',
    userId: 'u1',
    workspaceId: 'main',
    title: 'Test Run',
    contract: 'Do something',
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

// ─── RunStatusBadge ───────────────────────────────────────────────────────────

describe('RunStatusBadge', () => {
  it('is a defined React component', () => {
    expect(RunStatusBadge).toBeDefined();
    expect(typeof RunStatusBadge).toBe('function');
  });

  const allStatuses: MasterRunStatus[] = [
    'IDLE',
    'ANALYZING',
    'PLANNING',
    'DELEGATING',
    'EXECUTING',
    'VERIFYING',
    'REFINING',
    'AWAITING_APPROVAL',
    'COMPLETED',
    'CANCELLED',
    'FAILED',
  ];

  it.each(allStatuses)('renders badge for status "%s"', (status) => {
    const html = renderToStaticMarkup(createElement(RunStatusBadge, { status }));
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain('class');
  });

  it('renders "Executing" label for EXECUTING status', () => {
    const html = renderToStaticMarkup(createElement(RunStatusBadge, { status: 'EXECUTING' }));
    expect(html).toContain('Executing');
  });

  it('renders "Awaiting Approval" label for AWAITING_APPROVAL status', () => {
    const html = renderToStaticMarkup(
      createElement(RunStatusBadge, { status: 'AWAITING_APPROVAL' }),
    );
    expect(html).toContain('Awaiting Approval');
  });

  it('renders "Completed" label for COMPLETED status', () => {
    const html = renderToStaticMarkup(createElement(RunStatusBadge, { status: 'COMPLETED' }));
    expect(html).toContain('Completed');
  });

  it('renders "Failed" label for FAILED status', () => {
    const html = renderToStaticMarkup(createElement(RunStatusBadge, { status: 'FAILED' }));
    expect(html).toContain('Failed');
  });

  it('includes pulse animation for active statuses', () => {
    const html = renderToStaticMarkup(createElement(RunStatusBadge, { status: 'EXECUTING' }));
    expect(html).toContain('animate-pulse');
  });

  it('does not include pulse animation for COMPLETED', () => {
    const html = renderToStaticMarkup(createElement(RunStatusBadge, { status: 'COMPLETED' }));
    expect(html).not.toContain('animate-pulse');
  });
});

// ─── RunList ──────────────────────────────────────────────────────────────────

describe('RunList', () => {
  it('is a defined React component', () => {
    expect(RunList).toBeDefined();
    expect(typeof RunList).toBe('function');
  });

  it('renders empty state when no runs', () => {
    const html = renderToStaticMarkup(
      createElement(RunList, {
        runs: [],
        selectedRunId: null,
        onSelectRun: () => {},
      }),
    );
    expect(html).toContain('No runs yet');
  });

  it('renders run titles', () => {
    const runs = [
      makeRun({ id: 'r1', title: 'Alpha Run' }),
      makeRun({ id: 'r2', title: 'Beta Run' }),
    ];
    const html = renderToStaticMarkup(
      createElement(RunList, {
        runs,
        selectedRunId: null,
        onSelectRun: () => {},
      }),
    );
    expect(html).toContain('Alpha Run');
    expect(html).toContain('Beta Run');
  });

  it('shows pagination when runs exceed page size', () => {
    const runs = Array.from({ length: 11 }, (_, i) => makeRun({ id: `r${i}`, title: `Run ${i}` }));
    const html = renderToStaticMarkup(
      createElement(RunList, {
        runs,
        selectedRunId: null,
        onSelectRun: () => {},
      }),
    );
    expect(html).toContain('1 / 2');
  });

  it('does not show pagination when runs fit on one page', () => {
    const runs = [makeRun()];
    const html = renderToStaticMarkup(
      createElement(RunList, {
        runs,
        selectedRunId: null,
        onSelectRun: () => {},
      }),
    );
    expect(html).not.toContain('Prev');
  });
});

// ─── ApprovalDecisionForm ─────────────────────────────────────────────────────

describe('ApprovalDecisionForm', () => {
  it('is a defined React component', () => {
    expect(ApprovalDecisionForm).toBeDefined();
    expect(typeof ApprovalDecisionForm).toBe('function');
  });

  it('renders approval header', () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalDecisionForm, {
        loading: false,
        onSubmit: () => {},
      }),
    );
    expect(html).toContain('Approval Required');
  });

  it('renders decision options', () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalDecisionForm, {
        loading: false,
        onSubmit: () => {},
      }),
    );
    expect(html).toContain('Approve Once');
    expect(html).toContain('Approve Always');
    expect(html).toContain('Deny');
  });

  it('renders Apply Decision button', () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalDecisionForm, {
        loading: false,
        onSubmit: () => {},
      }),
    );
    expect(html).toContain('Apply Decision');
  });
});

// ─── MetricsPanel ─────────────────────────────────────────────────────────────

describe('MetricsPanel', () => {
  it('is a defined React component', () => {
    expect(MetricsPanel).toBeDefined();
    expect(typeof MetricsPanel).toBe('function');
  });

  it('renders empty state when metrics is null', () => {
    const html = renderToStaticMarkup(createElement(MetricsPanel, { metrics: null }));
    expect(html).toContain('Select a persona to view metrics');
  });

  it('renders formatted percentages', () => {
    const metrics: MasterMetrics = {
      run_completion_rate: 0.85,
      verify_pass_rate: 0.92,
      delegation_success_rate: 0.78,
      generated_at: new Date().toISOString(),
    };
    const html = renderToStaticMarkup(createElement(MetricsPanel, { metrics }));
    expect(html).toContain('85%');
    expect(html).toContain('92%');
    expect(html).toContain('78%');
  });

  it('renders metric labels', () => {
    const metrics: MasterMetrics = {
      run_completion_rate: 0.5,
      verify_pass_rate: 0.5,
      delegation_success_rate: 0.5,
      generated_at: new Date().toISOString(),
    };
    const html = renderToStaticMarkup(createElement(MetricsPanel, { metrics }));
    expect(html).toContain('Completion');
    expect(html).toContain('Verify Pass');
    expect(html).toContain('Delegation');
  });
});
