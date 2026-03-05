import crypto from 'node:crypto';
import { queryAll, queryOne, run, transaction } from '@/lib/db';

export interface StoredEngineeringSnapshot {
  windowDays: 7 | 30;
  payload: Record<string, unknown>;
  source: string;
  generatedAt: string;
  createdAt: string;
}

export interface StoredEngineeringRolloutBaseline {
  id: string;
  windowStart: string;
  windowEnd: string;
  payload: Record<string, unknown>;
  source: string;
  baselineHash: string;
  createdAt: string;
}

export interface StoredEngineeringRolloutGateRun {
  id: string;
  phaseId: string | null;
  status: 'pass' | 'fail' | 'unknown';
  payload: Record<string, unknown>;
  generatedAt: string;
  createdAt: string;
}

export interface EngineeringPrFact {
  prNumber: number;
  createdAt: string;
  mergedAt: string;
  additions: number;
  deletions: number;
  firstPassBlocking: boolean;
  reverted: boolean;
}

export interface HarnessRunEvent {
  traceId?: string | null;
  spanId?: string | null;
  serviceName: string;
  domain?: string | null;
  lane: string;
  scenario?: string | null;
  status: 'success' | 'failure' | 'cancelled' | 'skipped';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  worktreeId?: string | null;
  commitSha?: string | null;
  errorKind?: string | null;
  runUrl?: string | null;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function hasIngestReceipt(idempotencyKey: string): boolean {
  const row = queryOne<{ idempotency_key: string }>(
    'SELECT idempotency_key FROM engineering_ingest_receipts WHERE idempotency_key = ?',
    [idempotencyKey],
  );
  return Boolean(row?.idempotency_key);
}

export function createIngestReceipt(idempotencyKey: string, receivedAt: string): void {
  run('INSERT INTO engineering_ingest_receipts (idempotency_key, received_at) VALUES (?, ?)', [
    idempotencyKey,
    receivedAt,
  ]);
}

export function storeEngineeringSnapshot(input: {
  windowDays: 7 | 30;
  payload: Record<string, unknown>;
  source: string;
  generatedAt: string;
}): void {
  const id = `es-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  run(
    `INSERT INTO engineering_metrics_snapshots (id, window_days, payload_json, source, generated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, input.windowDays, JSON.stringify(input.payload), input.source, input.generatedAt],
  );
}

