import React from 'react';
import type { ChannelType, Conversation, Message, MessageAttachment } from '../types';
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
  messages: Message[];
  onSendMessage: (content: string, platform: ChannelType, attachment?: MessageAttachment) => void;
  isTyping?: boolean;
}

const ChatInterface: React.FC<ChatInterfaceProps> = ({
  conversations,
  activeConversationId,
  onSelectConversation,
  onNewConversation,
  messages,
  onSendMessage,
  isTyping,
}) => {
  const {
    activeConversation,
    input,
    setInput,
    pendingFile,
    setPendingFile,
    isDragOver,
    scrollRef,
    fileInputRef,
    handleSend,
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
      className={`flex h-full bg-[#0a0a0a] border rounded-2xl overflow-hidden shadow-2xl relative transition-all ${
        isDragOver ? 'border-violet-500/50 ring-2 ring-violet-500/20' : 'border-zinc-800'
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && <ChatDragOverlay />}

      <ChatConversationList
        conversations={conversations}
        activeConversationId={activeConversationId}
        onSelectConversation={onSelectConversation}
        onNewConversation={onNewConversation}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <ChatMainPane
          activeConversation={activeConversation}
          messages={messages}
          isTyping={isTyping}
          scrollRef={scrollRef}
        />
        <ChatInputArea
          activeConversation={activeConversation}
          input={input}
          pendingFile={pendingFile}
          fileInputRef={fileInputRef}
          onInputChange={setInput}
          onSend={handleSend}
          onFileSelect={handleFileSelect}
          onRemovePendingFile={() => setPendingFile(null)}
        />
      </div>
    </div>
  );
};

export default ChatInterface;
