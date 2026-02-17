'use client';

import React from 'react';
import type { ConfigWarning } from '../../types';

interface OverviewTabProps {
  configSource: 'default' | 'file' | 'unknown';
  hasChanges: boolean;
  compatibilityWarnings: ConfigWarning[];
}

export const OverviewTab: React.FC<OverviewTabProps> = ({
  configSource,
  hasChanges,
  compatibilityWarnings,
}) => {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <div className="rounded border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="mb-1 text-[10px] tracking-widest text-zinc-500 uppercase">Config Source</div>
        <div className="font-mono text-sm text-zinc-200">{configSource}</div>
      </div>
      <div className="rounded border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="mb-1 text-[10px] tracking-widest text-zinc-500 uppercase">Pending Changes</div>
        <div className="font-mono text-sm text-zinc-200">{hasChanges ? 'yes' : 'no'}</div>
      </div>
      <div className="rounded border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="mb-1 text-[10px] tracking-widest text-zinc-500 uppercase">Warnings</div>
        <div className="font-mono text-sm text-zinc-200">{compatibilityWarnings.length}</div>
      </div>
    </div>
  );
};
