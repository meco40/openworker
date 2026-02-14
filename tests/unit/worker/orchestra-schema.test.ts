import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteWorkerRepository } from '../../../src/server/worker/workerRepository';

function getColumnNames(db: BetterSqlite3.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe('worker orchestra schema', () => {
  const createdPaths: string[] = [];

  afterEach(() => {
    for (const filePath of createdPaths.splice(0, createdPaths.length)) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // ignore
      }
    }
  });

  it('creates orchestra tables and task flow binding columns', () => {
    const filePath = path.join(
      os.tmpdir(),
      `worker-orchestra-schema-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    );
    createdPaths.push(filePath);

    new SqliteWorkerRepository(filePath);

    const db = new BetterSqlite3(filePath, { readonly: true });
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'worker_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const tableSet = new Set(tables.map((row) => row.name));

    expect(tableSet.has('worker_flow_templates')).toBe(true);
    expect(tableSet.has('worker_flow_drafts')).toBe(true);
    expect(tableSet.has('worker_flow_published')).toBe(true);
    expect(tableSet.has('worker_runs')).toBe(true);
    expect(tableSet.has('worker_run_nodes')).toBe(true);
    expect(tableSet.has('worker_subagent_sessions')).toBe(true);
    expect(tableSet.has('worker_task_deliverables')).toBe(true);

    const taskColumns = getColumnNames(db, 'worker_tasks');
    expect(taskColumns).toContain('flow_published_id');
    expect(taskColumns).toContain('current_run_id');

    const flowDraftColumns = getColumnNames(db, 'worker_flow_drafts');
    expect(flowDraftColumns).toContain('user_id');

    const flowPublishedColumns = getColumnNames(db, 'worker_flow_published');
    expect(flowPublishedColumns).toContain('user_id');
    expect(flowPublishedColumns).toContain('version');

    const runColumns = getColumnNames(db, 'worker_runs');
    expect(runColumns).toContain('task_id');
    expect(runColumns).toContain('flow_published_id');
    expect(runColumns).toContain('status');

    db.close();
  });
});
