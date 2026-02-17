import crypto from 'node:crypto';
import fs from 'node:fs';

import BetterSqlite3 from 'better-sqlite3';
import nextEnv from '@next/env';

import { LEGACY_LOCAL_USER_ID } from '../src/server/auth/constants';
import {
  createMem0ClientFromEnv,
  type Mem0Client,
  type Mem0MemoryRecord,
} from '../src/server/memory/mem0Client';

const DEFAULT_MESSAGES_DB_PATH = '.local/messages.db';
const MEMORY_PAGE_SIZE = 200;
const loadEnvConfigFn =
  (nextEnv as unknown as { loadEnvConfig?: (dir: string) => void }).loadEnvConfig ??
  (nextEnv as unknown as { default?: { loadEnvConfig?: (dir: string) => void } }).default
    ?.loadEnvConfig;

type ConversationScope = {
  conversationId: string;
  personaId: string;
  channelType: string;
  externalChatId: string;
  targetUserId: string;
};

type KnowledgeBackfillStats = {
  conversations: number;
  episodesCopied: number;
  ledgerCopied: number;
};

type Mem0BackfillStats = {
  scopesProcessed: number;
  sourceMemories: number;
  targetMemoriesBefore: number;
  inserted: number;
  skippedExisting: number;
  errors: string[];
};

