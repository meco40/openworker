
import React from 'react';
import { WorkerArtifact } from '../types';

interface ArtifactViewerProps {
  artifact: WorkerArtifact;
  onClose: () => void;
}

export const ArtifactViewer: React.FC<ArtifactViewerProps> = ({ artifact, onClose }) => {
  return (
    <div className="h-full flex flex-col animate-in zoom-in-95 duration-500">
      <header className="flex items-center justify-between mb-6 shrink-0">
        <div className="flex items-center space-x-4">
          <div className="w-10 h-10 rounded-xl bg-indigo-500/20 flex items-center justify-center text-indigo-400 border border-indigo-500/30">
             {artifact.type === 'code' ? '📄' : '📕'}
          </div>
          <h3 className="text-xl font-bold text-white tracking-tight">{artifact.name}</h3>
        </div>
        <button onClick={onClose} className="w-10 h-10 rounded-xl bg-zinc-900 hover:bg-zinc-800 flex items-center justify-center text-zinc-500 hover:text-white transition-all">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12" strokeWidth="2.5"/></svg>
        </button>
      </header>
      <div className="flex-1 bg-zinc-900 p-10 rounded-3xl border border-zinc-800 font-mono text-xs text-zinc-300 whitespace-pre-wrap overflow-auto">
        {artifact.content}
      </div>
    </div>
  );
};
