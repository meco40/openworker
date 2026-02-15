import React from 'react';
import type { Conversation, MessageAttachment } from '../../../../types';
import { ALLOWED_ATTACHMENT_TYPES, formatFileSize } from '../uiUtils';

interface ChatInputAreaProps {
  activeConversation: Conversation | undefined;
  input: string;
  pendingFile: MessageAttachment | null;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  textInputRef?: React.RefObject<HTMLInputElement | null>;
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
  textInputRef,
  isGenerating = false,
  onInputChange,
  onSend,
  onAbort,
  onFileSelect,
  onRemovePendingFile,
}) => {
  const canSend = Boolean((input.trim() || pendingFile) && activeConversation);

  return (
    <div className="z-20 border-t border-zinc-800 bg-zinc-950/80 p-6 backdrop-blur-2xl">
      {pendingFile && (
        <div className="animate-in fade-in slide-in-from-bottom-1 mb-3 flex items-center space-x-3 rounded-xl border border-zinc-700/50 bg-zinc-900/80 px-3 py-2 duration-200">
          {pendingFile.type.startsWith('image/') ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={pendingFile.url}
              alt={pendingFile.name}
              className="h-12 w-12 rounded-lg border border-zinc-700/50 object-cover"
            />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-zinc-700/50 bg-zinc-800 text-xl">
              📎
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-zinc-300">{pendingFile.name}</div>
            <div className="text-[10px] text-zinc-600">{formatFileSize(pendingFile.size)}</div>
          </div>
          <button
            onClick={onRemovePendingFile}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-500 transition-all hover:border-red-500/30 hover:bg-red-500/20 hover:text-red-400"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      )}

      <div className="group relative">
        <div className="relative flex items-center space-x-2 rounded-xl border border-zinc-800 bg-zinc-900 p-2 pl-3 transition-all focus-within:border-zinc-700">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={!activeConversation}
            title="Datei anhängen"
            className={`shrink-0 rounded-lg p-2 transition-all ${
              activeConversation
                ? 'text-zinc-500 hover:bg-violet-500/10 hover:text-violet-400'
                : 'cursor-not-allowed text-zinc-700'
            }`}
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
            ref={textInputRef}
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
            className="flex-1 bg-transparent py-2 text-sm font-medium text-white placeholder-zinc-700 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
          {isGenerating ? (
            <button
              onClick={onAbort}
              className="shrink-0 animate-pulse rounded-lg bg-red-600 p-2.5 text-white shadow-lg transition-all hover:bg-red-500 active:scale-95"
              title="Generation abbrechen"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <rect
                  x="6"
                  y="6"
                  width="12"
                  height="12"
                  rx="2"
                  strokeWidth={2}
                  fill="currentColor"
                />
              </svg>
            </button>
          ) : (
            <button
              onClick={onSend}
              disabled={!canSend}
              className={`shrink-0 rounded-lg p-2.5 transition-all ${
                canSend
                  ? 'bg-violet-600 text-white shadow-lg active:scale-95'
                  : 'cursor-not-allowed bg-zinc-800 text-zinc-600'
              }`}
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
