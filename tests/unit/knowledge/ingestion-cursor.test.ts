import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelType } from '../../../types';
import { SqliteMessageRepository } from '../../../src/server/channels/messages/sqliteMessageRepository';
import { SqliteKnowledgeRepository } from '../../../src/server/knowledge/sqliteKnowledgeRepository';
import {
  TranscriptIngestionCursor,
  type TranscriptCursorScope,
} from '../../../src/server/knowledge/ingestionCursor';
import type { KnowledgeIngestionCheckpoint } from '../../../src/server/knowledge/repository';
import type { StoredMessage } from '../../../src/server/channels/messages/repository';

describe('TranscriptIngestionCursor', () => {
  let messageRepository: SqliteMessageRepository;
  let knowledgeRepository: SqliteKnowledgeRepository;
  let cursor: TranscriptIngestionCursor;

  beforeEach(() => {
    messageRepository = new SqliteMessageRepository(':memory:');
    knowledgeRepository = new SqliteKnowledgeRepository(':memory:');
    cursor = new TranscriptIngestionCursor({
      messageRepository,
      knowledgeRepository,
    });
  });

  afterEach(() => {
    messageRepository.close();
    knowledgeRepository.close();
  });

  function createScope(userId = 'user-a', personaId = 'persona-a'): TranscriptCursorScope {
    const conversation = messageRepository.createConversation({
      channelType: ChannelType.WEBCHAT,
      externalChatId: `${userId}-${personaId}-${Date.now()}`,
      title: 'Cursor Test',
      userId,
      personaId,
    });
    return {
      userId,
      personaId,
      conversationId: conversation.id,
    };
  }

  function appendMessages(scope: TranscriptCursorScope, count: number): void {
    for (let index = 0; index < count; index += 1) {
      messageRepository.saveMessage({
        conversationId: scope.conversationId,
        role: 'user',
        content: `Message ${index + 1}`,
        platform: ChannelType.WEBCHAT,
      });
    }
  }

  it('fetches only messages after the last processed seq and sorts by seq', () => {
    const scope = createScope();
    appendMessages(scope, 4);

    knowledgeRepository.upsertIngestionCheckpoint({
      userId: scope.userId,
      personaId: scope.personaId,
      conversationId: scope.conversationId,
      lastProcessedSeq: 2,
      updatedAt: '2026-02-15T10:00:00.000Z',
    });

    const window = cursor.getWindow(scope, 50);

    expect(window.fromSeqExclusive).toBe(2);
    expect(window.messages.map((message) => message.seq)).toEqual([3, 4]);
    expect(window.toSeqInclusive).toBe(4);
  });

  it('advances checkpoints atomically and idempotently without regressing seq', () => {
    const scope = createScope();

    const first = cursor.advanceCheckpoint(scope, 5, '2026-02-15T10:00:00.000Z');
    const second = cursor.advanceCheckpoint(scope, 3, '2026-02-15T11:00:00.000Z');
    const third = cursor.advanceCheckpoint(scope, 5, '2026-02-15T12:00:00.000Z');
    const fourth = cursor.advanceCheckpoint(scope, 9, '2026-02-15T13:00:00.000Z');

    expect(first.lastProcessedSeq).toBe(5);
    expect(second.lastProcessedSeq).toBe(5);
    expect(third.lastProcessedSeq).toBe(5);
    expect(fourth.lastProcessedSeq).toBe(9);
  });

  it('does not re-process duplicate messages across repeated ingestion runs', () => {
    const scope = createScope();
    appendMessages(scope, 3);

    const firstRun = cursor.ingest(scope, 50);
    const secondRun = cursor.ingest(scope, 50);

    messageRepository.saveMessage({
      conversationId: scope.conversationId,
      role: 'user',
      content: 'Message 4',
      platform: ChannelType.WEBCHAT,
    });
    const thirdRun = cursor.ingest(scope, 50);

    expect(firstRun.messages.map((message) => message.seq)).toEqual([1, 2, 3]);
    expect(secondRun.messages).toEqual([]);
    expect(thirdRun.messages.map((message) => message.seq)).toEqual([4]);
  });

  it('applies deterministic seq-ordered ingestion windows', () => {
    const scope = createScope();
    appendMessages(scope, 5);

    const firstRun = cursor.ingest(scope, 2);
    const secondRun = cursor.ingest(scope, 2);
    const thirdRun = cursor.ingest(scope, 2);

    expect(firstRun.messages.map((message) => message.seq)).toEqual([1, 2]);
    expect(secondRun.messages.map((message) => message.seq)).toEqual([3, 4]);
    expect(thirdRun.messages.map((message) => message.seq)).toEqual([5]);

    const checkpoint = knowledgeRepository.getIngestionCheckpoint(
      scope.userId,
      scope.personaId,
      scope.conversationId,
    );
    expect(checkpoint?.lastProcessedSeq).toBe(5);
  });

  it('keys checkpoints by conversation_id + persona_id + user_id scope', () => {
    const conversationId = 'conversation-shared';

    cursor.advanceCheckpoint(
      { userId: 'user-a', personaId: 'persona-a', conversationId },
      7,
      '2026-02-15T10:00:00.000Z',
    );
    cursor.advanceCheckpoint(
      { userId: 'user-a', personaId: 'persona-b', conversationId },
      3,
      '2026-02-15T11:00:00.000Z',
    );
    cursor.advanceCheckpoint(
      { userId: 'user-b', personaId: 'persona-a', conversationId },
      5,
      '2026-02-15T12:00:00.000Z',
    );

    expect(
      knowledgeRepository.getIngestionCheckpoint('user-a', 'persona-a', conversationId)
        ?.lastProcessedSeq,
    ).toBe(7);
    expect(
      knowledgeRepository.getIngestionCheckpoint('user-a', 'persona-b', conversationId)
        ?.lastProcessedSeq,
    ).toBe(3);
    expect(
      knowledgeRepository.getIngestionCheckpoint('user-b', 'persona-a', conversationId)
        ?.lastProcessedSeq,
    ).toBe(5);
  });

  it('uses listMessagesAfterSeq helper path and normalizes invalid limits', () => {
    let checkpoint: KnowledgeIngestionCheckpoint = {
      userId: 'user-a',
      personaId: 'persona-a',
      conversationId: 'conv-helper',
      lastProcessedSeq: 1,
      createdAt: '2026-02-15T09:00:00.000Z',
      updatedAt: '2026-02-15T09:00:00.000Z',
    };
    const helperLimits: number[] = [];

    const fakeMessages: StoredMessage[] = [
      {
        id: 'm-4',
        conversationId: 'conv-helper',
        seq: 4,
        role: 'user',
        content: 'four',
        platform: ChannelType.WEBCHAT,
        externalMsgId: null,
        senderName: null,
        metadata: null,
        createdAt: '2026-02-15T09:00:04.000Z',
      },
      {
        id: 'm-2',
        conversationId: 'conv-helper',
        seq: 2,
        role: 'user',
        content: 'two',
        platform: ChannelType.WEBCHAT,
        externalMsgId: null,
        senderName: null,
        metadata: null,
        createdAt: '2026-02-15T09:00:02.000Z',
      },
      {
        id: 'm-3',
        conversationId: 'conv-helper',
        seq: 3,
        role: 'user',
        content: 'three',
        platform: ChannelType.WEBCHAT,
        externalMsgId: null,
        senderName: null,
        metadata: null,
        createdAt: '2026-02-15T09:00:03.000Z',
      },
    ];

    const fakeMessageRepository = {
      listMessages: () => {
        throw new Error('listMessages fallback should not be used when helper is available');
      },
      listMessagesAfterSeq: (
        _conversationId: string,
        _afterSeq: number,
        limit?: number,
      ): StoredMessage[] => {
        helperLimits.push(limit || 0);
        return fakeMessages;
      },
    };

    const fakeKnowledgeRepository = {
      getIngestionCheckpoint: () => checkpoint,
      upsertIngestionCheckpoint: ({
        userId,
        personaId,
        conversationId,
        lastProcessedSeq,
        updatedAt,
      }: {
        userId: string;
        personaId: string;
        conversationId: string;
        lastProcessedSeq: number;
        updatedAt?: string;
      }): KnowledgeIngestionCheckpoint => {
        checkpoint = {
          ...checkpoint,
          userId,
          personaId,
          conversationId,
          lastProcessedSeq,
          updatedAt: updatedAt || checkpoint.updatedAt,
        };
        return checkpoint;
      },
    };

    const helperCursor = new TranscriptIngestionCursor({
      messageRepository: fakeMessageRepository,
      knowledgeRepository: fakeKnowledgeRepository,
    });

    const limitedWindow = helperCursor.getWindow(
      { userId: 'user-a', personaId: 'persona-a', conversationId: 'conv-helper' },
      2,
    );
    const invalidLimitWindow = helperCursor.getWindow(
      { userId: 'user-a', personaId: 'persona-a', conversationId: 'conv-helper' },
      Number.NaN,
    );

    expect(limitedWindow.messages.map((message) => message.seq)).toEqual([2, 3]);
    expect(invalidLimitWindow.messages.map((message) => message.seq)).toEqual([2, 3, 4]);
    expect(helperLimits).toEqual([2, 200]);
  });
});
