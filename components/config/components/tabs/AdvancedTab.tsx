'use client';

import React from 'react';

interface AdvancedTabProps {
  config: string;
  isLoading: boolean;
  onChange: (value: string) => void;
}

export const AdvancedTab: React.FC<AdvancedTabProps> = ({ config, isLoading, onChange }) => {
  return (
    <textarea
      aria-label="Advanced JSON editor"
      value={config}
      onChange={(event) => onChange(event.target.value)}
      spellCheck={false}
      disabled={isLoading}
      className="min-h-[420px] w-full resize-y rounded border border-zinc-800 bg-transparent p-4 font-mono text-sm text-indigo-300 focus:outline-none disabled:opacity-60"
    />
  );
};
