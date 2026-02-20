import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InstancesView from '@/modules/ops/components/InstancesView';
import { useOpsInstances, type UseOpsInstancesResult } from '@/modules/ops/hooks/useOpsInstances';

vi.mock('@/modules/ops/hooks/useOpsInstances', () => ({
  useOpsInstances: vi.fn(),
}));

const mockedUseOpsInstances = vi.mocked(useOpsInstances);

function buildState(partial: Partial<UseOpsInstancesResult> = {}): UseOpsInstancesResult {
  return {
    loading: false,
    refreshing: false,
    error: null,
    data: null,
    refresh: vi.fn(async () => {}),
    ...partial,
  };
}

describe('InstancesView', () => {
  beforeEach(() => {
    mockedUseOpsInstances.mockReturnValue(buildState());
  });

  it('renders loading and refresh affordance', () => {
    mockedUseOpsInstances.mockReturnValue(buildState({ loading: true }));
    const html = renderToStaticMarkup(createElement(InstancesView));

    expect(html).toContain('Instances');
    expect(html).toContain('Loading instance telemetry...');
    expect(html).toContain('Refresh');
  });

  it('renders empty state when there are no active user connections', () => {
    mockedUseOpsInstances.mockReturnValue(
      buildState({
        data: {
          ok: true,
          instances: {
            global: {
              connectionCount: 0,
              userCount: 0,
            },
            currentUser: {
              connectionCount: 0,
              connections: [],
            },
            generatedAt: '2026-02-20T00:00:00.000Z',
          },
        },
      }),
    );

    const html = renderToStaticMarkup(createElement(InstancesView));
    expect(html).toContain('No active connections for this user.');
    expect(html).toContain('Connected Users');
  });

  it('renders connection details when data is available', () => {
    mockedUseOpsInstances.mockReturnValue(
      buildState({
        data: {
          ok: true,
          instances: {
            global: {
              connectionCount: 4,
              userCount: 2,
            },
            currentUser: {
              connectionCount: 2,
              connections: [
                {
                  connId: 'conn-1',
                  connectedAt: '2026-02-20T00:00:00.000Z',
                  subscriptionCount: 3,
                  requestCount: 17,
                  seq: 12,
                },
              ],
            },
            generatedAt: '2026-02-20T00:00:00.000Z',
          },
        },
      }),
    );

    const html = renderToStaticMarkup(createElement(InstancesView));
    expect(html).toContain('conn-1');
    expect(html).toContain('Subscriptions');
    expect(html).toContain('Requests');
  });
});
