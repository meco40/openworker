import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Conversation, MessageAttachment } from '@/shared/domain/types';
import { ChannelType } from '@/shared/domain/types';
import ChatInputArea from '@/modules/chat/components/ChatInputArea';

function buildConversation(): Conversation {
  return {
    id: 'conv-1',
    channelType: ChannelType.WEBCHAT,
    externalChatId: 'default',
    title: 'WebChat',
    userId: 'legacy-local-user',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    modelOverride: null,
    personaId: null,
  };
}

describe('ChatInputArea', () => {
  it('keeps text input enabled while generation is running', () => {
    const html = renderToStaticMarkup(
      createElement(ChatInputArea, {
        activeConversation: buildConversation(),
        input: 'queued message',
        pendingFile: null as MessageAttachment | null,
        fileInputRef: createRef<HTMLInputElement>(),
        textInputRef: createRef<HTMLInputElement>(),
        isGenerating: true,
        onInputChange: vi.fn(),
        onSend: vi.fn(),
        onAbort: vi.fn(),
        onFileSelect: vi.fn(),
        onRemovePendingFile: vi.fn(),
      }),
    );

    expect(html).toContain('KI generiert Antwort...');
    expect(html).toContain('type="text"');
    expect(html).not.toContain('type="text" disabled=""');
    expect(html).toContain('Generation abbrechen');
  });

  it('renders queued messages with remove action', () => {
    const html = renderToStaticMarkup(
      createElement(ChatInputArea, {
        activeConversation: buildConversation(),
        input: '',
        pendingFile: null as MessageAttachment | null,
        queuedMessages: [
          { id: 'q1', content: 'erste nachricht' },
          { id: 'q2', content: '', attachmentName: 'note.txt' },
        ],
        fileInputRef: createRef<HTMLInputElement>(),
        textInputRef: createRef<HTMLInputElement>(),
        isGenerating: true,
        onInputChange: vi.fn(),
        onSend: vi.fn(),
        onAbort: vi.fn(),
        onRemoveQueuedMessage: vi.fn(),
        onFileSelect: vi.fn(),
        onRemovePendingFile: vi.fn(),
      }),
    );

    expect(html).toContain('Warteschlange: 2');
    expect(html).toContain('erste nachricht');
    expect(html).toContain('note.txt');
    expect(html).toContain('Entfernen');
  });

  it('renders inline validation error when provided', () => {
    const html = renderToStaticMarkup(
      createElement(ChatInputArea, {
        activeConversation: buildConversation(),
        input: '',
        pendingFile: null as MessageAttachment | null,
        validationError: 'Datei ist zu groß',
        fileInputRef: createRef<HTMLInputElement>(),
        textInputRef: createRef<HTMLInputElement>(),
        isGenerating: false,
        onInputChange: vi.fn(),
        onSend: vi.fn(),
        onAbort: vi.fn(),
        onFileSelect: vi.fn(),
        onRemovePendingFile: vi.fn(),
      }),
    );

    expect(html).toContain('Datei ist zu groß');
    expect(html).toContain('role="alert"');
  });
});
