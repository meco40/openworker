import { describe, expect, it, vi } from 'vitest';
import { buildKnowledgeExtractionPrompt } from '@/server/knowledge/prompts';
import { KnowledgeExtractor, type KnowledgeExtractionInput } from '@/server/knowledge/extractor';
import type { StoredMessage } from '@/server/channels/messages/repository';

function makeMsg(seq: number, role: string, content: string): StoredMessage {
  return {
    id: `msg-${seq}`,
    conversationId: 'conv-1',
    role,
    content,
    seq,
    createdAt: '2026-02-16T14:00:00Z',
  } as StoredMessage;
}

describe('Event extraction prompt', () => {
  it('prompt includes event extraction schema', () => {
    const input = {
      conversationId: 'conv-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      messages: [makeMsg(10, 'agent', 'Ich habe die letzten zwei Tage mit Max geschlafen')],
    };

    const prompt = buildKnowledgeExtractionPrompt(input, { name: 'Nata' });

    expect(prompt).toContain('events');
    expect(prompt).toContain('eventType');
    expect(prompt).toContain('speakerRole');
    expect(prompt).toContain('counterpart');
    expect(prompt).toContain('timeExpression');
    expect(prompt).toContain('dayCount');
    expect(prompt).toContain('isConfirmation');
    expect(prompt).toContain('sourceSeq');
  });

  it('prompt lists known event types', () => {
    const input = {
      conversationId: 'conv-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      messages: [makeMsg(10, 'agent', 'Test')],
    };

    const prompt = buildKnowledgeExtractionPrompt(input, { name: 'Nata' });

    expect(prompt).toContain('shared_sleep');
    expect(prompt).toContain('visit');
    expect(prompt).toContain('trip');
    expect(prompt).toContain('meeting');
  });
});

describe('Event extraction from LLM response', () => {
  it('extracts events from model response', async () => {
    const messages = [
      makeMsg(10, 'agent', 'Ich habe die letzten zwei Tage mit Max geschlafen'),
      makeMsg(11, 'user', 'Ok, cool'),
    ];

    const input: KnowledgeExtractionInput = {
      conversationId: 'conv-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      messages,
      personaContext: { name: 'Nata' },
    };

    const modelResponse = JSON.stringify({
      facts: ['Nata hat mit Max geschlafen'],
      teaser: Array(20).fill('teaser kontext').join(' '),
      episode: Array(100).fill('episode detail').join(' '),
      meetingLedger: {
        topicKey: 'nata-max',
        counterpart: 'Max',
        participants: ['Nata', 'Max'],
        decisions: [],
        negotiatedTerms: [],
        openPoints: [],
        actionItems: [],
        sourceRefs: [{ seq: 10, quote: 'Ich habe mit Max geschlafen' }],
        confidence: 0.9,
      },
      events: [
        {
          eventType: 'shared_sleep',
          speakerRole: 'assistant',
          subject: 'Nata',
          counterpart: 'Max',
          relationLabel: 'Bruder',
          timeExpression: 'die letzten zwei Tage',
          dayCount: 2,
          isConfirmation: false,
          confirmationSignals: [],
          sourceSeq: [10],
        },
      ],
    });

    const extractor = new KnowledgeExtractor({
      runExtractionModel: vi.fn().mockResolvedValue(modelResponse),
    });

    const result = await extractor.extract(input);

    expect(result.events).toBeDefined();
    expect(result.events).toHaveLength(1);
    expect(result.events[0].eventType).toBe('shared_sleep');
    expect(result.events[0].counterpart).toBe('Max');
    expect(result.events[0].sourceSeq).toEqual([10]);
    // Dates should be resolved by EventExtractor.normalizeEvents
    expect(result.events[0].startDate).toBeTruthy();
    expect(result.events[0].endDate).toBeTruthy();
  });

  it('returns empty events array when LLM provides no events', async () => {
    const messages = [makeMsg(10, 'user', 'Hallo')];

    const modelResponse = JSON.stringify({
      facts: ['Begruessungsnachricht'],
      teaser: Array(20).fill('teaser kontext').join(' '),
      episode: Array(100).fill('episode detail').join(' '),
      meetingLedger: {
        topicKey: 'general',
        counterpart: null,
        participants: [],
        decisions: [],
        negotiatedTerms: [],
        openPoints: [],
        actionItems: [],
        sourceRefs: [],
        confidence: 0.3,
      },
    });

    const extractor = new KnowledgeExtractor({
      runExtractionModel: vi.fn().mockResolvedValue(modelResponse),
    });

    const result = await extractor.extract({
      conversationId: 'conv-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      messages,
    });

    expect(result.events).toBeDefined();
    expect(result.events).toHaveLength(0);
  });

  it('normalizes speaker role against message.role', async () => {
    const messages = [makeMsg(10, 'user', 'Ich habe mit Max geschlafen')];

    const modelResponse = JSON.stringify({
      facts: ['User hat mit Max geschlafen'],
      teaser: Array(20).fill('teaser kontext').join(' '),
      episode: Array(100).fill('episode detail').join(' '),
      meetingLedger: {
        topicKey: 'general',
        counterpart: 'Max',
        participants: ['User', 'Max'],
        decisions: [],
        negotiatedTerms: [],
        openPoints: [],
        actionItems: [],
        sourceRefs: [{ seq: 10, quote: 'Ich habe mit Max geschlafen' }],
        confidence: 0.8,
      },
      events: [
        {
          eventType: 'shared_sleep',
          speakerRole: 'assistant', // LLM incorrectly says assistant
          subject: 'User',
          counterpart: 'Max',
          relationLabel: null,
          timeExpression: 'unbekannt',
          dayCount: 1,
          isConfirmation: false,
          confirmationSignals: [],
          sourceSeq: [10],
        },
      ],
    });

    const extractor = new KnowledgeExtractor({
      runExtractionModel: vi.fn().mockResolvedValue(modelResponse),
    });

    const result = await extractor.extract({
      conversationId: 'conv-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      messages,
      personaContext: { name: 'Nata' },
    });

    expect(result.events).toHaveLength(1);
    // Should be corrected to 'user' because message at seq:10 has role='user'
    expect(result.events[0].speakerRole).toBe('user');
  });

  it('fallback returns empty events array', async () => {
    // No runExtractionModel → fallback path
    const extractor = new KnowledgeExtractor();
    const result = await extractor.extract({
      conversationId: 'conv-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      messages: [makeMsg(10, 'user', 'Hallo Nata, wie geht es dir?')],
    });

    expect(result.events).toBeDefined();
    expect(result.events).toHaveLength(0);
  });
});
