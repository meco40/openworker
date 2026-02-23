import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AppShellHeader from '@/modules/app-shell/components/AppShellHeader';
import type { ControlPlaneMetricsState } from '@/shared/domain/types';

describe('AppShellHeader', () => {
  it('renders RAM usage metric to the right of vector nodes', () => {
    const metricsState: ControlPlaneMetricsState = {
      metrics: {
        uptimeSeconds: 1,
        activeWsSessions: 1,
        tokensToday: 1,
        vectorNodeCount: 5,
        ramUsageBytes: 1_610_612_736,
        generatedAt: '2026-02-23T00:00:00.000Z',
      },
      loading: false,
      stale: false,
      error: null,
    };

    const html = renderToStaticMarkup(createElement(AppShellHeader, { metricsState }));
    const vectorNodesIndex = html.indexOf('Vector Nodes');
    const ramUsageIndex = html.indexOf('RAM Usage');

    expect(vectorNodesIndex).toBeGreaterThanOrEqual(0);
    expect(ramUsageIndex).toBeGreaterThan(vectorNodesIndex);
    expect(html).toMatch(/1[,.]5 GB/);
  });
});
