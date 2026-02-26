'use client';

import { useMemo } from 'react';
import type { PipelineModel } from '../types';

interface UseValidationProps {
  pipelineModels: PipelineModel[];
  preferredModelId: string | null;
}

export function useValidation({ pipelineModels, preferredModelId }: UseValidationProps) {
  const activeModels = useMemo(
    () => pipelineModels.filter((m) => m.status === 'active'),
    [pipelineModels],
  );

  const hasMultipleActiveModels = activeModels.length > 1;
  const hasActiveModels = activeModels.length > 0;

  const isPreferredModelValid = useMemo(() => {
    if (!preferredModelId) return true;
    return activeModels.some((m) => m.modelName === preferredModelId);
  }, [preferredModelId, activeModels]);

  return {
    activeModels,
    hasMultipleActiveModels,
    hasActiveModels,
    isPreferredModelValid,
  };
}
