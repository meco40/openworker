import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import type { ProactiveRepository } from '@/server/proactive/repository';
import type { ProactiveDecision, ProactiveSignalInput, ProactiveSummaryRow } from '@/server/proactive/types';

interface ProactiveDecisionRow {
  id: string;
  user_id: string;
  persona_id: string;
  candidate_key: ProactiveDecision['candidateKey'];
  decision: ProactiveDecision['decision'];
  score: number;
  reason: string;
  created_at: string;
}

function rowToDecision(row: ProactiveDecisionRow): ProactiveDecision {
  return {
    id: row.id,
    userId: row.user_id,
    personaId: row.persona_id,
    candidateKey: row.candidate_key,
    decision: row.decision,
    score: row.score,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export class SqliteProactiveRepository implements ProactiveRepository {
  private readonly db: ReturnType<typeof BetterSqlite3>;

  constructor(
    dbPath = process.env.PROACTIVE_DB_PATH || process.env.MESSAGES_DB_PATH || '.local/messages.db',
  ) {
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
      CREATE TABLE IF NOT EXISTS proactive_signals (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        persona_id TEXT NOT NULL,
        signal_key TEXT NOT NULL,
        weight REAL NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proactive_decisions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        persona_id TEXT NOT NULL,
        candidate_key TEXT NOT NULL,
        decision TEXT NOT NULL,
        score REAL NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_proactive_signals_persona_time
      ON proactive_signals (user_id, persona_id, created_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_proactive_signals_key
      ON proactive_signals (user_id, persona_id, signal_key, created_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_proactive_decisions_persona_time
      ON proactive_decisions (user_id, persona_id, created_at DESC);
    `);
  }

  insertSignals(signals: ProactiveSignalInput[]): number {
    if (signals.length === 0) return 0;

    const stmt = this.db.prepare(`
      INSERT INTO proactive_signals (
        id, user_id, persona_id, signal_key, weight, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const runTx = this.db.transaction((items: ProactiveSignalInput[]) => {
      let inserted = 0;
      for (const item of items) {
        stmt.run(
          `ps-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
          item.userId,
          item.personaId,
          item.signalKey,
          item.weight,
          item.source,
          item.createdAt,
        );
        inserted += 1;
      }
      return inserted;
    });

    return runTx(signals);
  }

  summarizeSignals(userId: string, personaId: string, sinceIso: string): ProactiveSummaryRow[] {
    const rows = this.db
      .prepare(
        `
        SELECT
          signal_key,
          SUM(weight) AS total_weight,
          COUNT(*) AS occurrences,
          MAX(created_at) AS last_seen_at
        FROM proactive_signals
        WHERE user_id = ? AND persona_id = ? AND created_at >= ?
        GROUP BY signal_key
      `,
      )
      .all(userId, personaId, sinceIso) as Array<{
      signal_key: string;
      total_weight: number;
      occurrences: number;
      last_seen_at: string;
    }>;

    return rows.map((row) => ({
      signalKey: row.signal_key,
      totalWeight: Number(row.total_weight || 0),
      occurrences: Number(row.occurrences || 0),
      lastSeenAt: row.last_seen_at,
    }));
  }

  listRecentDecisions(userId: string, personaId: string, limit = 20): ProactiveDecision[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 20;
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM proactive_decisions
        WHERE user_id = ? AND persona_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
      )
      .all(userId, personaId, safeLimit) as ProactiveDecisionRow[];
    return rows.map((row) => rowToDecision(row));
  }

  insertDecision(
    input: Omit<ProactiveDecision, 'id' | 'createdAt'> & { createdAt?: string },
  ): ProactiveDecision {
    const decision: ProactiveDecision = {
      id: `pd-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      createdAt: input.createdAt || new Date().toISOString(),
      userId: input.userId,
      personaId: input.personaId,
      candidateKey: input.candidateKey,
      decision: input.decision,
      score: input.score,
      reason: input.reason,
    };

    this.db
      .prepare(
        `
        INSERT INTO proactive_decisions (
          id, user_id, persona_id, candidate_key, decision, score, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        decision.id,
        decision.userId,
        decision.personaId,
        decision.candidateKey,
        decision.decision,
        decision.score,
        decision.reason,
        decision.createdAt,
      );

    return decision;
  }
}
