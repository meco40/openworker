'use client';

import React from 'react';

interface ExportButtonProps {
  onExport?: () => void;
  format?: 'json' | 'csv';
  disabled?: boolean;
}

export const ExportButton: React.FC<ExportButtonProps> = ({
  onExport,
  format = 'json',
  disabled = false,
}) => {
  if (!onExport) return null;

  return (
    <button
      type="button"
      onClick={onExport}
      disabled={disabled}
      className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[11px] font-bold text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
    >
      Export {format.toUpperCase()}
    </button>
  );
};
