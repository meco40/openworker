'use client';

import { useCallback, useState } from 'react';
import type { PipelineModel } from '@/components/model-hub/types';

interface UsePipelineModelsReturn {
  pipelineModels: PipelineModel[];
  loadPipelineModels: () => Promise<void>;
}

export function usePipelineModels(): UsePipelineModelsReturn {
  const [pipelineModels, setPipelineModels] = useState<PipelineModel[]>([]);

  const loadPipelineModels = useCallback(async () => {
    try {
      const res = await fetch('/api/model-hub/pipeline');
      if (res.ok) {
        const data = await res.json();
        setPipelineModels(data.models ?? []);
      }
    } catch {
      /* ignore */
    }
  }, []);

  return {
    pipelineModels,
    loadPipelineModels,
  };
}
