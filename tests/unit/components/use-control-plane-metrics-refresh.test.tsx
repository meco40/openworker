import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlPlaneMetrics } from '@/shared/domain/types';
import type { MockProcedure } from '../../helpers/mockProcedure';

const requestControlPlaneMetrics = vi.fn<MockProcedure>();

vi.mock('@/modules/app-shell/controlPlaneMetricsClient', () => ({
  requestControlPlaneMetrics,
}));

const metrics: ControlPlaneMetrics = {
  uptimeSeconds: 10,
  activeWsSessions: 1,
  tokensToday: 20,
  vectorNodeCount: 3,
  generatedAt: '2026-09-12T00:00:00.000Z',
};

describe('useControlPlaneMetrics refresh lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    requestControlPlaneMetrics.mockResolvedValue(metrics);
  });

  afterEach(() => {
    vi.useRealTimers();
    requestControlPlaneMetrics.mockReset();
  });

  it('refreshes on mount and at the interval while visible', async () => {
    const { result, unmount } = await import('@/modules/app-shell/useControlPlaneMetrics').then(
      ({ useControlPlaneMetrics }) => renderHook(() => useControlPlaneMetrics()),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(requestControlPlaneMetrics).toHaveBeenCalledTimes(1);
    expect(result.current.metrics).toEqual(metrics);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(requestControlPlaneMetrics).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(requestControlPlaneMetrics).toHaveBeenCalledTimes(2);
  });

  it('skips background interval work and refreshes when visibility returns', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });

    try {
      const { useControlPlaneMetrics } = await import('@/modules/app-shell/useControlPlaneMetrics');
      renderHook(() => useControlPlaneMetrics());

      await act(async () => {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(requestControlPlaneMetrics).not.toHaveBeenCalled();

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
      });
      expect(requestControlPlaneMetrics).toHaveBeenCalledTimes(1);
    } finally {
      if (descriptor) {
        Object.defineProperty(document, 'visibilityState', descriptor);
      }
    }
  });
});
