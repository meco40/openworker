import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import Dashboard from '@/components/Dashboard';
import { type ControlPlaneMetricsState, type GatewayState } from '@/shared/domain/types';

const baseState: GatewayState = {
  eventHistory: [],
  memoryEntries: [],
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
          scheduledTasks: [],
          metricsState: baseMetricsState,
        }),
      );
    } finally {
      const warningMessages = warnSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');

      expect(warningMessages).not.toContain(
        'The width(-1) and height(-1) of chart should be greater than 0',
      );
      warnSpy.mockRestore();
    }
  });

  it('shows an honest empty state instead of an empty radar chart', () => {
    const html = renderToStaticMarkup(
      createElement(Dashboard, {
        state: baseState,
        scheduledTasks: [],
        metricsState: baseMetricsState,
      }),
    );

    expect(html).toContain('No behavior signals yet');
    expect(html).not.toContain('Personality Matrix:');
    expect(html).toContain('0 pending tasks');
    expect(html).not.toContain('Cron Scheduler Active');
  });
});
