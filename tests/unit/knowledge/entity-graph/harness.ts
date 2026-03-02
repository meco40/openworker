import { afterEach, beforeEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { SqliteKnowledgeRepository } from '@/server/knowledge/sqliteKnowledgeRepository';
import { getTestArtifactsRoot } from '../../../helpers/testArtifacts';
import { cleanupSqliteArtifacts } from '../../../helpers/sqliteTestArtifacts';

const TEST_DB_DIR = getTestArtifactsRoot();

export function setupEntityGraphHarness() {
  let dbPath = '';
  let repo: SqliteKnowledgeRepository;

  beforeEach(() => {
    if (!existsSync(TEST_DB_DIR)) {
      mkdirSync(TEST_DB_DIR, { recursive: true });
    }
    dbPath = `${TEST_DB_DIR}/test-entity-graph-${Date.now()}-${Math.random().toString(16).slice(2)}.db`;
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
      // ignore Windows EBUSY
    }
  });

  return {
    getRepo: () => repo,
  };
}
