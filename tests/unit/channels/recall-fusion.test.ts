import { describe, it, expect } from 'vitest';
import { fuseRecallSources } from '../../../src/server/channels/messages/recallFusion';
import type { StoredMessage } from '../../../src/server/channels/messages/repository';
import { ChannelType } from '../../../types';

function makeChatHit(content: string, daysAgo = 0): StoredMessage {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    conversationId: 'conv-1',
    seq: 1,
    role: 'user',
    content,
    platform: ChannelType.WEBCHAT,
    externalMsgId: null,
    senderName: null,
    metadata: null,
    createdAt: date.toISOString(),
  };
}

describe('fuseRecallSources', () => {
  it('returns null when all sources are empty', () => {
    const result = fuseRecallSources({
      knowledge: null,
      memory: null,
      chatHits: [],
    });
    expect(result).toBeNull();
  });

  it('returns knowledge alone when other sources are empty', () => {
    const result = fuseRecallSources({
      knowledge: 'Episode about office rules from last week.',
      memory: null,
      chatHits: [],
    });
    expect(result).not.toBeNull();
    expect(result).toContain('office rules');
    expect(result).toContain('[Knowledge]');
  });

  it('returns memory alone when other sources are empty', () => {
    const result = fuseRecallSources({
      knowledge: null,
      memory: 'User prefers black coffee.',
      chatHits: [],
    });
    expect(result).not.toBeNull();
    expect(result).toContain('black coffee');
    expect(result).toContain('[Memory]');
  });

  it('returns chat hits alone when other sources are empty', () => {
    const result = fuseRecallSources({
      knowledge: null,
      memory: null,
      chatHits: [makeChatHit('Die Regeln im Office sind: kein Essen am Platz.')],
    });
    expect(result).not.toBeNull();
    expect(result).toContain('Regeln im Office');
    expect(result).toContain('[Chat History]');
  });

  it('fuses all three sources with labeled sections', () => {
    const result = fuseRecallSources({
      knowledge: 'Knowledge about the meeting.',
      memory: 'User prefers morning meetings.',
      chatHits: [makeChatHit('Wir hatten gestern ein Meeting um 9 Uhr.')],
    });
    expect(result).not.toBeNull();
    expect(result).toContain('[Knowledge]');
    expect(result).toContain('[Memory]');
    expect(result).toContain('[Chat History]');
    expect(result).toContain('Knowledge about the meeting');
    expect(result).toContain('morning meetings');
    expect(result).toContain('Meeting um 9 Uhr');
    // Chat History comes first in the fused output
    const chatIdx = result!.indexOf('[Chat History]');
    const knowledgeIdx = result!.indexOf('[Knowledge]');
    const memoryIdx = result!.indexOf('[Memory]');
    expect(chatIdx).toBeLessThan(knowledgeIdx);
    expect(knowledgeIdx).toBeLessThan(memoryIdx);
  });

  it('truncates total output to RECALL_FUSION_TOTAL_BUDGET characters', () => {
    const longKnowledge = 'K'.repeat(3000);
    const longMemory = 'M'.repeat(3000);
    const result = fuseRecallSources({
      knowledge: longKnowledge,
      memory: longMemory,
      chatHits: [makeChatHit('C'.repeat(3000))],
    });
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(5000);
  });

  it('formats chat hits with date', () => {
    const hit = makeChatHit('Office Regeln gelten ab sofort', 3);
    const result = fuseRecallSources({
      knowledge: null,
      memory: null,
      chatHits: [hit],
    });
    expect(result).not.toBeNull();
    // Should contain date in some format
    expect(result).toMatch(/\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2}/);
  });

  it('includes multiple chat hits', () => {
    const result = fuseRecallSources({
      knowledge: null,
      memory: null,
      chatHits: [
        makeChatHit('Erste Regel: pünktlich sein'),
        makeChatHit('Zweite Regel: Laptop mitbringen'),
        makeChatHit('Dritte Regel: Kamera an'),
      ],
    });
    expect(result).not.toBeNull();
    expect(result).toContain('pünktlich');
    expect(result).toContain('Laptop');
    expect(result).toContain('Kamera');
  });
});
