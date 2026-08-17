'use client';

import { useCallback, useRef, useState } from 'react';
import type { PipelineModel } from '@/components/model-hub/types';

interface UsePipelineModelsReturn {
  pipelineModels: PipelineModel[];
  loadPipelineModels: () => Promise<void>;
}

export function usePipelineModels(): UsePipelineModelsReturn {
  const [pipelineModels, setPipelineModels] = useState<PipelineModel[]>([]);
  const loadedRef = useRef(false);
  const loadingRef = useRef<Promise<void> | null>(null);

  const loadPipelineModels = useCallback(async () => {
    if (loadedRef.current) return;
    if (loadingRef.current) return loadingRef.current;

    const loadPromise = (async () => {
      try {
        const res = await fetch('/api/model-hub/pipeline');
        if (res.ok) {
          const data = await res.json();
          setPipelineModels(data.models ?? []);
          loadedRef.current = true;
        }
      } catch {
        /* ignore */
      } finally {
        loadingRef.current = null;
      }
    })();

    loadingRef.current = loadPromise;
    return loadPromise;
  }, []);

  return {
    pipelineModels,
    loadPipelineModels,
  };
}
