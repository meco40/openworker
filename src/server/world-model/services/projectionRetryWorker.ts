import { getMemoryService } from '@/server/memory/runtime';
import { getWorldModelDb } from '@/server/world-model/db';
import { isMem0FactualWriteBlocked } from '@/server/world-model/mem0Policy';
import { normalizeExtraction } from '@/server/world-model/projector/normalizeExtraction';
import { projectWindow } from '@/server/world-model/projector/projectWindow';
import {
  listDueProjectionPending,
  markProjectionPendingFailed,
  markProjectionPendingSucceeded,
  type ProjectionPendingRecord,
} from '@/server/world-model/repositories/projectionPendingRepository';
import type { KnowledgeExtractionResult } from '@/server/knowledge/extractor';
import type { IngestionWindow } from '@/server/knowledge/ingestionCursor';
import { getKnowledgeMessageRepository, getKnowledgeRepository } from '@/server/knowledge/runtime';
import { upsertEpisodeAndLedger } from '@/server/knowledge/ingestion/episodeExtractor';
import { storeEvents } from '@/server/knowledge/ingestion/eventExtractor';
import { storeEntities } from '@/server/knowledge/ingestion/entityExtractor';
import { processMeetingLedger, processFacts } from '@/server/knowledge/ingestion/factExtractor';

export interface ProjectionRetryResult {
  selected: number;
  succeeded: number;
  failed: number;
}

type ProjectionRetryHandler = (record: ProjectionPendingRecord) => Promise<void>;

function asExtraction(value: unknown): KnowledgeExtractionResult {
  if (!value || typeof value !== 'object') {
    throw new Error('projection retry payload has no raw extraction');
  }
  return value as KnowledgeExtractionResult;
}

