import React from 'react';
import type {
  ChatApprovalDecision,
  ChannelType,
  ChatStreamDebugState,
  Conversation,
  Message,
  MessageApprovalRequest,
  MessageAttachment,
} from '../types';
import ChatConversationList from '../src/modules/chat/components/ChatConversationList';
import ChatDragOverlay from '../src/modules/chat/components/ChatDragOverlay';
import ChatInputArea from '../src/modules/chat/components/ChatInputArea';
import ChatMainPane from '../src/modules/chat/components/ChatMainPane';
import { useChatInterfaceState } from '../src/modules/chat/hooks/useChatInterfaceState';

interface ChatInterfaceProps {
  conversations: Conversation[];
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (id: string) => void;
  messages: Message[];
  onSendMessage: (content: string, platform: ChannelType, attachment?: MessageAttachment) => void;
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
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  messages,
  onSendMessage,
  onRespondApproval,
  isTyping,
  chatStreamDebug,
}) => {
  const {
    activeConversation,
    input,
    setInput,
    pendingFile,
    setPendingFile,
    isDragOver,
    isGenerating,
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
    handleFileSelect,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useChatInterfaceState({
    conversations,
    activeConversationId,
    messages,
    isTyping,
    onSendMessage,
  });

  return (
    <div
      className={`relative flex h-full overflow-hidden rounded-2xl border bg-[#0a0a0a] shadow-2xl transition-all ${
        isDragOver ? 'border-violet-500/50 ring-2 ring-violet-500/20' : 'border-zinc-800'
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && <ChatDragOverlay />}

      <ChatConversationList
        conversations={visibleConversations}
        activeConversationId={activeConversationId}
        onSelectConversation={onSelectConversation}
        onNewConversation={onNewConversation}
        onDeleteConversation={onDeleteConversation}
        channelFilter={channelFilter}
        onChannelFilterChange={setChannelFilter}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        availableChannels={availableChannels}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <ChatMainPane
          activeConversation={activeConversation}
          messages={messages}
          isTyping={isTyping}
          chatStreamDebug={chatStreamDebug}
          onRespondApproval={onRespondApproval}
          scrollRef={scrollRef}
        />
        <ChatInputArea
          activeConversation={activeConversation}
          input={input}
          pendingFile={pendingFile}
          fileInputRef={fileInputRef}
          textInputRef={textInputRef}
          isGenerating={isGenerating}
          onInputChange={setInput}
          onSend={handleSend}
          onAbort={handleAbort}
          onFileSelect={handleFileSelect}
          onRemovePendingFile={() => setPendingFile(null)}
        />
      </div>
    </div>
  );
};

export default ChatInterface;
