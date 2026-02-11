import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  CreatePipelineModelInput,
  CreateProviderAccountInput,
  ModelHubRepository,
  PipelineModelEntry,
  ProviderAccountRecord,
  ProviderAccountView,
} from '../repository';

function toView(row: any): ProviderAccountView {
  return {
    id: row.id,
    providerId: row.provider_id,
    label: row.label,
    authMethod: row.auth_method,
    secretMasked: row.secret_masked,
    hasRefreshToken: Boolean(row.encrypted_refresh_token),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastCheckAt: row.last_check_at,
    lastCheckOk: row.last_check_ok === null ? null : Boolean(row.last_check_ok),
  };
}

function toPipelineEntry(row: any): PipelineModelEntry {
  return {
    id: row.id,
    profileId: row.profile_id,
    accountId: row.account_id,
    providerId: row.provider_id,
    modelName: row.model_name,
    priority: row.priority,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteModelHubRepository implements ModelHubRepository {
  private readonly db: ReturnType<typeof Database>;

  constructor(dbPath = process.env.MODEL_HUB_DB_PATH || '.local/model-hub.db') {
    const fullPath = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    this.db = new Database(fullPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_hub_accounts (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        label TEXT NOT NULL,
        auth_method TEXT NOT NULL,
        encrypted_secret TEXT NOT NULL,
        encrypted_refresh_token TEXT,
        secret_masked TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_check_at TEXT,
        last_check_ok INTEGER
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_hub_pipeline (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_name TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_profile
        ON model_hub_pipeline (profile_id, priority);
    `);
  }

  createAccount(input: CreateProviderAccountInput): ProviderAccountView {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(`
        INSERT INTO model_hub_accounts (
          id, provider_id, label, auth_method,
          encrypted_secret, encrypted_refresh_token, secret_masked,
          created_at, updated_at, last_check_at, last_check_ok
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `)
      .run(
        id,
        input.providerId,
        input.label,
        input.authMethod,
        JSON.stringify(input.encryptedSecret),
        input.encryptedRefreshToken ? JSON.stringify(input.encryptedRefreshToken) : null,
        input.secretMasked,
        now,
        now,
      );

    const row = this.db
      .prepare('SELECT * FROM model_hub_accounts WHERE id = ?')
      .get(id) as any;
    return toView(row);
  }

  listAccounts(): ProviderAccountView[] {
    const rows = this.db
      .prepare('SELECT * FROM model_hub_accounts ORDER BY created_at DESC')
      .all() as any[];
    return rows.map(toView);
  }

  getAccountRecordById(id: string): ProviderAccountRecord | null {
    const row = this.db
      .prepare('SELECT * FROM model_hub_accounts WHERE id = ?')
      .get(id) as any;
    if (!row) return null;

    return {
      ...toView(row),
      encryptedSecret: JSON.parse(row.encrypted_secret),
      encryptedRefreshToken: row.encrypted_refresh_token
        ? JSON.parse(row.encrypted_refresh_token)
        : null,
    };
  }

  setHealthStatus(id: string, ok: boolean): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'UPDATE model_hub_accounts SET last_check_at = ?, last_check_ok = ?, updated_at = ? WHERE id = ?',
      )
      .run(now, ok ? 1 : 0, now, id);
  }

  deleteAccount(id: string): boolean {
    // Remove any pipeline entries referencing this account
    this.db
      .prepare('DELETE FROM model_hub_pipeline WHERE account_id = ?')
      .run(id);

    const result = this.db
      .prepare('DELETE FROM model_hub_accounts WHERE id = ?')
      .run(id);
    return (result as any).changes > 0;
  }

  // ─── Pipeline methods ──────────────────────────────────────────

  listPipelineModels(profileId: string): PipelineModelEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM model_hub_pipeline WHERE profile_id = ? ORDER BY priority ASC')
      .all(profileId) as any[];
    return rows.map(toPipelineEntry);
  }

  addPipelineModel(input: CreatePipelineModelInput): PipelineModelEntry {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(`
        INSERT INTO model_hub_pipeline (
          id, profile_id, account_id, provider_id,
          model_name, priority, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `)
      .run(
        id,
        input.profileId,
        input.accountId,
        input.providerId,
        input.modelName,
        input.priority,
        now,
        now,
      );

    const row = this.db
      .prepare('SELECT * FROM model_hub_pipeline WHERE id = ?')
      .get(id) as any;
    return toPipelineEntry(row);
  }

  removePipelineModel(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM model_hub_pipeline WHERE id = ?')
      .run(id);
    return (result as any).changes > 0;
  }

  updatePipelineModelStatus(id: string, status: 'active' | 'rate-limited' | 'offline'): void {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE model_hub_pipeline SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, id);
  }

  updatePipelineModelPriority(id: string, priority: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE model_hub_pipeline SET priority = ?, updated_at = ? WHERE id = ?')
      .run(priority, now, id);
  }

  replacePipeline(profileId: string, models: CreatePipelineModelInput[]): PipelineModelEntry[] {
    this.db
      .prepare('DELETE FROM model_hub_pipeline WHERE profile_id = ?')
      .run(profileId);

    const entries: PipelineModelEntry[] = [];
    for (const input of models) {
      entries.push(this.addPipelineModel({ ...input, profileId }));
    }
    return entries;
  }
}