async function clearMemoryPendingIfSettled(record: ProjectionPendingRecord): Promise<void> {
  const result = await getWorldModelDb().query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM world_model_projection_pending
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
       AND source_window_id = $4 AND status IN ('pending', 'failed')`,
    [
      record.scope.userId,
      record.scope.personaId,
      record.scope.workspaceId ?? '',
      record.sourceWindowId,
    ],
  );
  if (Number(result.rows[0]?.count ?? 0) > 0) return;
  const messageIds = Array.isArray(record.payload.messageIds)
    ? record.payload.messageIds.map((value) => String(value ?? '')).filter(Boolean)
    : Array.isArray(record.payload.messages)
      ? record.payload.messages
          .map((value) => String((value as Record<string, unknown>).id ?? ''))
          .filter(Boolean)
      : [];
  getKnowledgeMessageRepository().markMessagesMemoryPending?.(messageIds, false);
}

async function retryWorldModelWindow(record: ProjectionPendingRecord): Promise<void> {
  const extraction = asExtraction(record.payload.rawExtraction);
  const fromSeqExclusive = Number(record.payload.fromSeqExclusive ?? 0);
  const toSeqInclusive = Number(record.payload.toSeqInclusive ?? fromSeqExclusive);
  const projection = normalizeExtraction({
    result: extraction,
    workspaceId: record.scope.workspaceId ?? '',
    userId: record.scope.userId,
    personaId: record.scope.personaId,
  });
  await projectWindow({
    scope: record.scope,
    projection,
    extraction,
    observation: {
      userId: record.scope.userId,
      personaId: record.scope.personaId,
      workspaceId: record.scope.workspaceId ?? '',
      sourceType: 'automation',
      sourceId: record.sourceWindowId,
      occurredAt: new Date().toISOString(),
      payload: {
        conversationId: String(record.payload.conversationId ?? ''),
        fromSeq: fromSeqExclusive + 1,
        toSeq: toSeqInclusive,
        windowId: record.sourceWindowId,
        rawExtraction: extraction,
      },
      sourceAuthority: 'persona',
    },
  });
}

async function retryMem0Facts(record: ProjectionPendingRecord): Promise<void> {
  if (isMem0FactualWriteBlocked()) {
    throw new Error('Mem0 factual projection is disabled in canonical mode');
  }
  const memoryService = getMemoryService();
  const facts = Array.isArray(record.payload.facts) ? record.payload.facts : [];
  for (const [index, value] of facts.entries()) {
    const content = String(value ?? '').trim();
    if (!content) continue;
    const metadata = {
      sourceType: 'world_model_projection_retry',
      sourceObservationId: record.sourceObservationId,
      projectionPendingId: record.id,
      idempotencyKey: `world-model-retry:${record.id}:${index}`,
    };
    if (memoryService.storeMemory) {
      await memoryService.storeMemory({
        personaId: record.scope.personaId,
        type: 'fact',
        content,
        importance: 3,
        userId: record.scope.userId,
        metadata,
      });
    } else {
      await memoryService.store(
        record.scope.personaId,
        'fact',
        content,
        3,
        record.scope.userId,
        metadata,
      );
    }
  }
}

function asWindow(record: ProjectionPendingRecord): IngestionWindow {
  const payloadMessages = Array.isArray(record.payload.messages) ? record.payload.messages : [];
  const messages = payloadMessages.map((message) => {
    const value = message as Record<string, unknown>;
    return {
      id: String(value.id ?? `${record.sourceWindowId}:${String(value.seq ?? '')}`),
      conversationId: String(value.conversationId ?? record.payload.conversationId ?? ''),
      seq: Number(value.seq ?? 0),
      role: String(value.role ?? 'user') as 'user' | 'agent' | 'system',
      content: String(value.content ?? ''),
      platform: String(
        value.platform ?? 'webchat',
      ) as IngestionWindow['messages'][number]['platform'],
      externalMsgId: value.externalMsgId ? String(value.externalMsgId) : null,
      senderName: value.senderName ? String(value.senderName) : null,
      metadata: value.metadata ? String(value.metadata) : null,
      createdAt: String(value.createdAt ?? new Date().toISOString()),
    };
  });

  return {
    conversationId: String(record.payload.conversationId ?? messages[0]?.conversationId ?? ''),
    userId: record.scope.userId,
    personaId: record.scope.personaId,
    workspaceId: record.scope.workspaceId ?? '',
    fromSeqExclusive: Number(record.payload.fromSeqExclusive ?? 0),
    toSeqInclusive: Number(record.payload.toSeqInclusive ?? messages.at(-1)?.seq ?? 0),
    messages,
  };
}

async function retrySqliteKnowledge(record: ProjectionPendingRecord): Promise<void> {
  const extraction = asExtraction(record.payload.rawExtraction);
  const window = asWindow(record);
  if (window.messages.length === 0) {
    throw new Error('sqlite knowledge retry payload has no source messages');
  }

  const repo = getKnowledgeRepository();
  const facts = Array.isArray(record.payload.facts)
    ? record.payload.facts.map((value) => String(value ?? '')).filter(Boolean)
    : processFacts(extraction, window);
  const ledger = processMeetingLedger(extraction, window);
  const personaName = String(record.payload.personaName ?? window.personaId);

  upsertEpisodeAndLedger(repo, {
    window,
    extraction,
    facts,
    memoryIds: Array.isArray(record.payload.memoryIds)
      ? record.payload.memoryIds.map((value) => String(value ?? '')).filter(Boolean)
      : [],
    filteredDecisions: ledger.decisions,
    filteredNegotiatedTerms: ledger.negotiatedTerms,
    filteredOpenPoints: ledger.openPoints,
    filteredActionItems: ledger.actionItems,
  });
  await storeEvents(repo, { window, extraction, personaName });
  storeEntities(repo, { window, entities: extraction.entities ?? [] });
}

const defaultHandlers: Record<string, ProjectionRetryHandler> = {
  world_model_window: retryWorldModelWindow,
  mem0_fact: retryMem0Facts,
  sqlite_knowledge: retrySqliteKnowledge,
};

export async function runProjectionRetryOnce(
  limit = 25,
  handlers: Record<string, ProjectionRetryHandler> = defaultHandlers,
): Promise<ProjectionRetryResult> {
  const records = await listDueProjectionPending(limit);
  let succeeded = 0;
  let failed = 0;
  for (const record of records) {
    const handler = handlers[record.projectionType];
    try {
      if (!handler) throw new Error(`no retry handler for ${record.projectionType}`);
      await handler(record);
      await markProjectionPendingSucceeded(record.id);
      await clearMemoryPendingIfSettled(record);
      succeeded += 1;
    } catch (error) {
      failed += 1;
      await markProjectionPendingFailed(
        record.id,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return { selected: records.length, succeeded, failed };
}

export function startProjectionRetryWorker(intervalMs = 30_000): { stop: () => void } {
  const timer = setInterval(() => {
    void runProjectionRetryOnce().catch((error) => {
      console.error('[world-model:projection-retry] worker tick failed:', error);
    });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
