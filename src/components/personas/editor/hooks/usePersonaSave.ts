'use client';

import { useCallback } from 'react';

interface UsePersonaSaveProps {
  saveMeta: () => void;
  saveFile: () => void;
  onPreferredModelChange: (modelId: string | null) => void;
}

export function usePersonaSave({
  saveMeta,
  saveFile,
  onPreferredModelChange,
}: UsePersonaSaveProps) {
  const handleSaveMeta = useCallback(() => {
    saveMeta();
  }, [saveMeta]);

  const handleSaveFile = useCallback(() => {
    saveFile();
  }, [saveFile]);

  const handleSavePreferredModel = useCallback(
    (modelId: string | null) => {
      onPreferredModelChange(modelId);
    },
    [onPreferredModelChange],
  );

  return {
    handleSaveMeta,
    handleSaveFile,
    handleSavePreferredModel,
  };
}
