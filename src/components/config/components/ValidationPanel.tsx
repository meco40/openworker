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
  const fieldMeta = validationFieldPath ? getFieldMetadata(validationFieldPath) : null;

  if (!validationError) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-800/40 bg-emerald-950/20 px-4 py-2.5">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-4 w-4 shrink-0 text-emerald-500"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
            clipRule="evenodd"
          />
        </svg>
        <span className="text-xs font-medium text-emerald-400">No schema violations</span>
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="rounded-lg border border-red-800/50 bg-red-950/30 px-4 py-3"
    >
      <div className="mb-1 flex items-center gap-2">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-4 w-4 shrink-0 text-red-400"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z"
            clipRule="evenodd"
          />
        </svg>
        <span className="text-xs font-semibold text-red-300">Validation error</span>
        {fieldMeta && (
          <span className="ml-1 rounded bg-red-900/40 px-1.5 py-0.5 text-[10px] text-red-400">
            {fieldMeta.label}
          </span>
        )}
      </div>
      <p className="font-mono text-xs text-red-400">{validationError}</p>
      {fieldMeta?.helper && (
        <p className="mt-1.5 text-[11px] text-red-600">{fieldMeta.helper}</p>
      )}
    </div>
  );
};
