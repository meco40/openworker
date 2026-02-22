import type BetterSqlite3 from 'better-sqlite3';
import { openSqliteDatabase } from '@/server/db/sqlite';

// ─── Types ───────────────────────────────────────────────────

export interface PersonaTelegramBot {
  botId: string;
  personaId: string;
  token: string;
  webhookSecret: string;
  peerName: string | null;
  transport: 'webhook' | 'polling';
  pollingOffset: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertPersonaTelegramBotInput {
  botId: string;
  personaId: string;
  token: string;
  webhookSecret: string;
  peerName?: string | null;
  transport: 'webhook' | 'polling';
}

// ─── Row mapper ───────────────────────────────────────────────

function toBot(row: Record<string, unknown>): PersonaTelegramBot {
  return {
    botId: row.bot_id as string,
    personaId: row.persona_id as string,
    token: row.token as string,
    webhookSecret: row.webhook_secret as string,
    peerName: (row.peer_name as string) || null,
    transport: (row.transport as 'webhook' | 'polling') || 'polling',
    pollingOffset: (row.polling_offset as number) || 0,
    active: (row.active as number) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// ─── Registry ────────────────────────────────────────────────

export class PersonaTelegramBotRegistry {
  private readonly db: ReturnType<typeof BetterSqlite3>;

  constructor(dbPath = process.env.PERSONAS_DB_PATH || '.local/personas.db') {
    this.db = openSqliteDatabase({ dbPath });
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS persona_telegram_bots (
        bot_id         TEXT PRIMARY KEY,
        persona_id     TEXT NOT NULL UNIQUE,
        token          TEXT NOT NULL,
        webhook_secret TEXT NOT NULL,
        peer_name      TEXT,
        transport      TEXT NOT NULL DEFAULT 'polling',
        polling_offset INTEGER NOT NULL DEFAULT 0,
        active         INTEGER NOT NULL DEFAULT 1,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
    `);
  }

  getBot(botId: string): PersonaTelegramBot | null {
    const row = this.db
      .prepare('SELECT * FROM persona_telegram_bots WHERE bot_id = ?')
      .get(botId) as Record<string, unknown> | undefined;
    return row ? toBot(row) : null;
  }

  getBotByPersonaId(personaId: string): PersonaTelegramBot | null {
    const row = this.db
      .prepare('SELECT * FROM persona_telegram_bots WHERE persona_id = ?')
      .get(personaId) as Record<string, unknown> | undefined;
    return row ? toBot(row) : null;
  }

  listActiveBots(): PersonaTelegramBot[] {
    const rows = this.db
      .prepare('SELECT * FROM persona_telegram_bots WHERE active = 1 ORDER BY created_at')
      .all() as Array<Record<string, unknown>>;
    return rows.map(toBot);
  }

  listAllBots(): PersonaTelegramBot[] {
    const rows = this.db
      .prepare('SELECT * FROM persona_telegram_bots ORDER BY created_at')
      .all() as Array<Record<string, unknown>>;
    return rows.map(toBot);
  }

  upsertBot(input: UpsertPersonaTelegramBotInput): PersonaTelegramBot {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO persona_telegram_bots
           (bot_id, persona_id, token, webhook_secret, peer_name, transport, polling_offset, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
         ON CONFLICT(bot_id) DO UPDATE SET
           persona_id     = excluded.persona_id,
           token          = excluded.token,
           webhook_secret = excluded.webhook_secret,
           peer_name      = excluded.peer_name,
           transport      = excluded.transport,
           active         = 1,
           updated_at     = excluded.updated_at`,
      )
      .run(
        input.botId,
        input.personaId,
        input.token,
        input.webhookSecret,
        input.peerName ?? null,
        input.transport,
        now,
        now,
      );
    return this.getBot(input.botId)!;
  }

  setPollingOffset(botId: string, offset: number): void {
    this.db
      .prepare('UPDATE persona_telegram_bots SET polling_offset = ? WHERE bot_id = ?')
      .run(offset, botId);
  }

  setActive(botId: string, active: boolean): void {
    this.db
      .prepare('UPDATE persona_telegram_bots SET active = ?, updated_at = ? WHERE bot_id = ?')
      .run(active ? 1 : 0, new Date().toISOString(), botId);
  }

  removeBot(botId: string): void {
    this.db.prepare('DELETE FROM persona_telegram_bots WHERE bot_id = ?').run(botId);
  }

  removeByPersonaId(personaId: string): void {
    this.db.prepare('DELETE FROM persona_telegram_bots WHERE persona_id = ?').run(personaId);
  }
}

// ─── Singleton ───────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __personaTelegramBotRegistry: PersonaTelegramBotRegistry | undefined;
}

export function getPersonaTelegramBotRegistry(): PersonaTelegramBotRegistry {
  if (!globalThis.__personaTelegramBotRegistry) {
    globalThis.__personaTelegramBotRegistry = new PersonaTelegramBotRegistry();
  }
  return globalThis.__personaTelegramBotRegistry;
}
