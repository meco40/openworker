'use client';

import React from 'react';

interface ConfigInfoBarProps {
  configPath: string;
  configSource: 'default' | 'file' | 'unknown';
  baselineRevision: string;
}

export const ConfigInfoBar: React.FC<ConfigInfoBarProps> = ({
  configPath,
  configSource,
  baselineRevision,
}) => {
  return (
    <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-4 py-2">
      <span className="font-mono text-[10px] text-zinc-500">{configPath}</span>
      <div className="flex items-center space-x-4">
        <span className="font-mono text-[10px] text-zinc-500 uppercase">
          Source: {configSource === 'unknown' ? 'n/a' : configSource}
        </span>
        <span className="font-mono text-[10px] text-zinc-500 uppercase">
          Revision: {baselineRevision || 'n/a'}
        </span>
      </div>
    </div>
  );
};
