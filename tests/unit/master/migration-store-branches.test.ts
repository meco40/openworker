import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { MasterSqliteDb } from '@/server/master/repository/db';
import {
  listAllKnownScopes,
  migrateUserLegacyScopesToMasterPersona,
  migrateWorkspaceScope,
} from '@/server/master/repository/migration.store';

const SIMPLE_SCOPE_TABLES = [
  'master_runs',
  'master_steps',
  'master_feedback',
  'master_notes',
  'master_reminders',
  'master_subagent_jobs',
  'master_subagent_events',
  'master_subagent_sessions',
  'master_action_ledger',
  'master_approval_requests',
  'master_tool_policies',
  'master_capability_proposals',
  'master_toolforge_artifacts',
  'master_audit_events',
] as const;

const EXTRA_SCOPE_TABLES = [
  'master_approval_rules',
  'master_capability_scores',
  'master_connector_secrets',
] as const;

const openDbs: Database.Database[] = [];

function createDb(): MasterSqliteDb {
  const db = new Database(':memory:');
  openDbs.push(db);

  for (const table of SIMPLE_SCOPE_TABLES) {
    db.exec(`
      CREATE TABLE ${table} (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT
      )
    `);
  }

  db.exec(`
    CREATE TABLE master_approval_rules (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      decision TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE master_capability_scores (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      confidence REAL NOT NULL,
      last_verified_at TEXT,
      benchmark_summary TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE master_connector_secrets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      key_ref TEXT NOT NULL,
      encrypted_payload TEXT NOT NULL,
      issued_at TEXT,
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  return db as unknown as MasterSqliteDb;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    if (db.open) db.close();
  }
});

describe('master scope migration branches', () => {
  it('lists scopes, ignores noop migrations, and migrates legacy persona scopes', () => {
    const db = createDb();
    db.prepare(
      'INSERT INTO master_runs (id, user_id, workspace_id, updated_at) VALUES (?, ?, ?, ?)',
    ).run('run-1', 'u1', 'persona:legacy:alpha', '2026-04-22T09:00:00.000Z');
    db.prepare(
      'INSERT INTO master_notes (id, user_id, workspace_id, updated_at) VALUES (?, ?, ?, ?)',
    ).run('note-1', 'u1', 'persona:legacy:alpha', '2026-04-22T09:01:00.000Z');
    db.prepare(
      'INSERT INTO master_runs (id, user_id, workspace_id, updated_at) VALUES (?, ?, ?, ?)',
    ).run('run-2', 'u1', 'persona:master-1:beta', '2026-04-22T09:02:00.000Z');
    db.prepare(
      'INSERT INTO master_runs (id, user_id, workspace_id, updated_at) VALUES (?, ?, ?, ?)',
    ).run('run-3', 'u2', 'workspace-without-persona', '2026-04-22T09:03:00.000Z');

    expect(listAllKnownScopes(db, 10)).toEqual([
      { user_id: 'u2', workspace_id: 'workspace-without-persona' },
      { user_id: 'u1', workspace_id: 'persona:master-1:beta' },
      { user_id: 'u1', workspace_id: 'persona:legacy:alpha' },
    ]);

    migrateWorkspaceScope(db, {
      userId: 'u1',
      fromWorkspaceId: 'persona:legacy:alpha',
      toWorkspaceId: 'persona:legacy:alpha',
    });
    expect(
      db.prepare('SELECT workspace_id FROM master_runs WHERE id = ?').get('run-1') as {
        workspace_id: string;
      },
    ).toEqual({ workspace_id: 'persona:legacy:alpha' });

    const migrated = migrateUserLegacyScopesToMasterPersona(db, 'u1', 'master-1');
    expect(migrated).toBe(1);
    expect(
      db.prepare('SELECT workspace_id FROM master_runs WHERE id = ?').get('run-1') as {
        workspace_id: string;
      },
    ).toEqual({ workspace_id: 'persona:master-1:alpha' });
  });

  it('merges approval rules, capability scores, and connector secrets into the target scope', () => {
    const db = createDb();

    db.prepare(
      `INSERT INTO master_approval_rules
       (id, user_id, workspace_id, action_type, fingerprint, decision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'rule-old',
      'u1',
      'persona:legacy:alpha',
      'gmail.send',
      'fp',
      'approve_always',
      '2026-04-20T00:00:00.000Z',
      '2026-04-22T10:00:00.000Z',
    );
    db.prepare(
      `INSERT INTO master_approval_rules
       (id, user_id, workspace_id, action_type, fingerprint, decision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'rule-target',
      'u1',
      'persona:master:alpha',
      'gmail.send',
      'fp',
      'ask',
      '2026-04-19T00:00:00.000Z',
      '2026-04-21T10:00:00.000Z',
    );

    db.prepare(
      `INSERT INTO master_capability_scores
       (id, user_id, workspace_id, capability, confidence, last_verified_at, benchmark_summary, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'cap-old',
      'u1',
      'persona:legacy:alpha',
      'shell_execute',
      0.9,
      '2026-04-22T08:00:00.000Z',
      'new summary',
      '2026-04-22T09:00:00.000Z',
    );
    db.prepare(
      `INSERT INTO master_capability_scores
       (id, user_id, workspace_id, capability, confidence, last_verified_at, benchmark_summary, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'cap-target',
      'u1',
      'persona:master:alpha',
      'shell_execute',
      0.4,
      null,
      'old summary',
      '2026-04-21T09:00:00.000Z',
    );

    db.prepare(
      `INSERT INTO master_connector_secrets
       (id, user_id, workspace_id, provider, key_ref, encrypted_payload, issued_at, expires_at, revoked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'secret-old',
      'u1',
      'persona:legacy:alpha',
      'gmail',
      'key-1',
      'payload-new',
      '2026-04-20T00:00:00.000Z',
      null,
      null,
      '2026-04-20T00:00:00.000Z',
      '2026-04-22T10:00:00.000Z',
    );
    db.prepare(
      `INSERT INTO master_connector_secrets
       (id, user_id, workspace_id, provider, key_ref, encrypted_payload, issued_at, expires_at, revoked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'secret-target',
      'u1',
      'persona:master:alpha',
      'gmail',
      'key-1',
      'payload-old',
      '2026-04-19T00:00:00.000Z',
      null,
      '2026-04-20T00:00:00.000Z',
      '2026-04-19T00:00:00.000Z',
      '2026-04-21T10:00:00.000Z',
    );

    db.prepare(
      `INSERT INTO master_connector_secrets
       (id, user_id, workspace_id, provider, key_ref, encrypted_payload, issued_at, expires_at, revoked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'secret-move',
      'u1',
      'persona:legacy:alpha',
      'slack',
      'key-2',
      'payload-move',
      null,
      null,
      null,
      '2026-04-22T00:00:00.000Z',
      '2026-04-22T01:00:00.000Z',
    );

    migrateWorkspaceScope(db, {
      userId: 'u1',
      fromWorkspaceId: 'persona:legacy:alpha',
      toWorkspaceId: 'persona:master:alpha',
    });

    expect(
      db.prepare('SELECT decision FROM master_approval_rules WHERE id = ?').get('rule-target'),
    ).toEqual({ decision: 'approve_always' });
    expect(
      db
        .prepare('SELECT COUNT(*) AS total FROM master_approval_rules WHERE id = ?')
        .get('rule-old'),
    ).toEqual({ total: 0 });

    expect(
      db
        .prepare('SELECT confidence, benchmark_summary FROM master_capability_scores WHERE id = ?')
        .get('cap-target'),
    ).toEqual({ confidence: 0.9, benchmark_summary: 'new summary' });
    expect(
      db
        .prepare('SELECT COUNT(*) AS total FROM master_capability_scores WHERE id = ?')
        .get('cap-old'),
    ).toEqual({ total: 0 });

    expect(
      db
        .prepare('SELECT encrypted_payload, revoked_at FROM master_connector_secrets WHERE id = ?')
        .get('secret-target'),
    ).toEqual({ encrypted_payload: 'payload-new', revoked_at: null });
    expect(
      db
        .prepare('SELECT workspace_id FROM master_connector_secrets WHERE id = ?')
        .get('secret-move'),
    ).toEqual({ workspace_id: 'persona:master:alpha' });
  });
});
