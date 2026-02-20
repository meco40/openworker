import React from 'react';
import type { Conversation } from '@/shared/domain/types';
import { getPlatformMeta } from '@/modules/chat/uiUtils';
import InboxFilters from '@/modules/chat/components/InboxFilters';

interface ChatConversationListProps {
  conversations: Conversation[];
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (id: string) => void;
  channelFilter: string;
  onChannelFilterChange: (value: string) => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  availableChannels: string[];
}

const ChatConversationList: React.FC<ChatConversationListProps> = ({
  conversations,
  activeConversationId,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  channelFilter,
  onChannelFilterChange,
  searchQuery,
  onSearchQueryChange,
  availableChannels,
}) => {
  return (
    <div className="flex w-64 flex-col border-r border-zinc-800 bg-zinc-950/50">
      <div className="flex h-16 items-center justify-between border-b border-zinc-800 px-4">
        <h3 className="text-xs font-bold tracking-widest text-zinc-400 uppercase">Conversations</h3>
        <button
          type="button"
          onClick={onNewConversation}
          title="Neue Conversation"
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-violet-500/20 bg-violet-600/10 text-violet-400 transition-all hover:border-violet-500/40 hover:bg-violet-600/20 active:scale-90"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>
      <InboxFilters
        channels={availableChannels}
        activeChannel={channelFilter}
        searchQuery={searchQuery}
        onChannelChange={onChannelFilterChange}
        onSearchChange={onSearchQueryChange}
      />
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {conversations.length === 0 && (
          <div className="px-4 py-8 text-center">
            <span className="text-[10px] tracking-widest text-zinc-600 uppercase">
              Keine Conversations
            </span>
          </div>
        )}
        {conversations.map((conversation) => {
          const meta = getPlatformMeta(conversation.channelType);
          const isActive = conversation.id === activeConversationId;
          return (
            <div
              key={conversation.id}
              className={`w-full rounded-xl px-3 py-3 text-left transition-all ${
                isActive
                  ? 'border border-zinc-700 bg-zinc-800/80 shadow-md'
                  : 'border border-transparent hover:bg-zinc-900/50'
              }`}
            >
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  onClick={() => onSelectConversation(conversation.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="mb-1 flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <span className="text-sm">{meta.icon}</span>
                      <span
                        className={`text-[10px] font-black tracking-wider uppercase ${meta.text}`}
                      >
                        {conversation.channelType}
                      </span>
                    </div>
                    <span className="font-mono text-[9px] text-zinc-600">
                      {new Date(conversation.updatedAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <div className="truncate pl-6 text-xs font-medium text-zinc-300">
                    {conversation.title || 'Untitled Chat'}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteConversation(conversation.id)}
                  title="Conversation löschen"
                  className="mt-0.5 h-6 w-6 shrink-0 rounded-md border border-zinc-700/80 text-zinc-500 transition-colors hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-300"
                  aria-label={`Delete conversation ${conversation.title}`}
                >
                  <svg
                    className="mx-auto h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 7h12m-9 0V5h6v2m-7 0l1 12h6l1-12"
                    />
                  </svg>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ChatConversationList;
