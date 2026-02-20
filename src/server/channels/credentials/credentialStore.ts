import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

// ─── Channel Credential Store ────────────────────────────────
// Persists bot tokens and secrets in SQLite instead of process.env.

export interface ChannelCredential {
  channel: string;
  key: string;
  value: string;
  updatedAt: string;
}

export class CredentialStore {
  private readonly db: ReturnType<typeof BetterSqlite3>;

  constructor(dbPath = process.env.MESSAGES_DB_PATH || '.local/messages.db') {
    if (dbPath === ':memory:') {
      this.db = new BetterSqlite3(':memory:');
    } else {
      const fullPath = path.resolve(dbPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      this.db = new BetterSqlite3(fullPath);
    }
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_credentials (
        channel TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (channel, key)
      );
    `);
  }

  setCredential(channel: string, key: string, value: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO channel_credentials (channel, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(channel, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(channel, key, value, now);
  }

  getCredential(channel: string, key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM channel_credentials WHERE channel = ? AND key = ?')
      .get(channel, key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  deleteCredential(channel: string, key: string): void {
    this.db
      .prepare('DELETE FROM channel_credentials WHERE channel = ? AND key = ?')
      .run(channel, key);
  }

  deleteCredentials(channel: string): void {
    this.db.prepare('DELETE FROM channel_credentials WHERE channel = ?').run(channel);
  }

  listCredentials(channel: string): ChannelCredential[] {
    const rows = this.db
      .prepare('SELECT * FROM channel_credentials WHERE channel = ? ORDER BY key')
      .all(channel) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      channel: r.channel as string,
      key: r.key as string,
      value: r.value as string,
      updatedAt: r.updated_at as string,
    }));
  }
}

// ─── Singleton ───────────────────────────────────────────────

declare global {
  var __credentialStore: CredentialStore | undefined;
}

export function getCredentialStore(): CredentialStore {
  if (!globalThis.__credentialStore) {
    globalThis.__credentialStore = new CredentialStore();
  }
  return globalThis.__credentialStore;
}
