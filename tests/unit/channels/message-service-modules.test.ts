import { describe, expect, it } from 'vitest';

import { statusIconForWorker } from '../../../src/server/channels/messages/statusIcons';
import {
  applyChannelBindingPersona,
  getChannelBindingPersonaId,
  setChannelBindingPersona,
} from '../../../src/server/channels/messages/channelBindingPersona';
import { buildFallbackSummary, isAiSummaryEnabled } from '../../../src/server/channels/messages/summary';
import { ChannelType } from '../../../types';
import type { ChannelKey } from '../../../src/server/channels/adapters/types';
import type { ChannelBinding } from '../../../src/server/channels/messages/channelBindings';

describe('message service extracted modules', () => {
  it('returns status icon with unknown fallback', () => {
    expect(statusIconForWorker('queued')).toBe('⏳');
    expect(statusIconForWorker('unknown')).toBe('❔');
  });

  it('builds fallback summary and trims to max size', () => {
    const result = buildFallbackSummary('prev', [
      { role: 'user', content: 'hello   world' },
      { role: 'agent', content: 'ok' },
    ]);

    expect(result).toContain('[user] hello world');
    expect(result).toContain('[agent] ok');
    expect(result.length).toBeLessThanOrEqual(5000);
  });

  it('detects AI summary mode from env', () => {
    const previous = process.env.CHAT_SUMMARY_MODE;
    process.env.CHAT_SUMMARY_MODE = 'fallback';
    expect(isAiSummaryEnabled()).toBe(false);
    process.env.CHAT_SUMMARY_MODE = 'concat';
    expect(isAiSummaryEnabled()).toBe(false);
    process.env.CHAT_SUMMARY_MODE = 'ai';
    expect(isAiSummaryEnabled()).toBe(true);
    process.env.CHAT_SUMMARY_MODE = previous;
  });

  it('reads and applies channel binding persona', () => {
    const updates: Array<{ conversationId: string; personaId: string | null; userId: string }> = [];
    const bindings = new Map<string, string>([['u1:Telegram', 'persona-1']]);

    const repo = {
      getChannelBinding: (userId: string, channel: ChannelKey): ChannelBinding | null => {
        const key = `${userId}:${channel}`;
        const personaId = bindings.get(key);
        if (!personaId) return null;
        return {
          userId,
          channel,
          status: 'connected',
          externalPeerId: null,
          peerName: null,
          transport: null,
          metadata: null,
          personaId,
          lastSeenAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      },
      updateChannelBindingPersona: (
        userId: string,
        channel: ChannelKey,
        personaId: string | null,
      ) => {
        const key = `${userId}:${channel}`;
        if (personaId) bindings.set(key, personaId);
        else bindings.delete(key);
      },
      updatePersonaId: (conversationId: string, personaId: string | null, userId: string) => {
        updates.push({ conversationId, personaId, userId });
      },
    };

    expect(getChannelBindingPersonaId(repo, 'u1', ChannelType.TELEGRAM)).toBe('persona-1');

    setChannelBindingPersona(repo, 'u1', ChannelType.TELEGRAM, 'persona-2');
    expect(getChannelBindingPersonaId(repo, 'u1', ChannelType.TELEGRAM)).toBe('persona-2');

    const conversation = {
      id: 'c1',
      userId: 'u1',
      channelType: ChannelType.TELEGRAM,
      externalChatId: 'x',
      title: 't',
      modelOverride: null,
      personaId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const updated = applyChannelBindingPersona(repo, conversation, ChannelType.TELEGRAM);
    expect(updated.personaId).toBe('persona-2');
    expect(updates).toHaveLength(1);

    const webchatConversation = { ...conversation, personaId: null };
    const webchatUpdated = applyChannelBindingPersona(repo, webchatConversation, ChannelType.WEBCHAT);
    expect(webchatUpdated).toBe(webchatConversation);
  });
});
