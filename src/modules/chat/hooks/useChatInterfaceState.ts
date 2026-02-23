import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { ChannelType, Conversation, Message, MessageAttachment } from '@/shared/domain/types';
import type { QueuedChatMessage } from '@/modules/chat/types';
import { validateAttachmentFile } from '@/modules/chat/uiUtils';
import { getGatewayClient } from '@/modules/gateway/ws-client';

interface UseChatInterfaceStateArgs {
  conversations: Conversation[];
  activeConversationId: string | null;
  activePersonaId?: string | null;
  messages: Message[];
  isTyping?: boolean;
  onSendMessage: (
    content: string,
    platform: ChannelType,
    attachment?: MessageAttachment,
    conversationId?: string,
    personaId?: string,
  ) => void | Promise<void>;
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
  activePersonaId,
  messages,
  isTyping,
  onSendMessage,
}: UseChatInterfaceStateArgs) {
  const [input, setInput] = useState('');
  const [pendingFile, setPendingFile] = useState<MessageAttachment | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<QueuedChatMessage[]>([]);
  const [channelFilter, setChannelFilter] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const sendQueueRef = useRef<
    Array<{
      id: string;
      content: string;
      platform: ChannelType;
      attachment?: MessageAttachment;
      conversationId: string;
      personaId: string | null;
    }>
  >([]);
  const isProcessingQueueRef = useRef(false);
  const isTypingRef = useRef(Boolean(isTyping));

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
    isTypingRef.current = Boolean(isTyping);
    setIsGenerating(
      isTypingRef.current || isProcessingQueueRef.current || sendQueueRef.current.length > 0,
    );
  }, [isTyping]);

  useEffect(() => {
    if (!scrollRef.current) {
      return;
    }

    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages, isTyping, activeConversationId]);

  const syncGeneratingState = useCallback(() => {
    setIsGenerating(
      isTypingRef.current || isProcessingQueueRef.current || sendQueueRef.current.length > 0,
    );
  }, []);

  const syncQueuedMessages = useCallback(() => {
    setQueuedMessages(
      sendQueueRef.current.map((entry) => ({
        id: entry.id,
        content: entry.content,
        attachmentName: entry.attachment?.name,
      })),
    );
  }, []);

  const processQueue = useCallback(async () => {
    if (isProcessingQueueRef.current) return;
    isProcessingQueueRef.current = true;
    syncGeneratingState();

    try {
      while (sendQueueRef.current.length > 0) {
        const next = sendQueueRef.current.shift();
        if (!next) break;
        syncQueuedMessages();
        syncGeneratingState();
        await Promise.resolve(
          onSendMessage(
            next.content,
            next.platform,
            next.attachment,
            next.conversationId,
            next.personaId || undefined,
          ),
        );
      }
    } finally {
      isProcessingQueueRef.current = false;
      syncGeneratingState();
    }
  }, [onSendMessage, syncGeneratingState, syncQueuedMessages]);

  const handleSend = useCallback(() => {
    if ((!input.trim() && !pendingFile) || !activeConversation) {
      return;
    }

    sendQueueRef.current.push({
      id: crypto.randomUUID(),
      content: input,
      platform: activeConversation.channelType,
      attachment: pendingFile || undefined,
      conversationId: activeConversation.id,
      personaId: activeConversation.personaId ?? activePersonaId ?? null,
    });
    syncQueuedMessages();
    syncGeneratingState();
    void processQueue();
    setInput('');
    setPendingFile(null);
    setValidationError(null);
    // Fokus zurück auf das Eingabefeld setzen
    setTimeout(() => {
      textInputRef.current?.focus();
    }, 0);
  }, [
    activeConversation,
    activePersonaId,
    input,
    pendingFile,
    processQueue,
    syncGeneratingState,
    syncQueuedMessages,
  ]);

  // Reset isGenerating when switching conversations
  useEffect(() => {
    sendQueueRef.current = [];
    isProcessingQueueRef.current = false;
    setQueuedMessages([]);
    setIsGenerating(isTypingRef.current);
  }, [activeConversationId]);

  const removeQueuedMessage = useCallback(
    (queueId: string) => {
      const previousLength = sendQueueRef.current.length;
      sendQueueRef.current = sendQueueRef.current.filter((entry) => entry.id !== queueId);
      if (sendQueueRef.current.length === previousLength) return;
      syncQueuedMessages();
      syncGeneratingState();
    },
    [syncGeneratingState, syncQueuedMessages],
  );

  const handleAbort = useCallback(() => {
    if (!activeConversation) return;
    const client = getGatewayClient();
    client.request('chat.abort', { conversationId: activeConversation.id }).catch(() => {
      // If abort fails, just clear the generating state
    });
    isProcessingQueueRef.current = false;
    syncGeneratingState();
  }, [activeConversation, syncGeneratingState]);

  const processFile = useCallback((file: File) => {
    const validationError = validateAttachmentFile(file);
    if (validationError) {
      setValidationError(validationError);
      return;
    }
    setValidationError(null);

    const reader = new FileReader();
    reader.onload = () => {
      setPendingFile({
        name: file.name,
        type: file.type,
        url: reader.result as string,
        size: file.size,
      });
      setValidationError(null);
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
  };
}
