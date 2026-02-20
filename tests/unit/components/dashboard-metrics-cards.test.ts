import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Dashboard from '@/components/Dashboard';
import type { ControlPlaneMetricsState, GatewayState } from '@/shared/domain/types';

const baseState: GatewayState = {
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
};

const metricsState: ControlPlaneMetricsState = {
  metrics: {
    uptimeSeconds: 3661,
    activeWsSessions: 9,
    tokensToday: 12345,
    vectorNodeCount: 7,
    generatedAt: '2026-02-11T12:00:00.000Z',
  },
  loading: false,
  stale: false,
  error: null,
};

describe('Dashboard top KPI cards', () => {
  it('renders Ops Core KPI labels and does not render old placeholders', () => {
    const html = renderToStaticMarkup(
      createElement(Dashboard, {
        state: baseState,
        metricsState,
      }),
    );

    expect(html).toContain('Uptime');
    expect(html).toContain('Active WS Sessions');
    expect(html).toContain('Tokens Today');

    expect(html).not.toContain('Proactive Ratio');
    expect(html).not.toContain('Vector Health');
  });
});
