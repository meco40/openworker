import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import Dashboard from '../../../components/Dashboard';
import { type ControlPlaneMetricsState, type GatewayState } from '../../../types';

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

const baseMetricsState: ControlPlaneMetricsState = {
  metrics: null,
  loading: false,
  stale: false,
  error: null,
};

describe('Dashboard chart sizing', () => {
  it('does not emit the Recharts invalid-size warning on initial render', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      renderToStaticMarkup(
        createElement(Dashboard, {
          state: baseState,
          metricsState: baseMetricsState,
        }),
      );
    } finally {
      const warningMessages = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .join('\n');

      expect(warningMessages).not.toContain('The width(-1) and height(-1) of chart should be greater than 0');
      warnSpy.mockRestore();
    }
  });
});
