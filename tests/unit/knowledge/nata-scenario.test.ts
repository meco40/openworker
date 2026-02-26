/**
 * Integration test for the Nata reference scenario:
 *
 * Week 1: Nata says "Ich habe die letzten zwei Tage mit meinem Bruder Max geschlafen" (2 days: Feb 1-2)
 * Week 2: User confirms "Ja genau, du hast mit Max geschlafen" (confirmation)
 * Week 3: Nata says "Ich habe gestern nochmal bei Max uebernachtet" (1 day: Feb 15)
 *
 * Query: "Wie viele Tage hat Nata insgesamt mit Max geschlafen?"
 * Expected answer: contains "3" (2 + 1 = 3, confirmation ignored)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { SqliteKnowledgeRepository } from '@/server/knowledge/sqliteKnowledgeRepository';
import { KnowledgeIngestionService } from '@/server/knowledge/ingestion/service';
import { computeEventAnswer } from '@/server/knowledge/eventAnswerComputer';
import { planKnowledgeQuery } from '@/server/knowledge/queryPlanner';
import type { KnowledgeExtractionResult } from '@/server/knowledge/extractor';
import type { StoredMessage } from '@/server/channels/messages/repository';
import { cleanupSqliteArtifacts } from '../../helpers/sqliteTestArtifacts';

const TEST_DB_DIR = '.local';
let dbPath: string;
let repo: SqliteKnowledgeRepository;

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

function buildLongText(word: string, count: number): string {
  return Array(count).fill(word).join(' ');
}

beforeEach(() => {
  if (!existsSync(TEST_DB_DIR)) mkdirSync(TEST_DB_DIR, { recursive: true });
  dbPath = `${TEST_DB_DIR}/test-nata-scenario-${Date.now()}.db`;
  repo = new SqliteKnowledgeRepository(dbPath);
});

afterEach(() => {
  try {
    repo?.close();
  } catch {
    // ignore close races
  }

  try {
    cleanupSqliteArtifacts(dbPath);
  } catch {
    // ignore
  }
});

describe('Nata reference scenario: 3 days total', () => {
  it('computes the correct answer of 3 unique days', async () => {
    // ── Mock memory service (does nothing) ────────────────────
    const memoryService = {
      store: vi.fn().mockResolvedValue(null),
    };

    // ── Week 1 extraction result (mock LLM returns this) ──────
    const week1Result: KnowledgeExtractionResult = {
      facts: ['Ich habe die letzten zwei Tage mit meinem Bruder Max geschlafen'],
      teaser: buildLongText('kontext', 100),
      episode: buildLongText('detail', 500),
      entities: [],
      events: [
        {
          eventType: 'shared_sleep',
          speakerRole: 'assistant',
          subject: 'Nata',
          counterpart: 'Max',
          relationLabel: 'Bruder',
          timeExpression: 'die letzten zwei Tage',
          startDate: '2026-02-01',
          endDate: '2026-02-02',
          dayCount: 2,
          isConfirmation: false,
          confirmationSignals: [],
          sourceSeq: [10],
        },
      ],
      meetingLedger: {
        topicKey: 'nata-max-schlaf',
        counterpart: 'Max',
        participants: ['Nata', 'Max'],
        decisions: [],
        negotiatedTerms: [],
        openPoints: [],
        actionItems: [],
        sourceRefs: [{ seq: 10, quote: 'Ich habe die letzten zwei Tage mit Max geschlafen' }],
        confidence: 0.9,
      },
    };

    // ── Week 2 extraction result (confirmation) ───────────────
    const week2Result: KnowledgeExtractionResult = {
      facts: ['User bestaetigt: Nata hat mit Max geschlafen'],
      teaser: buildLongText('kontext', 100),
      episode: buildLongText('detail', 500),
      entities: [],
      events: [
        {
          eventType: 'shared_sleep',
          speakerRole: 'user',
          subject: 'Nata',
          counterpart: 'Max',
          relationLabel: 'Bruder',
          timeExpression: '',
          startDate: '2026-02-01',
          endDate: '2026-02-02',
          dayCount: 2,
          isConfirmation: true,
          confirmationSignals: ['ja', 'genau'],
          sourceSeq: [20],
        },
      ],
      meetingLedger: {
        topicKey: 'nata-max-schlaf',
        counterpart: 'Max',
        participants: ['Nata', 'Max'],
        decisions: [],
        negotiatedTerms: [],
        openPoints: [],
        actionItems: [],
        sourceRefs: [{ seq: 20, quote: 'Ja genau, du hast mit Max geschlafen' }],
        confidence: 0.7,
      },
    };

    // ── Week 3 extraction result (1 new day) ──────────────────
    const week3Result: KnowledgeExtractionResult = {
      facts: ['Ich habe gestern nochmal bei Max uebernachtet'],
      teaser: buildLongText('kontext', 100),
      episode: buildLongText('detail', 500),
      entities: [],
      events: [
        {
          eventType: 'shared_sleep',
          speakerRole: 'assistant',
          subject: 'Nata',
          counterpart: 'Max',
          relationLabel: 'Bruder',
          timeExpression: 'gestern',
          startDate: '2026-02-15',
          endDate: '2026-02-15',
          dayCount: 1,
          isConfirmation: false,
          confirmationSignals: [],
          sourceSeq: [30],
        },
      ],
      meetingLedger: {
        topicKey: 'nata-max-schlaf',
        counterpart: 'Max',
        participants: ['Nata', 'Max'],
        decisions: [],
        negotiatedTerms: [],
        openPoints: [],
        actionItems: [],
        sourceRefs: [{ seq: 30, quote: 'Ich habe gestern nochmal bei Max uebernachtet' }],
        confidence: 0.9,
      },
    };

    // ── Mock extractor (returns pre-built results) ────────────
    const extractionResults = [week1Result, week2Result, week3Result];
    let callIndex = 0;
    const extractor = {
      extract: vi.fn().mockImplementation(async () => extractionResults[callIndex++]),
    };

    // ── Ingestion service ──────────────────────────────────────
    const ingestionService = new KnowledgeIngestionService({
      cursor: { getPendingWindows: vi.fn().mockReturnValue([]), markWindowProcessed: vi.fn() },
      extractor,
      knowledgeRepository: repo,
      memoryService,
    });

    // ── Week 1: Ingest ────────────────────────────────────────
    await ingestionService.ingestConversationWindow({
      conversationId: 'conv-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      messages: [
        makeMsg(10, 'agent', 'Ich habe die letzten zwei Tage mit meinem Bruder Max geschlafen'),
      ],
    });

    // ── Week 2: Ingest confirmation ────────────────────────────
    await ingestionService.ingestConversationWindow({
      conversationId: 'conv-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      messages: [
        makeMsg(10, 'agent', 'Ich habe die letzten zwei Tage mit Max geschlafen'),
        makeMsg(20, 'user', 'Ja genau, du hast mit Max geschlafen'),
      ],
    });

    // ── Week 3: Ingest new event ──────────────────────────────
    await ingestionService.ingestConversationWindow({
      conversationId: 'conv-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      messages: [
        makeMsg(10, 'agent', 'Ich habe die letzten zwei Tage mit Max geschlafen'),
        makeMsg(20, 'user', 'Ja genau, du hast mit Max geschlafen'),
        makeMsg(30, 'agent', 'Ich habe gestern nochmal bei Max uebernachtet'),
      ],
    });

    // ── Query: How many total days? ────────────────────────────
    const plan = planKnowledgeQuery('Wie viele Tage hat Nata insgesamt mit Max geschlafen?');

    expect(plan.intent).toBe('count_recall');
    expect(plan.eventFilter).toBeDefined();
    expect(plan.eventFilter?.eventType).toBe('shared_sleep');

    // ── Compute the answer ─────────────────────────────────────
    const answer = computeEventAnswer(
      plan.eventFilter!,
      { userId: 'user-1', personaId: 'persona-nata' },
      repo,
    );

    expect(answer).not.toBeNull();
    // THE KEY ASSERTION: answer must contain "3"
    expect(answer).toContain('3');
    expect(answer).toContain('Tage');
    expect(answer).toContain('Max');
  });
});
