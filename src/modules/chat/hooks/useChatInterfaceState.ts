import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { ChannelType, Conversation, Message, MessageAttachment } from '../../../../types';
import { validateAttachmentFile } from '../uiUtils';
import { getGatewayClient } from '../../gateway/ws-client';

interface UseChatInterfaceStateArgs {
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Message[];
  isTyping?: boolean;
  onSendMessage: (content: string, platform: ChannelType, attachment?: MessageAttachment) => void;
}

export function filterConversations(
  conversations: Conversation[],
  channelFilter: string,
  searchQuery: string,
): Conversation[] {
  const normalizedChannel = channelFilter.trim().toLowerCase();
  const normalizedQuery = searchQuery.trim().toLowerCase();

  return conversations
    .filter((conversation) => {
      if (!normalizedChannel || normalizedChannel === 'all') {
        return true;
      }
      return conversation.channelType.toLowerCase() === normalizedChannel;
    })
    .filter((conversation) => {
      if (!normalizedQuery) {
        return true;
      }
      return conversation.title.toLowerCase().includes(normalizedQuery);
    });
}

export function useChatInterfaceState({
  conversations,
  activeConversationId,
  messages,
  isTyping,
  onSendMessage,
}: UseChatInterfaceStateArgs) {
  const [input, setInput] = useState('');
  const [pendingFile, setPendingFile] = useState<MessageAttachment | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [channelFilter, setChannelFilter] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId),
    [conversations, activeConversationId],
  );

  const availableChannels = useMemo(() => {
    const channelSet = new Set(conversations.map((conversation) => conversation.channelType));
    return ['All', ...Array.from(channelSet)];
  }, [conversations]);

  const visibleConversations = useMemo(
    () => filterConversations(conversations, channelFilter, searchQuery),
    [conversations, channelFilter, searchQuery],
  );

  useEffect(() => {
    if (!scrollRef.current) {
      return;
    }

    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages, isTyping, activeConversationId]);

  const handleSend = useCallback(() => {
    if ((!input.trim() && !pendingFile) || !activeConversation || isGenerating) {
      return;
    }

    setIsGenerating(true);
    onSendMessage(input, activeConversation.channelType, pendingFile || undefined);
    setInput('');
    setPendingFile(null);
  }, [activeConversation, input, onSendMessage, pendingFile, isGenerating]);

  // Reset isGenerating when a new agent message arrives
  useEffect(() => {
    if (messages.length > 0) {
      const last = messages[messages.length - 1];
      if (last.role === 'agent' || last.role === 'system') {
        setIsGenerating(false);
      }
    }
  }, [messages]);

  // Reset isGenerating when switching conversations
  useEffect(() => {
    setIsGenerating(false);
  }, [activeConversationId]);

  const handleAbort = useCallback(() => {
    if (!activeConversation) return;
    const client = getGatewayClient();
    client.request('chat.abort', { conversationId: activeConversation.id }).catch(() => {
      // If abort fails, just clear the generating state
    });
    setIsGenerating(false);
  }, [activeConversation]);

  const processFile = useCallback((file: File) => {
    const validationError = validateAttachmentFile(file);
    if (validationError) {
      alert(validationError);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setPendingFile({
        name: file.name,
        type: file.type,
        url: reader.result as string,
        size: file.size,
      });
    };
    reader.readAsDataURL(file);
  }, []);

  const handleFileSelect = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        processFile(file);
      }
      event.target.value = '';
    },
    [processFile],
  );

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setIsDragOver(false);
      const file = event.dataTransfer.files?.[0];
      if (file) {
        processFile(file);
      }
    },
    [processFile],
  );

  return {
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
    handleSend,
    handleAbort,
    handleFileSelect,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
