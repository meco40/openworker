import { describe, expect, it } from 'vitest';
import type { Conversation, Message, ScheduledTask } from '../../../types';
import {
  appendMessageIfMissing,
  mapConversationApiMessage,
  removeConversationById,
  resolveActiveConversationAfterDeletion,
  upsertConversationActivity,
} from '../../../src/modules/app-shell/runtimeLogic';
import { parseTaskScheduleArgs, markDueTasksTriggered } from '../../../src/modules/app-shell/taskScheduling';

describe('app-shell runtime logic', () => {
  it('parses scheduling arguments only when values are strings', () => {
    expect(parseTaskScheduleArgs(undefined)).toEqual({});
    expect(parseTaskScheduleArgs({ time_iso: 123, message: true })).toEqual({});
    expect(parseTaskScheduleArgs({ time_iso: '2026-02-10T10:00:00.000Z', message: 'Ping' })).toEqual({
      time_iso: '2026-02-10T10:00:00.000Z',
      message: 'Ping',
    });
  });

  it('marks only due pending tasks as triggered', () => {
    const tasks: ScheduledTask[] = [
      {
        id: 'task-1',
        targetTime: '2026-02-10T09:00:00.000Z',
        content: 'Due now',
        platform: 'WebChat' as never,
        status: 'pending',
      },
      {
        id: 'task-2',
        targetTime: '2026-02-10T12:00:00.000Z',
        content: 'Future',
        platform: 'WebChat' as never,
        status: 'pending',
      },
      {
        id: 'task-3',
        targetTime: '2026-02-10T07:00:00.000Z',
        content: 'Already done',
        platform: 'WebChat' as never,
        status: 'triggered',
      },
    ];

    const updated = markDueTasksTriggered(tasks, new Date('2026-02-10T10:00:00.000Z'));

    expect(updated[0].status).toBe('triggered');
    expect(updated[1].status).toBe('pending');
    expect(updated[2].status).toBe('triggered');
  });

  it('maps persisted channel messages to ui messages', () => {
    const mapped = mapConversationApiMessage({
      id: 'msg-1',
      role: 'agent',
      content: 'hello',
      createdAt: '2026-02-10T08:30:00.000Z',
      platform: 'Telegram' as never,
    });

    expect(mapped.id).toBe('msg-1');
    expect(mapped.role).toBe('agent');
    expect(mapped.content).toBe('hello');
    expect(mapped.platform).toBe('Telegram');
    expect(typeof mapped.timestamp).toBe('string');
    expect(mapped.timestamp.length).toBeGreaterThan(0);
  });

  it('appends message only once by id', () => {
    const base: Message[] = [
      {
        id: 'a',
        role: 'user',
        content: 'first',
        timestamp: '10:00',
        platform: 'WebChat' as never,
      },
    ];
    const incoming: Message = {
      id: 'a',
      role: 'agent',
      content: 'duplicate',
      timestamp: '10:01',
      platform: 'WebChat' as never,
    };

    expect(appendMessageIfMissing(base, incoming)).toHaveLength(1);
  });

  it('bumps active conversation to top when message arrives', () => {
    const conversations: Conversation[] = [
      {
        id: 'conv-1',
        channelType: 'WebChat' as never,
        externalChatId: null,
        userId: 'user-a',
        title: 'Chat 1',
        modelOverride: null,
        personaId: null,
        createdAt: '2026-02-10T08:00:00.000Z',
        updatedAt: '2026-02-10T08:00:00.000Z',
      },
      {
        id: 'conv-2',
        channelType: 'Telegram' as never,
        externalChatId: null,
        userId: 'user-a',
        title: 'Chat 2',
        modelOverride: null,
        personaId: null,
        createdAt: '2026-02-10T08:05:00.000Z',
        updatedAt: '2026-02-10T08:05:00.000Z',
      },
    ];

    const updated = upsertConversationActivity(conversations, 'conv-1', '2026-02-10T09:00:00.000Z');

    expect(updated[0].id).toBe('conv-1');
    expect(updated[0].updatedAt).toBe('2026-02-10T09:00:00.000Z');
    expect(updated[1].id).toBe('conv-2');
  });

  it('removes deleted conversation from the list', () => {
    const conversations: Conversation[] = [
      {
        id: 'conv-1',
        channelType: 'WebChat' as never,
        externalChatId: null,
        userId: 'user-a',
        title: 'Chat 1',
        modelOverride: null,
        personaId: null,
        createdAt: '2026-02-10T08:00:00.000Z',
        updatedAt: '2026-02-10T08:00:00.000Z',
      },
      {
        id: 'conv-2',
        channelType: 'Telegram' as never,
        externalChatId: null,
        userId: 'user-a',
        title: 'Chat 2',
        modelOverride: null,
        personaId: null,
        createdAt: '2026-02-10T08:05:00.000Z',
        updatedAt: '2026-02-10T08:05:00.000Z',
      },
    ];

    const updated = removeConversationById(conversations, 'conv-1');
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe('conv-2');
  });

  it('selects next active conversation after deleting the active one', () => {
    const conversations: Conversation[] = [
      {
        id: 'conv-1',
        channelType: 'WebChat' as never,
        externalChatId: null,
        userId: 'user-a',
        title: 'Chat 1',
        modelOverride: null,
        personaId: null,
        createdAt: '2026-02-10T08:00:00.000Z',
        updatedAt: '2026-02-10T08:00:00.000Z',
      },
      {
        id: 'conv-2',
        channelType: 'Telegram' as never,
        externalChatId: null,
        userId: 'user-a',
        title: 'Chat 2',
        modelOverride: null,
        personaId: null,
        createdAt: '2026-02-10T08:05:00.000Z',
        updatedAt: '2026-02-10T08:05:00.000Z',
      },
    ];

    const remaining = removeConversationById(conversations, 'conv-1');
    const nextActive = resolveActiveConversationAfterDeletion(remaining, 'conv-1', 'conv-1');
    expect(nextActive).toBe('conv-2');
  });

  it('returns null active conversation if last conversation gets deleted', () => {
    const conversations: Conversation[] = [
      {
        id: 'conv-1',
        channelType: 'WebChat' as never,
        externalChatId: null,
        userId: 'user-a',
        title: 'Chat 1',
        modelOverride: null,
        personaId: null,
        createdAt: '2026-02-10T08:00:00.000Z',
        updatedAt: '2026-02-10T08:00:00.000Z',
      },
    ];

    const remaining = removeConversationById(conversations, 'conv-1');
    const nextActive = resolveActiveConversationAfterDeletion(remaining, 'conv-1', 'conv-1');
    expect(nextActive).toBeNull();
  });

  it('selects first conversation if no active conversation is set', () => {
    const conversations: Conversation[] = [
      {
        id: 'conv-2',
        channelType: 'Telegram' as never,
        externalChatId: null,
        userId: 'user-a',
        title: 'Chat 2',
        modelOverride: null,
        personaId: null,
        createdAt: '2026-02-10T08:05:00.000Z',
        updatedAt: '2026-02-10T08:05:00.000Z',
      },
    ];

    const nextActive = resolveActiveConversationAfterDeletion(conversations, null, 'conv-1');
    expect(nextActive).toBe('conv-2');
  });
});

