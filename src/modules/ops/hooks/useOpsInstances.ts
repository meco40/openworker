'use client';

import { useCallback, useEffect, useState } from 'react';
import type { OpsInstancesResponse } from '@/modules/ops/types';

interface ErrorPayload {
  ok?: boolean;
  error?: string;
}

export interface UseOpsInstancesResult {
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  data: OpsInstancesResponse | null;
  refresh: () => Promise<void>;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function readJson(response: Response): Promise<OpsInstancesResponse> {
  const payload = (await response.json()) as OpsInstancesResponse | ErrorPayload;
  if (!response.ok || payload.ok === false) {
    const errorMessage = 'error' in payload ? payload.error : undefined;
    throw new Error(errorMessage || `HTTP ${response.status}`);
  }
  return payload as OpsInstancesResponse;
}

export function useOpsInstances(): UseOpsInstancesResult {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<OpsInstancesResponse | null>(null);

  const refresh = useCallback(async () => {
    if (loading) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    setError(null);
    try {
      const response = await fetch('/api/ops/instances', { cache: 'no-store' });
      const payload = await readJson(response);
      setData(payload);
    } catch (requestError) {
      setError(getErrorMessage(requestError, 'Failed to load instances.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loading]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    loading,
    refreshing,
    error,
    data,
    refresh,
  };
}
