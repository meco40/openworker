import { describe, expect, it } from 'vitest';
import type { StoredMessage } from '../../../src/server/channels/messages/repository';
import { KnowledgeExtractor } from '../../../src/server/knowledge/extractor';

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function buildMeetingTranscript(): StoredMessage[] {
  const rows = [
    'Wir starten das Meeting mit Andreas um 09:00 Uhr.',
    'Wir verhandeln einen Rahmenvertrag fuer 12 Monate.',
    'Andreas bietet 5 Prozent Rabatt, wir fordern 8 Prozent.',
    'Nach Ruecksprache einigen wir uns auf 8 Prozent Rabatt.',
    'Offen bleibt die finale SLA-Abnahme bis naechste Woche.',
    'Andreas sendet den Vertragsentwurf bis Freitag.',
  ];

  return rows.map((content, index) => ({
    id: `msg-${index + 1}`,
    conversationId: 'conv-1',
    seq: index + 1,
    role: index % 2 === 0 ? 'user' : 'agent',
    content,
    platform: 'WebChat' as never,
    externalMsgId: null,
    senderName: null,
    metadata: null,
    createdAt: new Date(2025, 7, 1, 9, index).toISOString(),
  }));
}

describe('KnowledgeExtractor', () => {
  it('returns facts teaser episode and meeting ledger from valid model JSON', async () => {
    const teaser = Array.from({ length: 90 }, (_, idx) => `teaser${idx + 1}`).join(' ');
    const episode = Array.from({ length: 450 }, (_, idx) => `episode${idx + 1}`).join(' ');

    const extractor = new KnowledgeExtractor({
      runExtractionModel: async () =>
        JSON.stringify({
          facts: ['8% Rabatt vereinbart', 'SLA-Abnahme offen'],
          teaser,
          episode,
          meetingLedger: {
            topicKey: 'meeting-andreas-vertrag',
            counterpart: 'Andreas',
            participants: ['Ich', 'Andreas'],
            decisions: ['8% Rabatt fuer 12 Monate'],
            negotiatedTerms: ['8% Rabatt', '12 Monate Laufzeit'],
            openPoints: ['SLA-Abnahme'],
            actionItems: ['Andreas sendet Vertragsentwurf'],
            sourceRefs: [{ seq: 4, quote: 'wir einigen uns auf 8 Prozent Rabatt' }],
            confidence: 0.9,
          },
        }),
    });

    const result = await extractor.extract({
      conversationId: 'conv-1',
      userId: 'user-1',
      personaId: 'persona-1',
      messages: buildMeetingTranscript(),
    });

    expect(result.facts).toHaveLength(2);
    expect(wordCount(result.teaser)).toBeGreaterThanOrEqual(80);
    expect(wordCount(result.teaser)).toBeLessThanOrEqual(150);
    expect(wordCount(result.episode)).toBeGreaterThanOrEqual(400);
    expect(wordCount(result.episode)).toBeLessThanOrEqual(800);
    expect(result.meetingLedger?.counterpart).toBe('Andreas');
    expect(result.meetingLedger?.sourceRefs[0].seq).toBe(4);
  });

  it('falls back to deterministic extraction when model call fails', async () => {
    const extractor = new KnowledgeExtractor({
      runExtractionModel: async () => {
        throw new Error('upstream failed');
      },
    });

    const result = await extractor.extract({
      conversationId: 'conv-1',
      userId: 'user-1',
      personaId: 'persona-1',
      messages: buildMeetingTranscript(),
    });

    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.meetingLedger).toBeDefined();
    expect(result.meetingLedger?.sourceRefs.length).toBeGreaterThan(0);
    expect(wordCount(result.teaser)).toBeGreaterThanOrEqual(80);
    expect(wordCount(result.episode)).toBeGreaterThanOrEqual(400);
  });

  it('filters command and greeting noise from fallback facts', async () => {
    const extractor = new KnowledgeExtractor({
      runExtractionModel: async () => {
        throw new Error('upstream failed');
      },
    });

    const noisyMessages: StoredMessage[] = [
      {
        id: 'msg-1',
        conversationId: 'conv-noise',
        seq: 1,
        role: 'user',
        content: '/new',
        platform: 'WebChat' as never,
        externalMsgId: null,
        senderName: null,
        metadata: null,
        createdAt: new Date(2026, 1, 15, 10, 0).toISOString(),
      },
      {
        id: 'msg-2',
        conversationId: 'conv-noise',
        seq: 2,
        role: 'system',
        content: 'Neue Konversation erstellt.',
        platform: 'WebChat' as never,
        externalMsgId: null,
        senderName: null,
        metadata: null,
        createdAt: new Date(2026, 1, 15, 10, 1).toISOString(),
      },
      {
        id: 'msg-3',
        conversationId: 'conv-noise',
        seq: 3,
        role: 'user',
        content: 'Hallo',
        platform: 'WebChat' as never,
        externalMsgId: null,
        senderName: null,
        metadata: null,
        createdAt: new Date(2026, 1, 15, 10, 2).toISOString(),
      },
      {
        id: 'msg-4',
        conversationId: 'conv-noise',
        seq: 4,
        role: 'user',
        content: 'Regeln: 1. Niemals zu spät kommen. 2. Bei Meetings bleibst du in meiner Nähe.',
        platform: 'WebChat' as never,
        externalMsgId: null,
        senderName: null,
        metadata: null,
        createdAt: new Date(2026, 1, 15, 10, 3).toISOString(),
      },
    ];

    const result = await extractor.extract({
      conversationId: 'conv-noise',
      userId: 'user-1',
      personaId: 'persona-1',
      messages: noisyMessages,
    });

    expect(result.facts.some((fact) => fact.includes('/new'))).toBe(false);
    expect(result.facts.some((fact) => /neue konversation erstellt/i.test(fact))).toBe(false);
    expect(result.facts.some((fact) => /^hallo$/i.test(fact))).toBe(false);
    expect(result.facts.some((fact) => /niemals zu spät kommen/i.test(fact))).toBe(true);
  });
});
