import React from 'react';
import type { Conversation } from '../../../../types';
import { getPlatformMeta } from '../uiUtils';
import InboxFilters from './InboxFilters';

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
    <div className="w-64 border-r border-zinc-800 flex flex-col bg-zinc-950/50">
      <div className="h-16 flex items-center justify-between px-4 border-b border-zinc-800">
        <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-widest">Conversations</h3>
        <button
          type="button"
          onClick={onNewConversation}
          title="Neue Conversation"
          className="w-8 h-8 rounded-lg bg-violet-600/10 border border-violet-500/20 flex items-center justify-center text-violet-400 hover:bg-violet-600/20 hover:border-violet-500/40 transition-all active:scale-90"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {conversations.length === 0 && (
          <div className="text-center py-8 px-4">
            <span className="text-[10px] text-zinc-600 uppercase tracking-widest">
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
              className={`w-full text-left px-3 py-3 rounded-xl transition-all ${
                isActive
                  ? 'bg-zinc-800/80 border border-zinc-700 shadow-md'
                  : 'hover:bg-zinc-900/50 border border-transparent'
              }`}
            >
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  onClick={() => onSelectConversation(conversation.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center space-x-2">
                      <span className="text-sm">{meta.icon}</span>
                      <span className={`text-[10px] font-black uppercase tracking-wider ${meta.text}`}>
                        {conversation.channelType}
                      </span>
                    </div>
                    <span className="text-[9px] text-zinc-600 font-mono">
                      {new Date(conversation.updatedAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <div className="text-xs font-medium text-zinc-300 truncate pl-6">
                    {conversation.title || 'Untitled Chat'}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteConversation(conversation.id)}
                  title="Conversation löschen"
                  className="mt-0.5 h-6 w-6 shrink-0 rounded-md border border-zinc-700/80 text-zinc-500 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-300 transition-colors"
                  aria-label={`Delete conversation ${conversation.title}`}
                >
                  <svg className="mx-auto h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
