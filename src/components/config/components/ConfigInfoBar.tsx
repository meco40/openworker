'use client';

import React from 'react';

interface ConfigInfoBarProps {
  configPath: string;
  configSource: 'default' | 'file' | 'unknown';
  baselineRevision: string;
}

const SOURCE_STYLES: Record<ConfigInfoBarProps['configSource'], string> = {
  file: 'bg-blue-900/40 text-blue-300 border-blue-800/40',
  default: 'bg-zinc-800/60 text-zinc-400 border-zinc-700/40',
  unknown: 'bg-zinc-800/40 text-zinc-600 border-zinc-800/40',
};

export const ConfigInfoBar: React.FC<ConfigInfoBarProps> = ({
  configPath,
  configSource,
  baselineRevision,
}) => {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800/60 bg-zinc-900/60 px-4 py-2">
      {/* Path */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-3 w-3 shrink-0 text-zinc-600"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zm0 10.5a.75.75 0 01.75-.75h7.5a.75.75 0 010 1.5h-7.5a.75.75 0 01-.75-.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10z"
            clipRule="evenodd"
          />
        </svg>
        <span className="truncate font-mono text-[10px] text-zinc-500" title={configPath}>
          {configPath}
        </span>
      </div>

      {/* Source badge */}
      <span
        className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-medium ${SOURCE_STYLES[configSource]}`}
      >
        {configSource === 'unknown' ? 'source: n/a' : `source: ${configSource}`}
      </span>

      {/* Revision */}
      <span className="flex items-center gap-1 font-mono text-[10px] text-zinc-600">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-3 w-3 text-zinc-700"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M10 2a.75.75 0 01.75.75v.258a33.186 33.186 0 016.668 1.539.75.75 0 01-.336 1.461 31.28 31.28 0 00-1.103-.232l1.702 7.545a.75.75 0 01-.387.832A4.981 4.981 0 0115 14c-.825 0-1.606-.2-2.294-.556a.75.75 0 01-.387-.832l1.77-7.849a31.743 31.743 0 00-3.339-.254V15h2.25a.75.75 0 010 1.5h-6a.75.75 0 010-1.5H9V4.509a31.742 31.742 0 00-3.339.254l1.77 7.849a.75.75 0 01-.387.832A4.98 4.98 0 015 14a4.98 4.98 0 01-2.294-.556.75.75 0 01-.387-.832l1.702-7.545c-.37.07-.738.149-1.103.232a.75.75 0 01-.336-1.461 33.186 33.186 0 016.668-1.539V2.75A.75.75 0 0110 2z"
            clipRule="evenodd"
          />
        </svg>
        rev: {baselineRevision || 'n/a'}
      </span>
    </div>
  );
};
