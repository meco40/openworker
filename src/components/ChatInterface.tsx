import React, { useCallback, useEffect, useState } from 'react';
import type {
  ChatApprovalDecision,
  ChannelType,
  ChatStreamDebugState,
  Conversation,
  Message,
  MessageApprovalRequest,
  MessageAttachment,
} from '@/shared/domain/types';
import ChatConversationList from '@/modules/chat/components/ChatConversationList';
import ChatDragOverlay from '@/modules/chat/components/ChatDragOverlay';
import ChatInputArea from '@/modules/chat/components/ChatInputArea';
import ChatMainPane from '@/modules/chat/components/ChatMainPane';
import { useChatInterfaceState } from '@/modules/chat/hooks/useChatInterfaceState';

interface ChatInterfaceProps {
  conversations: Conversation[];
  activeConversationId: string | null;
  activePersonaId?: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (id: string) => void;
  onDeleteMessage: (message: Message) => void;
  messages: Message[];
  onSendMessage: (
    content: string,
    platform: ChannelType,
    attachment?: MessageAttachment,
    conversationId?: string,
    personaId?: string,
  ) => void | Promise<void>;
  onRespondApproval: (
    message: Message,
    approvalRequest: MessageApprovalRequest,
    decision: ChatApprovalDecision,
  ) => void;
  isTyping?: boolean;
  chatStreamDebug: ChatStreamDebugState;
}

const ChatInterface: React.FC<ChatInterfaceProps> = ({
  conversations,
  activeConversationId,
  activePersonaId,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  onDeleteMessage,
  messages,
  onSendMessage,
  onRespondApproval,
  isTyping,
  chatStreamDebug,
}) => {
  const [mobilePane, setMobilePane] = useState<'list' | 'detail'>('list');

  useEffect(() => {
    if (!activeConversationId) {
      setMobilePane('list');
    }
  }, [activeConversationId]);

  const handleSelectConversation = useCallback(
    (conversationId: string) => {
      onSelectConversation(conversationId);
      setMobilePane('detail');
    },
    [onSelectConversation],
  );

  const handleNewConversation = useCallback(() => {
    void onNewConversation();
    setMobilePane('detail');
  }, [onNewConversation]);

  const handleBackToConversations = useCallback(() => {
    setMobilePane('list');
  }, []);

  const {
    activeConversation,
    input,
    setInput,
    pendingFile,
    setPendingFile,
    validationError,
    isDragOver,
    isGenerating,
    queuedMessages,
    channelFilter,
    setChannelFilter,
    searchQuery,
    setSearchQuery,
    availableChannels,
    visibleConversations,
    scrollRef,
    fileInputRef,
    textInputRef,
    handleSend,
    handleAbort,
    removeQueuedMessage,
    handleFileSelect,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useChatInterfaceState({
    conversations,
    activeConversationId,
    activePersonaId,
    messages,
    isTyping,
    onSendMessage,
  });

  return (
    <div
      className={`relative flex h-full min-h-0 min-w-0 overflow-hidden rounded-2xl border bg-[#0a0a0a] shadow-2xl transition-all ${
        isDragOver ? 'border-violet-500/50 ring-2 ring-violet-500/20' : 'border-zinc-800'
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && <ChatDragOverlay />}

      <div
        className={`flex min-h-0 shrink-0 max-md:w-full ${mobilePane === 'detail' ? 'max-md:hidden' : ''}`}
      >
        <ChatConversationList
          conversations={visibleConversations}
          activeConversationId={activeConversationId}
          onSelectConversation={handleSelectConversation}
          onNewConversation={handleNewConversation}
          onDeleteConversation={onDeleteConversation}
          channelFilter={channelFilter}
          onChannelFilterChange={setChannelFilter}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          availableChannels={availableChannels}
        />
      </div>

      <div
        className={`flex min-h-0 min-w-0 flex-1 flex-col ${mobilePane === 'list' ? 'max-md:hidden' : ''}`}
      >
        <ChatMainPane
          activeConversation={activeConversation}
          messages={messages}
          isTyping={isTyping}
          chatStreamDebug={chatStreamDebug}
          onDeleteMessage={onDeleteMessage}
          onRespondApproval={onRespondApproval}
          scrollRef={scrollRef}
          onBackToConversations={handleBackToConversations}
        />
        <ChatInputArea
          activeConversation={activeConversation}
          input={input}
          pendingFile={pendingFile}
          validationError={validationError}
          queuedMessages={queuedMessages}
          fileInputRef={fileInputRef}
          textInputRef={textInputRef}
          isGenerating={isGenerating}
          onInputChange={setInput}
          onSend={handleSend}
          onAbort={handleAbort}
          onRemoveQueuedMessage={removeQueuedMessage}
          onFileSelect={handleFileSelect}
          onRemovePendingFile={() => setPendingFile(null)}
        />
      </div>
    </div>
  );
};

export default ChatInterface;
