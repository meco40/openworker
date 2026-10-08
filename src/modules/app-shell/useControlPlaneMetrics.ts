import { useCallback, useEffect, useRef, useState } from 'react';
import type { ControlPlaneMetrics, ControlPlaneMetricsState } from '@/shared/domain/types';
import { requestControlPlaneMetrics } from '@/modules/app-shell/controlPlaneMetricsClient';

const METRICS_REFRESH_INTERVAL_MS = 30_000;

export function useControlPlaneMetrics(): ControlPlaneMetricsState & {
  refresh: () => Promise<void>;
} {
  const [metrics, setMetrics] = useState<ControlPlaneMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const metricsRef = useRef<ControlPlaneMetrics | null>(null);

  const refresh = useCallback(async () => {
    if (!metricsRef.current) {
      setLoading(true);
    }
    try {
      const metrics = await requestControlPlaneMetrics();
      metricsRef.current = metrics;
      setMetrics(metrics);
      setStale(false);
      setError(null);
    } catch (requestError) {
      const message =
        requestError instanceof Error
          ? requestError.message
          : 'Unable to load control-plane metrics.';
      setError(message);
      setStale(true);
      setMetrics((previous) => previous ?? null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };

    refreshWhenVisible();
    const intervalId = window.setInterval(refreshWhenVisible, METRICS_REFRESH_INTERVAL_MS);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('focus', refreshWhenVisible);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('focus', refreshWhenVisible);
    };
  }, [refresh]);

  return {
    metrics,
    loading,
    stale,
    error,
    refresh,
  };
}
