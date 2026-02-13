import React from 'react';
import { WorkerArtifact } from '../types';

interface ArtifactViewerProps {
  artifact: WorkerArtifact;
  onClose: () => void;
}

export const ArtifactViewer: React.FC<ArtifactViewerProps> = ({ artifact, onClose }) => {
  return (
    <div className="animate-in zoom-in-95 flex h-full flex-col duration-500">
      <header className="mb-6 flex shrink-0 items-center justify-between">
        <div className="flex items-center space-x-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-indigo-500/30 bg-indigo-500/20 text-indigo-400">
            {artifact.type === 'code' ? '📄' : '📕'}
          </div>
          <h3 className="text-xl font-bold tracking-tight text-white">{artifact.name}</h3>
        </div>
        <button
          onClick={onClose}
          className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-900 text-zinc-500 transition-all hover:bg-zinc-800 hover:text-white"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path d="M6 18L18 6M6 6l12 12" strokeWidth="2.5" />
          </svg>
        </button>
      </header>
      <div className="flex-1 overflow-auto rounded-3xl border border-zinc-800 bg-zinc-900 p-10 font-mono text-xs whitespace-pre-wrap text-zinc-300">
        {artifact.content}
      </div>
    </div>
  );
};