export function replaceEngineeringPrFacts(facts: EngineeringPrFact[]): void {
  transaction(() => {
    run('DELETE FROM engineering_pr_facts');
    for (const fact of facts) {
      const id = `pr-${fact.prNumber}-${fact.mergedAt}`;
      run(
        `INSERT INTO engineering_pr_facts (
          id, pr_number, created_at, merged_at, additions, deletions, first_pass_blocking, reverted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          fact.prNumber,
          fact.createdAt,
          fact.mergedAt,
          fact.additions,
          fact.deletions,
          fact.firstPassBlocking ? 1 : 0,
          fact.reverted ? 1 : 0,
        ],
      );
    }
  });
}

export function appendHarnessRunEvents(events: HarnessRunEvent[]): void {
  transaction(() => {
    for (const event of events) {
      const id = `he-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      run(
        `INSERT INTO harness_run_events (
          id, trace_id, span_id, service_name, domain, lane, scenario, status, started_at, finished_at, duration_ms, worktree_id, commit_sha, error_kind, run_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          event.traceId || null,
          event.spanId || null,
          event.serviceName,
          event.domain || null,
          event.lane,
          event.scenario || null,
          event.status,
          event.startedAt,
          event.finishedAt,
          Math.max(0, Math.floor(event.durationMs)),
          event.worktreeId || null,
          event.commitSha || null,
          event.errorKind || null,
          event.runUrl || null,
        ],
      );
    }
  });
}

export function pruneHarnessRunEventsBefore(cutoffIso: string): number {
  const result = run('DELETE FROM harness_run_events WHERE finished_at < ?', [cutoffIso]);
  return Number(result.changes || 0);
}

export function getLatestEngineeringSnapshot(windowDays: 7 | 30): StoredEngineeringSnapshot | null {
  const row = queryOne<{
    window_days: number;
    payload_json: string;
    source: string;
    generated_at: string;
    created_at: string;
  }>(
    `SELECT window_days, payload_json, source, generated_at, created_at
     FROM engineering_metrics_snapshots
     WHERE window_days = ?
     ORDER BY generated_at DESC
     LIMIT 1`,
    [windowDays],
  );

  if (!row) return null;
  const payload = parseJsonObject(row.payload_json);
  if (!payload) return null;
  return {
    windowDays: row.window_days as 7 | 30,
    payload,
    source: row.source,
    generatedAt: row.generated_at,
    createdAt: row.created_at,
  };
}

export function storeEngineeringRolloutBaseline(input: {
  id: string;
  windowStart: string;
  windowEnd: string;
  payload: Record<string, unknown>;
  source: string;
  baselineHash: string;
}): void {
  run(
    `INSERT OR IGNORE INTO engineering_rollout_baselines (
      id, window_start, window_end, payload_json, source, baseline_hash
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.windowStart,
      input.windowEnd,
      JSON.stringify(input.payload),
      input.source,
      input.baselineHash,
    ],
  );
}

export function getEngineeringRolloutBaselineById(
  id: string,
): StoredEngineeringRolloutBaseline | null {
  const row = queryOne<{
    id: string;
    window_start: string;
    window_end: string;
    payload_json: string;
    source: string;
    baseline_hash: string;
    created_at: string;
  }>(
    `SELECT id, window_start, window_end, payload_json, source, baseline_hash, created_at
     FROM engineering_rollout_baselines
     WHERE id = ?
     LIMIT 1`,
    [id],
  );

  if (!row) return null;
  const payload = parseJsonObject(row.payload_json);
  if (!payload) return null;
  return {
    id: row.id,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    payload,
    source: row.source,
    baselineHash: row.baseline_hash,
    createdAt: row.created_at,
  };
}

export function getLatestEngineeringRolloutBaseline(): StoredEngineeringRolloutBaseline | null {
  const row = queryOne<{
    id: string;
    window_start: string;
    window_end: string;
    payload_json: string;
    source: string;
    baseline_hash: string;
    created_at: string;
  }>(
    `SELECT id, window_start, window_end, payload_json, source, baseline_hash, created_at
     FROM engineering_rollout_baselines
     ORDER BY created_at DESC
     LIMIT 1`,
  );

  if (!row) return null;
  const payload = parseJsonObject(row.payload_json);
  if (!payload) return null;
  return {
    id: row.id,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    payload,
    source: row.source,
    baselineHash: row.baseline_hash,
    createdAt: row.created_at,
  };
}

export function storeEngineeringRolloutGateRun(input: {
  phaseId: string | null;
  status: 'pass' | 'fail' | 'unknown';
  payload: Record<string, unknown>;
  generatedAt: string;
}): void {
  const id = `gr-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  run(
    `INSERT INTO engineering_rollout_gate_runs (id, phase_id, status, payload_json, generated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, input.phaseId, input.status, JSON.stringify(input.payload), input.generatedAt],
  );
}

export function getLatestEngineeringRolloutGateRun(): StoredEngineeringRolloutGateRun | null {
  const row = queryOne<{
    id: string;
    phase_id: string | null;
    status: 'pass' | 'fail' | 'unknown';
    payload_json: string;
    generated_at: string;
    created_at: string;
  }>(
    `SELECT id, phase_id, status, payload_json, generated_at, created_at
     FROM engineering_rollout_gate_runs
     ORDER BY generated_at DESC
     LIMIT 1`,
  );
  if (!row) return null;
  const payload = parseJsonObject(row.payload_json);
  if (!payload) return null;
  return {
    id: row.id,
    phaseId: row.phase_id,
    status: row.status,
    payload,
    generatedAt: row.generated_at,
    createdAt: row.created_at,
  };
}

export function getHarnessLaneStats(fromIso: string): Array<{
  lane: string;
  totalRuns: number;
  successRuns: number;
  medianDurationMs: number | null;
  flakySuspicions: number;
}> {
  const rows = queryAll<{
    lane: string;
    total_runs: number;
    success_runs: number;
    median_duration_ms: number | null;
    flaky_suspicions: number;
  }>(
    `SELECT
      lane,
      COUNT(*) AS total_runs,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_runs,
      CAST(AVG(duration_ms) AS INTEGER) AS median_duration_ms,
      SUM(CASE WHEN status = 'failure' OR status = 'cancelled' THEN 1 ELSE 0 END) AS flaky_suspicions
     FROM harness_run_events
     WHERE finished_at >= ?
     GROUP BY lane`,
    [fromIso],
  );

  return rows.map((row) => ({
    lane: row.lane,
    totalRuns: Number(row.total_runs || 0),
    successRuns: Number(row.success_runs || 0),
    medianDurationMs: row.median_duration_ms === null ? null : Number(row.median_duration_ms),
    flakySuspicions: Number(row.flaky_suspicions || 0),
  }));
}

export function getHarnessDomainStats(fromIso: string): Array<{
  domain: string;
  totalRuns: number;
  successRuns: number;
}> {
  const rows = queryAll<{
    domain: string | null;
    total_runs: number;
    success_runs: number;
  }>(
    `SELECT
      domain,
      COUNT(*) AS total_runs,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_runs
     FROM harness_run_events
     WHERE finished_at >= ? AND domain IS NOT NULL AND TRIM(domain) != ''
     GROUP BY domain`,
    [fromIso],
  );

  return rows.map((row) => ({
    domain: String(row.domain || '').trim(),
    totalRuns: Number(row.total_runs || 0),
    successRuns: Number(row.success_runs || 0),
  }));
}

export function getHarnessScenarioStats(fromIso: string): Array<{
  scenario: string;
  totalRuns: number;
  successRuns: number;
  flakySuspicions: number;
}> {
  const rows = queryAll<{
    scenario: string | null;
    total_runs: number;
    success_runs: number;
    flaky_suspicions: number;
  }>(
    `SELECT
      scenario,
      COUNT(*) AS total_runs,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_runs,
      SUM(CASE WHEN status = 'failure' OR status = 'cancelled' THEN 1 ELSE 0 END) AS flaky_suspicions
     FROM harness_run_events
     WHERE finished_at >= ? AND scenario IS NOT NULL AND TRIM(scenario) != ''
     GROUP BY scenario`,
    [fromIso],
  );

  return rows.map((row) => ({
    scenario: String(row.scenario || '').trim(),
    totalRuns: Number(row.total_runs || 0),
    successRuns: Number(row.success_runs || 0),
    flakySuspicions: Number(row.flaky_suspicions || 0),
  }));
}

export function getHarnessWorktreeStats(fromIso: string): Array<{
  worktreeId: string;
  totalRuns: number;
  successRuns: number;
  lastFinishedAt: string | null;
}> {
  const rows = queryAll<{
    worktree_id: string | null;
    total_runs: number;
    success_runs: number;
    last_finished_at: string | null;
  }>(
    `SELECT
      worktree_id,
      COUNT(*) AS total_runs,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_runs,
      MAX(finished_at) AS last_finished_at
     FROM harness_run_events
     WHERE finished_at >= ? AND worktree_id IS NOT NULL AND TRIM(worktree_id) != ''
     GROUP BY worktree_id`,
    [fromIso],
  );

  return rows.map((row) => ({
    worktreeId: String(row.worktree_id || '').trim(),
    totalRuns: Number(row.total_runs || 0),
    successRuns: Number(row.success_runs || 0),
    lastFinishedAt: row.last_finished_at ? String(row.last_finished_at) : null,
  }));
}

export function getGuardianAutoRevertCount(fromIso: string): number {
  const row = queryOne<{ total: number }>(
    `SELECT COUNT(*) AS total
     FROM harness_run_events
     WHERE finished_at >= ?
       AND lane = 'main-guardian'
       AND scenario = 'guardian-auto-revert'
       AND status = 'success'`,
    [fromIso],
  );
  return Number(row?.total || 0);
}
