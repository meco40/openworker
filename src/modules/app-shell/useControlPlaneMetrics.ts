import { useCallback, useEffect, useState } from 'react';
import type { ControlPlaneMetrics, ControlPlaneMetricsState } from '../../../types';

interface ControlPlaneMetricsResponse {
  ok: boolean;
  metrics?: ControlPlaneMetrics;
  error?: string;
}

export function useControlPlaneMetrics(): ControlPlaneMetricsState & { refresh: () => Promise<void> } {
  const [metrics, setMetrics] = useState<ControlPlaneMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/control-plane/metrics', { cache: 'no-store' });
      const payload = (await response.json()) as ControlPlaneMetricsResponse;
      if (!response.ok || !payload.ok || !payload.metrics) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }

      setMetrics(payload.metrics);
      setStale(false);
      setError(null);
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : 'Unable to load control-plane metrics.';
      setError(message);
      setStale(true);
      setMetrics((previous) => previous ?? null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    metrics,
    loading,
    stale,
    error,
    refresh,
  };
}
