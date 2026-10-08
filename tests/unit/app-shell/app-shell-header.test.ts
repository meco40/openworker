import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AppShellHeader from '@/modules/app-shell/components/AppShellHeader';
import type { ControlPlaneMetricsState } from '@/shared/domain/types';
import type { ConnectionState } from '@/modules/gateway/ws-client';

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

    const html = renderToStaticMarkup(
      createElement(AppShellHeader, { metricsState, gatewayConnectionState: 'connected' }),
    );
    const vectorNodesIndex = html.indexOf('Vector Nodes');
    const ramUsageIndex = html.indexOf('RAM Usage');

    expect(vectorNodesIndex).toBeGreaterThanOrEqual(0);
    expect(ramUsageIndex).toBeGreaterThan(vectorNodesIndex);
    expect(html).toMatch(/1[,.]5 GB/);
    expect(html).toContain('Bridge Online');
    expect(html).not.toContain('Active Bridge Node');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('hidden items-center space-x-6 md:flex');
    expect(html).toContain('whitespace-nowrap');
  });

  it('renders unavailable vector counts as placeholder', () => {
    const metricsState: ControlPlaneMetricsState = {
      metrics: {
        uptimeSeconds: 1,
        activeWsSessions: 1,
        tokensToday: 1,
        vectorNodeCount: -1,
        ramUsageBytes: 1024,
        generatedAt: '2026-02-23T00:00:00.000Z',
      },
      loading: false,
      stale: false,
      error: null,
    };

    const html = renderToStaticMarkup(
      createElement(AppShellHeader, { metricsState, gatewayConnectionState: 'connected' }),
    );

    expect(html).toContain('Vector Nodes');
    expect(html).toContain('--');
  });

  it('does not claim the bridge is online before or after a failed metrics request', () => {
    const loadingHtml = renderToStaticMarkup(
      createElement(AppShellHeader, {
        metricsState: { metrics: null, loading: true, stale: false, error: null },
        gatewayConnectionState: 'connected',
      }),
    );
    const degradedHtml = renderToStaticMarkup(
      createElement(AppShellHeader, {
        metricsState: {
          metrics: null,
          loading: false,
          stale: true,
          error: 'Request failed',
        },
        gatewayConnectionState: 'connected',
      }),
    );

    expect(loadingHtml).toContain('Checking Bridge');
    expect(loadingHtml).not.toContain('Bridge Online');
    expect(degradedHtml).toContain('Bridge Degraded');
    expect(degradedHtml).not.toContain('Bridge Online');
  });

  it.each<[ConnectionState, string]>([
    ['connecting', 'Connecting Gateway'],
    ['reconnecting', 'Reconnecting Gateway'],
    ['disconnected', 'Gateway Offline'],
  ])('reflects the websocket state (%s)', (state, label) => {
    const html = renderToStaticMarkup(
      createElement(AppShellHeader, {
        metricsState: {
          metrics: {
            uptimeSeconds: 1,
            activeWsSessions: 0,
            tokensToday: 0,
            vectorNodeCount: 0,
            generatedAt: '2026-02-23T00:00:00.000Z',
          },
          loading: false,
          stale: false,
          error: null,
        },
        gatewayConnectionState: state,
      }),
    );

    expect(html).toContain(label);
    expect(html).not.toContain('Bridge Online');
  });
});
