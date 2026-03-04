import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StoredMessage } from '@/server/channels/messages/repository';
import { KnowledgeRetrievalService } from '@/server/knowledge/retrieval';
import { SqliteKnowledgeRepository } from '@/server/knowledge/sqliteKnowledgeRepository';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

function createDbPath(): string {
  return path.join(
    getTestArtifactsRoot(),
    `knowledge.integration.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

function msg(seq: number, content: string): StoredMessage {
  return {
    id: `msg-${seq}`,
    conversationId: 'conv-meeting',
    seq,
    role: seq % 2 === 0 ? 'agent' : 'user',
    content,
    platform: 'WebChat' as never,
    externalMsgId: null,
    senderName: null,
    metadata: null,
    createdAt: new Date(2025, 7, 11, 9, seq).toISOString(),
  };
}

describe('knowledge meeting retrieval integration', () => {
  it('returns structured meeting recall from ledger + episodes + evidence', async () => {
    const dbPath = createDbPath();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    const repo = new SqliteKnowledgeRepository(dbPath);

    repo.upsertEpisode({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-meeting',
      topicKey: 'meeting-andreas-contract',
      counterpart: 'Andreas',
      teaser: 'Wir haben die Kernpunkte des Vertrags und Rabatts geklaert.',
      episode: Array.from({ length: 430 }, (_, idx) => `episode${idx}`).join(' '),
      facts: ['8% Rabatt vereinbart', 'SLA offen'],
      sourceSeqStart: 1,
      sourceSeqEnd: 4,
      sourceRefs: [{ seq: 3, quote: 'Wir einigen uns auf 8 Prozent Rabatt' }],
      eventAt: '2025-08-11T09:00:00.000Z',
    });

    repo.upsertMeetingLedger({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-meeting',
      topicKey: 'meeting-andreas-contract',
      counterpart: 'Andreas',
      eventAt: '2025-08-11T09:00:00.000Z',
      participants: ['Ich', 'Andreas'],
      decisions: ['8% Rabatt fuer 12 Monate beschlossen'],
      negotiatedTerms: ['8% Rabatt', '12 Monate Laufzeit'],
      openPoints: ['SLA finale Freigabe'],
      actionItems: ['Andreas sendet Vertragsentwurf bis Freitag'],
      sourceRefs: [{ seq: 3, quote: 'Wir einigen uns auf 8 Prozent Rabatt' }],
      confidence: 0.92,
    });

    const service = new KnowledgeRetrievalService({
      maxContextTokens: 1200,
      knowledgeRepository: repo,
      memoryService: {
        recallDetailed: async () => ({
          context: '[Type: fact] 8% Rabatt vereinbart',
          matches: [],
        }),
      },
      messageRepository: {
        listMessages: () => [
          msg(1, 'Wir starten das Meeting'),
          msg(2, 'Andreas bietet 5 Prozent Rabatt'),
          msg(3, 'Wir einigen uns auf 8 Prozent Rabatt'),
          msg(4, 'SLA bleibt noch offen'),
        ],
      },
    });

    const result = await service.retrieve({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-meeting',
      query: 'Wie war das Meeting mit Andreas und was haben wir ausgehandelt?',
    });

    expect(result.sections.answerDraft).toContain('Andreas');
    expect(result.sections.keyDecisions).toContain('8% Rabatt');
    expect(result.sections.openPoints).toContain('SLA');
    expect(result.sections.evidence).toContain('seq:3');
    expect(result.context).toContain('KeyDecisions');
  });
});
