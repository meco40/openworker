import type { ControlPlaneMetrics } from '@/shared/domain/types';

interface ControlPlaneMetricsResponse {
  ok: boolean;
  metrics?: ControlPlaneMetrics;
  error?: string;
}

let pendingRequest: Promise<ControlPlaneMetrics> | null = null;

async function fetchControlPlaneMetrics(): Promise<ControlPlaneMetrics> {
  const response = await fetch('/api/control-plane/metrics?scope=shell', { cache: 'no-store' });
  const payload = (await response.json()) as ControlPlaneMetricsResponse;
  if (!response.ok || !payload.ok || !payload.metrics) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  return payload.metrics;
}

export function requestControlPlaneMetrics(): Promise<ControlPlaneMetrics> {
  if (pendingRequest) {
    return pendingRequest;
  }

  const request = fetchControlPlaneMetrics();
  pendingRequest = request;
  const clearRequest = () => {
    if (pendingRequest === request) {
      pendingRequest = null;
    }
  };
  void request.then(clearRequest, clearRequest);
  return request;
}
