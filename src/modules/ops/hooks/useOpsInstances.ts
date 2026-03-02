'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpsInstancesResponse } from '@/modules/ops/types';
import { getErrorMessage, readJsonOrThrow } from './http';

export interface UseOpsInstancesResult {
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  data: OpsInstancesResponse | null;
  refresh: () => Promise<void>;
}

export function useOpsInstances(): UseOpsInstancesResult {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<OpsInstancesResponse | null>(null);
  const initialLoadRef = useRef(true);

  const refresh = useCallback(async () => {
    if (initialLoadRef.current) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    setError(null);
    try {
      const response = await fetch('/api/ops/instances', { cache: 'no-store' });
      const payload = await readJsonOrThrow<OpsInstancesResponse>(response);
      setData(payload);
    } catch (requestError) {
      setError(getErrorMessage(requestError, 'Failed to load instances.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
      initialLoadRef.current = false;
    }
  }, []);

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