function hasTable(db: BetterSqlite3.Database, table: string): boolean {
  const row = db
    .prepare("SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { ok?: number } | undefined;
  return row?.ok === 1;
}

function normalizeChannelType(channelType: string): string {
  return String(channelType || '')
    .trim()
    .toLowerCase();
}

function buildChannelScope(channelType: string, externalChatId: string): string {
  return `channel:${normalizeChannelType(channelType)}:${String(externalChatId || '').trim()}`;
}

function listConversationScopes(db: BetterSqlite3.Database): ConversationScope[] {
  if (!hasTable(db, 'conversations')) return [];

  const rows = db
    .prepare(
      `
      SELECT id, persona_id, channel_type, external_chat_id, user_id
      FROM conversations
      WHERE user_id = ?
        AND persona_id IS NOT NULL
        AND COALESCE(external_chat_id, '') <> ''
        AND LOWER(channel_type) <> 'webchat'
    `,
    )
    .all(LEGACY_LOCAL_USER_ID) as Array<{
    id: string;
    persona_id: string | null;
    channel_type: string;
    external_chat_id: string;
    user_id: string;
  }>;

  return rows
    .map((row) => ({
      conversationId: String(row.id),
      personaId: String(row.persona_id || '').trim(),
      channelType: String(row.channel_type || '').trim(),
      externalChatId: String(row.external_chat_id || '').trim(),
      targetUserId: buildChannelScope(row.channel_type, row.external_chat_id),
    }))
    .filter(
      (row) =>
        row.conversationId.length > 0 &&
        row.personaId.length > 0 &&
        row.channelType.length > 0 &&
        row.externalChatId.length > 0,
    );
}

function backfillKnowledgeTables(
  db: BetterSqlite3.Database,
  scopes: ConversationScope[],
): KnowledgeBackfillStats {
  const stats: KnowledgeBackfillStats = {
    conversations: scopes.length,
    episodesCopied: 0,
    ledgerCopied: 0,
  };

  if (scopes.length === 0) return stats;

  if (!hasTable(db, 'knowledge_episodes') && !hasTable(db, 'knowledge_meeting_ledger')) {
    return stats;
  }

  const getEpisodeRows = hasTable(db, 'knowledge_episodes')
    ? db.prepare(
        `
        SELECT *
        FROM knowledge_episodes
        WHERE user_id = ? AND conversation_id = ? AND persona_id = ?
      `,
      )
    : null;
  const getLedgerRows = hasTable(db, 'knowledge_meeting_ledger')
    ? db.prepare(
        `
        SELECT *
        FROM knowledge_meeting_ledger
        WHERE user_id = ? AND conversation_id = ? AND persona_id = ?
      `,
      )
    : null;

  const upsertEpisode = hasTable(db, 'knowledge_episodes')
    ? db.prepare(
        `
        INSERT INTO knowledge_episodes (
          id, user_id, persona_id, conversation_id, topic_key, counterpart, teaser, episode,
          facts_json, source_seq_start, source_seq_end, source_refs_json, event_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id, persona_id, source_seq_start, source_seq_end)
        DO UPDATE SET
          user_id = excluded.user_id,
          topic_key = excluded.topic_key,
          counterpart = excluded.counterpart,
          teaser = excluded.teaser,
          episode = excluded.episode,
          facts_json = excluded.facts_json,
          source_refs_json = excluded.source_refs_json,
          event_at = excluded.event_at,
          updated_at = excluded.updated_at
      `,
      )
    : null;

  const findNullEventLedgerExisting = hasTable(db, 'knowledge_meeting_ledger')
    ? db.prepare(
        `
        SELECT id
        FROM knowledge_meeting_ledger
        WHERE conversation_id = ?
          AND persona_id = ?
          AND topic_key = ?
          AND event_at IS NULL
        LIMIT 1
      `,
      )
    : null;

  const upsertLedger = hasTable(db, 'knowledge_meeting_ledger')
    ? db.prepare(
        `
        INSERT INTO knowledge_meeting_ledger (
          id, user_id, persona_id, conversation_id, topic_key, counterpart, event_at,
          participants_json, decisions_json, negotiated_terms_json, open_points_json, action_items_json,
          source_refs_json, confidence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id, persona_id, topic_key, event_at)
        DO UPDATE SET
          user_id = excluded.user_id,
          counterpart = excluded.counterpart,
          participants_json = excluded.participants_json,
          decisions_json = excluded.decisions_json,
          negotiated_terms_json = excluded.negotiated_terms_json,
          open_points_json = excluded.open_points_json,
          action_items_json = excluded.action_items_json,
          source_refs_json = excluded.source_refs_json,
          confidence = excluded.confidence,
          updated_at = excluded.updated_at
      `,
      )
    : null;
  const updateLedgerById = hasTable(db, 'knowledge_meeting_ledger')
    ? db.prepare(
        `
        UPDATE knowledge_meeting_ledger
        SET user_id = ?,
            counterpart = ?,
            participants_json = ?,
            decisions_json = ?,
            negotiated_terms_json = ?,
            open_points_json = ?,
            action_items_json = ?,
            source_refs_json = ?,
            confidence = ?,
            updated_at = ?
        WHERE id = ?
      `,
      )
    : null;

  const transact = db.transaction(() => {
    for (const scope of scopes) {
      if (getEpisodeRows && upsertEpisode) {
        const rows = getEpisodeRows.all(
          LEGACY_LOCAL_USER_ID,
          scope.conversationId,
          scope.personaId,
        ) as Array<Record<string, unknown>>;

        for (const row of rows) {
          upsertEpisode.run(
            String(row.id || crypto.randomUUID()),
            scope.targetUserId,
            scope.personaId,
            scope.conversationId,
            String(row.topic_key || 'general'),
            row.counterpart ? String(row.counterpart) : null,
            String(row.teaser || ''),
            String(row.episode || ''),
            String(row.facts_json || '[]'),
            Math.max(0, Math.floor(Number(row.source_seq_start || 0))),
            Math.max(0, Math.floor(Number(row.source_seq_end || 0))),
            String(row.source_refs_json || '[]'),
            row.event_at ? String(row.event_at) : null,
            String(row.created_at || new Date().toISOString()),
            new Date().toISOString(),
          );
          stats.episodesCopied += 1;
        }
      }

      if (getLedgerRows && upsertLedger) {
        const rows = getLedgerRows.all(
          LEGACY_LOCAL_USER_ID,
          scope.conversationId,
          scope.personaId,
        ) as Array<Record<string, unknown>>;

        for (const row of rows) {
          const topicKey = String(row.topic_key || 'general-meeting');
          const eventAt = row.event_at ? String(row.event_at) : null;
          const participantsJson = String(row.participants_json || '[]');
          const decisionsJson = String(row.decisions_json || '[]');
          const negotiatedTermsJson = String(row.negotiated_terms_json || '[]');
          const openPointsJson = String(row.open_points_json || '[]');
          const actionItemsJson = String(row.action_items_json || '[]');
          const sourceRefsJson = String(row.source_refs_json || '[]');
          const confidence = Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0.5;
          const nowIso = new Date().toISOString();

          if (!eventAt && findNullEventLedgerExisting && updateLedgerById) {
            const existing = findNullEventLedgerExisting.get(
              scope.conversationId,
              scope.personaId,
              topicKey,
            ) as { id: string } | undefined;
            if (existing?.id) {
              updateLedgerById.run(
                scope.targetUserId,
                row.counterpart ? String(row.counterpart) : null,
                participantsJson,
                decisionsJson,
                negotiatedTermsJson,
                openPointsJson,
                actionItemsJson,
                sourceRefsJson,
                confidence,
                nowIso,
                existing.id,
              );
              stats.ledgerCopied += 1;
              continue;
            }
          }

          upsertLedger.run(
            String(row.id || crypto.randomUUID()),
            scope.targetUserId,
            scope.personaId,
            scope.conversationId,
            topicKey,
            row.counterpart ? String(row.counterpart) : null,
            eventAt,
            participantsJson,
            decisionsJson,
            negotiatedTermsJson,
            openPointsJson,
            actionItemsJson,
            sourceRefsJson,
            confidence,
            String(row.created_at || new Date().toISOString()),
            nowIso,
          );
          stats.ledgerCopied += 1;
        }
      }
    }
  });

  transact();
  return stats;
}

function normalizeMemoryContent(content: string): string {
  return String(content || '')
    .trim()
    .toLowerCase();
}

async function listAllMemories(
  client: Mem0Client,
  userId: string,
  personaId: string,
): Promise<Mem0MemoryRecord[]> {
  const memories: Mem0MemoryRecord[] = [];
  let page = 1;

  while (true) {
    const listed = await client.listMemories({
      userId,
      personaId,
      page,
      pageSize: MEMORY_PAGE_SIZE,
    });
    memories.push(...listed.memories);
    if (listed.memories.length === 0) break;
    const consumed = page * listed.pageSize;
    if (listed.total > 0 && consumed >= listed.total) break;
    page += 1;
  }

  return memories;
}

async function backfillMem0Scopes(
  client: Mem0Client | null,
  scopes: ConversationScope[],
): Promise<Mem0BackfillStats> {
  const stats: Mem0BackfillStats = {
    scopesProcessed: 0,
    sourceMemories: 0,
    targetMemoriesBefore: 0,
    inserted: 0,
    skippedExisting: 0,
    errors: [],
  };
  if (!client) return stats;

  const uniqueScopes = Array.from(
    new Map(scopes.map((scope) => [`${scope.targetUserId}::${scope.personaId}`, scope])).values(),
  );

  for (const scope of uniqueScopes) {
    stats.scopesProcessed += 1;
    try {
      const [sourceMemories, targetMemories] = await Promise.all([
        listAllMemories(client, LEGACY_LOCAL_USER_ID, scope.personaId),
        listAllMemories(client, scope.targetUserId, scope.personaId),
      ]);

      stats.sourceMemories += sourceMemories.length;
      stats.targetMemoriesBefore += targetMemories.length;

      const existingKeys = new Set(
        targetMemories.map((row) => normalizeMemoryContent(row.content)),
      );
      for (const source of sourceMemories) {
        const key = normalizeMemoryContent(source.content);
        if (!key || existingKeys.has(key)) {
          stats.skippedExisting += 1;
          continue;
        }
        const metadata =
          source.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata)
            ? { ...source.metadata }
            : {};
        delete (metadata as Record<string, unknown>).mem0Id;

        await client.addMemory({
          userId: scope.targetUserId,
          personaId: scope.personaId,
          content: source.content,
          metadata,
        });

        existingKeys.add(key);
        stats.inserted += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stats.errors.push(`[${scope.targetUserId}/${scope.personaId}] ${message}`);
    }
  }

  return stats;
}

async function main(): Promise<void> {
  if (loadEnvConfigFn) {
    loadEnvConfigFn(process.cwd());
  }

  const messagesDbPath = process.env.MESSAGES_DB_PATH || DEFAULT_MESSAGES_DB_PATH;
  if (!fs.existsSync(messagesDbPath)) {
    throw new Error(`Messages DB not found: ${messagesDbPath}`);
  }

  const db = new BetterSqlite3(messagesDbPath);
  db.pragma('busy_timeout = 8000');
  db.pragma('journal_mode = WAL');

  try {
    const scopes = listConversationScopes(db);
    const knowledge = backfillKnowledgeTables(db, scopes);

    const mem0Client = createMem0ClientFromEnv(process.env, fetch);
    const mem0 = await backfillMem0Scopes(mem0Client, scopes);

    console.log(
      JSON.stringify(
        {
          ok: mem0.errors.length === 0,
          messagesDbPath,
          scopes: scopes.length,
          knowledge,
          mem0,
        },
        null,
        2,
      ),
    );

    if (mem0.errors.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});
