import React from 'react';

const ChatDragOverlay: React.FC = () => {
  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-violet-500/5 backdrop-blur-sm">
      <div className="flex animate-pulse flex-col items-center space-y-3">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl border-2 border-dashed border-violet-500/40 bg-violet-500/10">
          <svg
            className="h-8 w-8 text-violet-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
            />
          </svg>
        </div>
        <span className="text-xs font-bold tracking-widest text-violet-400 uppercase">
          Datei ablegen
        </span>
      </div>
    </div>
  );
};

export default ChatDragOverlay;
