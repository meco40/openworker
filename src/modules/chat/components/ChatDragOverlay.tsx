import React from 'react';

const ChatDragOverlay: React.FC = () => {
  return (
    <div className="absolute inset-0 z-50 bg-violet-500/5 backdrop-blur-sm flex items-center justify-center pointer-events-none">
      <div className="flex flex-col items-center space-y-3 animate-pulse">
        <div className="w-16 h-16 rounded-2xl bg-violet-500/10 border-2 border-dashed border-violet-500/40 flex items-center justify-center">
          <svg className="w-8 h-8 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
            />
          </svg>
        </div>
        <span className="text-xs font-bold text-violet-400 uppercase tracking-widest">
          Datei ablegen
        </span>
      </div>
    </div>
  );
};

export default ChatDragOverlay;
