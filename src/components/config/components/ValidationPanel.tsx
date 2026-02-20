'use client';

import React from 'react';
import { getFieldMetadata } from '@/shared/config/fieldMetadata';

interface ValidationPanelProps {
  validationError: string | null;
  validationFieldPath: string | null;
}

export const ValidationPanel: React.FC<ValidationPanelProps> = ({
  validationError,
  validationFieldPath,
}) => {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <h4 className="mb-2 text-[10px] font-bold text-zinc-500 uppercase">Validation</h4>
      {validationError ? (
        <div className="font-mono text-xs text-rose-400">
          [ERROR] {validationError}
          {validationFieldPath && getFieldMetadata(validationFieldPath)
            ? ` | Field: ${getFieldMetadata(validationFieldPath)?.label}`
            : ''}
        </div>
      ) : (
        <div className="font-mono text-xs text-emerald-500">[OK] No schema violations found.</div>
      )}
    </div>
  );
};
