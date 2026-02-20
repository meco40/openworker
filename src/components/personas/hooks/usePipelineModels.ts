'use client';

import { useCallback, useState } from 'react';

interface PipelineModel {
  id: string;
  accountId: string;
  providerId: string;
  modelName: string;
  status: 'active' | 'rate-limited' | 'offline';
  priority: number;
}

interface UsePipelineModelsReturn {
  pipelineModels: PipelineModel[];
  loadPipelineModels: () => Promise<void>;
  savingPreferredModel: boolean;
  savePreferredModel: (
    selectedId: string,
    modelId: string | null,
    refreshPersonas: () => Promise<void>,
    loadPersona: (id: string) => Promise<void>,
  ) => Promise<void>;
}

export function usePipelineModels(): UsePipelineModelsReturn {
  const [pipelineModels, setPipelineModels] = useState<PipelineModel[]>([]);
  const [savingPreferredModel, setSavingPreferredModel] = useState(false);

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

  const savePreferredModel = useCallback(
    async (
      selectedId: string,
      modelId: string | null,
      refreshPersonas: () => Promise<void>,
      loadPersona: (id: string) => Promise<void>,
    ) => {
      setSavingPreferredModel(true);
      try {
        const res = await fetch(`/api/personas/${selectedId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preferredModelId: modelId }),
        });
        if (res.ok) {
          await refreshPersonas();
          await loadPersona(selectedId);
        }
      } catch {
        /* ignore */
      } finally {
        setSavingPreferredModel(false);
      }
    },
    [],
  );

  return {
    pipelineModels,
    loadPipelineModels,
    savingPreferredModel,
    savePreferredModel,
  };
}
