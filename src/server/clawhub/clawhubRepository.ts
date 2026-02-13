import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

import type { ClawHubSkillRow, UpsertClawHubSkillInput } from './types';

function toRow(raw: Record<string, unknown>): ClawHubSkillRow {
  return {
    slug: String(raw.slug),
    version: String(raw.version),
    title: String(raw.title),
    status: String(raw.status) as ClawHubSkillRow['status'],
    enabled: Boolean(raw.enabled),
    localPath: String(raw.local_path),
    installedAt: raw.installed_at ? String(raw.installed_at) : null,
    lastActionAt: raw.last_action_at ? String(raw.last_action_at) : null,
    lastError: raw.last_error ? String(raw.last_error) : null,
    updatedAt: String(raw.updated_at),
  };
}

export class ClawHubRepository {
  private readonly db: BetterSqlite3.Database;

  constructor(dbPath = process.env.CLAWHUB_DB_PATH || '.local/clawhub.db') {
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
      CREATE TABLE IF NOT EXISTS clawhub_skills (
        slug TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        local_path TEXT NOT NULL,
        installed_at TEXT,
        last_action_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    this.ensureColumnExists('enabled', 'INTEGER NOT NULL DEFAULT 0');
  }

  private ensureColumnExists(column: string, type: string): void {
    const rows = this.db.prepare('PRAGMA table_info(clawhub_skills)').all() as Array<
      Record<string, unknown>
    >;
    const hasColumn = rows.some((row) => String(row.name) === column);
    if (!hasColumn) {
      this.db.exec(`ALTER TABLE clawhub_skills ADD COLUMN ${column} ${type}`);
    }
  }

  upsertSkill(input: UpsertClawHubSkillInput): ClawHubSkillRow {
    const now = new Date().toISOString();
    if (typeof input.enabled === 'boolean') {
      this.db
        .prepare(
          `
          INSERT INTO clawhub_skills (
            slug, version, title, status, enabled, local_path,
            installed_at, last_action_at, last_error, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(slug) DO UPDATE SET
            version = excluded.version,
            title = excluded.title,
            status = excluded.status,
            enabled = excluded.enabled,
            local_path = excluded.local_path,
            installed_at = excluded.installed_at,
            last_action_at = excluded.last_action_at,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at
        `,
        )
        .run(
          input.slug,
          input.version,
          input.title,
          input.status,
          input.enabled ? 1 : 0,
          input.localPath,
          input.installedAt ?? null,
          input.lastActionAt ?? now,
          input.lastError ?? null,
          now,
        );
    } else {
      this.db
        .prepare(
          `
          INSERT INTO clawhub_skills (
            slug, version, title, status, local_path,
            installed_at, last_action_at, last_error, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(slug) DO UPDATE SET
            version = excluded.version,
            title = excluded.title,
            status = excluded.status,
            local_path = excluded.local_path,
            installed_at = excluded.installed_at,
            last_action_at = excluded.last_action_at,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at
        `,
        )
        .run(
          input.slug,
          input.version,
          input.title,
          input.status,
          input.localPath,
          input.installedAt ?? null,
          input.lastActionAt ?? now,
          input.lastError ?? null,
          now,
        );
    }

    const row = this.db
      .prepare('SELECT * FROM clawhub_skills WHERE slug = ?')
      .get(input.slug) as Record<string, unknown>;
    return toRow(row);
  }

  listSkills(): ClawHubSkillRow[] {
    const rows = this.db
      .prepare('SELECT * FROM clawhub_skills ORDER BY updated_at DESC, slug ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(toRow);
  }

  listEnabledSkills(): ClawHubSkillRow[] {
    const rows = this.db
      .prepare('SELECT * FROM clawhub_skills WHERE enabled = 1 ORDER BY updated_at DESC, slug ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(toRow);
  }

  getSkill(slug: string): ClawHubSkillRow | null {
    const row = this.db.prepare('SELECT * FROM clawhub_skills WHERE slug = ?').get(slug) as
      | Record<string, unknown>
      | undefined;
    return row ? toRow(row) : null;
  }

  deleteSkill(slug: string): boolean {
    const result = this.db.prepare('DELETE FROM clawhub_skills WHERE slug = ?').run(slug) as {
      changes: number;
    };
    return result.changes > 0;
  }

  setEnabled(slug: string, enabled: boolean): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare('UPDATE clawhub_skills SET enabled = ?, updated_at = ? WHERE slug = ?')
      .run(enabled ? 1 : 0, now, slug) as { changes: number };
    return result.changes > 0;
  }

  deleteNotIn(slugs: string[]): number {
    if (slugs.length === 0) {
      const deleted = this.db.prepare('DELETE FROM clawhub_skills').run() as { changes: number };
      return deleted.changes;
    }

    const placeholders = slugs.map(() => '?').join(', ');
    const deleted = this.db
      .prepare(`DELETE FROM clawhub_skills WHERE slug NOT IN (${placeholders})`)
      .run(...slugs) as { changes: number };
    return deleted.changes;
  }

  close(): void {
    this.db.close();
  }
}

declare global {
  var __clawHubRepository: ClawHubRepository | undefined;
}

export function getClawHubRepository(): ClawHubRepository {
  if (!globalThis.__clawHubRepository) {
    globalThis.__clawHubRepository = new ClawHubRepository();
  }
  return globalThis.__clawHubRepository;
}
