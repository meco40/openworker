import React from 'react';
import type { Conversation, MessageAttachment } from '../../../../types';
import { ALLOWED_ATTACHMENT_TYPES, formatFileSize } from '../uiUtils';

interface ChatInputAreaProps {
  activeConversation: Conversation | undefined;
  input: string;
  pendingFile: MessageAttachment | null;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  isGenerating?: boolean;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onAbort?: () => void;
  onFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onRemovePendingFile: () => void;
}

const ChatInputArea: React.FC<ChatInputAreaProps> = ({
  activeConversation,
  input,
  pendingFile,
  fileInputRef,
  isGenerating = false,
  onInputChange,
  onSend,
  onAbort,
  onFileSelect,
  onRemovePendingFile,
}) => {
  const canSend = Boolean((input.trim() || pendingFile) && activeConversation);

  return (
    <div className="p-6 bg-zinc-950/80 backdrop-blur-2xl border-t border-zinc-800 z-20">
      {pendingFile && (
        <div className="mb-3 flex items-center space-x-3 bg-zinc-900/80 border border-zinc-700/50 rounded-xl px-3 py-2 animate-in fade-in slide-in-from-bottom-1 duration-200">
          {pendingFile.type.startsWith('image/') ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={pendingFile.url}
              alt={pendingFile.name}
              className="w-12 h-12 rounded-lg object-cover border border-zinc-700/50"
            />
          ) : (
            <div className="w-12 h-12 rounded-lg bg-zinc-800 border border-zinc-700/50 flex items-center justify-center text-xl">
              📎
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-xs text-zinc-300 font-medium truncate">{pendingFile.name}</div>
            <div className="text-[10px] text-zinc-600">{formatFileSize(pendingFile.size)}</div>
          </div>
          <button
            onClick={onRemovePendingFile}
            className="w-7 h-7 rounded-lg bg-zinc-800 hover:bg-red-500/20 border border-zinc-700 hover:border-red-500/30 flex items-center justify-center text-zinc-500 hover:text-red-400 transition-all"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      <div className="relative group">
        <div className="relative flex items-center space-x-2 bg-zinc-900 border border-zinc-800 rounded-xl p-2 pl-3 focus-within:border-zinc-700 transition-all">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={!activeConversation}
            title="Datei anhängen"
            className={`p-2 rounded-lg transition-all shrink-0 ${
              activeConversation
                ? 'text-zinc-500 hover:text-violet-400 hover:bg-violet-500/10'
                : 'text-zinc-700 cursor-not-allowed'
            }`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.8}
                d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
              />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ALLOWED_ATTACHMENT_TYPES.join(',')}
            onChange={onFileSelect}
            className="hidden"
          />

          <input
            type="text"
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && !isGenerating && onSend()}
            placeholder={
              isGenerating
                ? 'KI generiert Antwort...'
                : activeConversation
                  ? `Nachricht an ${activeConversation.channelType}...`
                  : 'Conversation auswählen...'
            }
            disabled={!activeConversation || isGenerating}
            className="flex-1 bg-transparent text-sm text-white focus:outline-none placeholder-zinc-700 font-medium py-2 disabled:opacity-50 disabled:cursor-not-allowed"
          />
          {isGenerating ? (
            <button
              onClick={onAbort}
              className="p-2.5 rounded-lg transition-all shrink-0 bg-red-600 hover:bg-red-500 text-white shadow-lg active:scale-95 animate-pulse"
              title="Generation abbrechen"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="6" width="12" height="12" rx="2" strokeWidth={2} fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button
              onClick={onSend}
              disabled={!canSend}
              className={`p-2.5 rounded-lg transition-all shrink-0 ${
                canSend
                  ? 'bg-violet-600 text-white shadow-lg active:scale-95'
                  : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default ChatInputArea;
