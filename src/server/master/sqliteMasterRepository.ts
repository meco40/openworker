import crypto from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { openSqliteDatabase } from '@/server/db/sqlite';
import { runMasterMigrations } from '@/server/master/migrations';
import type { MasterRepository } from '@/server/master/repository';
import type {
  ApprovalDecision,
  MasterActionLedgerEntry,
  MasterCapabilityProposal,
  MasterCapabilityScore,
  MasterConnectorSecret,
  MasterAuditEvent,
  MasterDelegationEvent,
  MasterDelegationJob,
  MasterFeedback,
  MasterNote,
  MasterReminder,
  MasterRun,
  MasterRunCreateInput,
  MasterStep,
  MasterToolForgeArtifact,
  WorkspaceScope,
} from '@/server/master/types';

type SqlPatch = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

function toBool(value: unknown): boolean {
  return Boolean(value);
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

function toRun(row: Record<string, unknown>): MasterRun {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    title: String(row.title),
    contract: String(row.contract),
    status: row.status as MasterRun['status'],
    progress: Number(row.progress ?? 0),
    verificationPassed: toBool(row.verification_passed),
    resultBundle: row.result_bundle ? String(row.result_bundle) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastError: row.last_error ? String(row.last_error) : null,
    pausedForApproval: toBool(row.paused_for_approval),
    pendingApprovalActionType: row.pending_approval_action_type
      ? String(row.pending_approval_action_type)
      : null,
    cancelledAt: row.cancelled_at ? String(row.cancelled_at) : null,
    cancelReason: row.cancel_reason ? String(row.cancel_reason) : null,
  };
}

function toStep(row: Record<string, unknown>): MasterStep {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    seq: Number(row.seq),
    phase: String(row.phase),
    status: row.status as MasterStep['status'],
    input: row.input ? String(row.input) : null,
    output: row.output ? String(row.output) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toFeedback(row: Record<string, unknown>): MasterFeedback {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    rating: Number(row.rating),
    policy: row.policy as MasterFeedback['policy'],
    comment: row.comment ? String(row.comment) : null,
    createdAt: String(row.created_at),
  };
}

function toNote(row: Record<string, unknown>): MasterNote {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    title: String(row.title),
    content: String(row.content),
    tags: parseJsonArray(row.tags),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toReminder(row: Record<string, unknown>): MasterReminder {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    title: String(row.title),
    message: String(row.message),
    remindAt: String(row.remind_at),
    cronExpression: row.cron_expression ? String(row.cron_expression) : null,
    status: row.status as MasterReminder['status'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class SqliteMasterRepository implements MasterRepository {
  private readonly db: ReturnType<typeof BetterSqlite3>;

  constructor(dbPath = process.env.MASTER_DB_PATH || '.local/master.db') {
    this.db = openSqliteDatabase({ dbPath });
    runMasterMigrations(this.db);
  }

  private getRunRow(scope: WorkspaceScope, runId: string): Record<string, unknown> | undefined {
    return this.db
      .prepare('SELECT * FROM master_runs WHERE id = ? AND user_id = ? AND workspace_id = ?')
      .get(runId, scope.userId, scope.workspaceId) as Record<string, unknown> | undefined;
  }

  createRun(input: MasterRunCreateInput): MasterRun {
    const id = crypto.randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO master_runs (
           id, user_id, workspace_id, title, contract, status, progress, verification_passed,
           result_bundle, last_error, paused_for_approval, cancelled_at, cancel_reason, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'ANALYZING', 0, 0, NULL, NULL, 0, NULL, NULL, ?, ?)`,
      )
      .run(id, input.userId, input.workspaceId, input.title, input.contract, now, now);
    return this.getRun({ userId: input.userId, workspaceId: input.workspaceId }, id)!;
  }

  getRun(scope: WorkspaceScope, runId: string): MasterRun | null {
    const row = this.getRunRow(scope, runId);
    return row ? toRun(row) : null;
  }

  listRuns(scope: WorkspaceScope, limit = 50): MasterRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM master_runs
         WHERE user_id = ? AND workspace_id = ?
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(scope.userId, scope.workspaceId, limit) as Array<Record<string, unknown>>;
    return rows.map(toRun);
  }

  updateRun(scope: WorkspaceScope, runId: string, patch: Partial<MasterRun>): MasterRun | null {
    const updates: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      title: 'title',
      contract: 'contract',
      status: 'status',
      progress: 'progress',
      verificationPassed: 'verification_passed',
      resultBundle: 'result_bundle',
      lastError: 'last_error',
      pausedForApproval: 'paused_for_approval',
      pendingApprovalActionType: 'pending_approval_action_type',
      cancelledAt: 'cancelled_at',
      cancelReason: 'cancel_reason',
    };
    for (const [key, column] of Object.entries(map)) {
      if (!(key in patch)) continue;
      updates.push(`${column} = ?`);
      const value = (patch as SqlPatch)[key];
      if (key === 'verificationPassed' || key === 'pausedForApproval') {
        values.push(value ? 1 : 0);
      } else {
        values.push(value ?? null);
      }
    }
    if (updates.length === 0) return this.getRun(scope, runId);
    updates.push('updated_at = ?');
    values.push(nowIso(), runId, scope.userId, scope.workspaceId);
    this.db
      .prepare(
        `UPDATE master_runs SET ${updates.join(', ')}
         WHERE id = ? AND user_id = ? AND workspace_id = ?`,
      )
      .run(...values);
    return this.getRun(scope, runId);
  }

  appendStep(
    scope: WorkspaceScope,
    runId: string,
    step: Omit<MasterStep, 'id' | 'createdAt' | 'updatedAt'>,
  ): MasterStep {
    const id = crypto.randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO master_steps (
           id, run_id, user_id, workspace_id, seq, phase, status, input, output, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        runId,
        scope.userId,
        scope.workspaceId,
        step.seq,
        step.phase,
        step.status,
        step.input ?? null,
        step.output ?? null,
        now,
        now,
      );
    const row = this.db.prepare('SELECT * FROM master_steps WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    return toStep(row);
  }

  listSteps(scope: WorkspaceScope, runId: string): MasterStep[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM master_steps
         WHERE user_id = ? AND workspace_id = ? AND run_id = ?
         ORDER BY seq ASC`,
      )
      .all(scope.userId, scope.workspaceId, runId) as Array<Record<string, unknown>>;
    return rows.map(toStep);
  }

  addFeedback(
    scope: WorkspaceScope,
    feedback: Omit<MasterFeedback, 'id' | 'createdAt'>,
  ): MasterFeedback {
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO master_feedback (id, run_id, user_id, workspace_id, rating, policy, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        feedback.runId,
        scope.userId,
        scope.workspaceId,
        feedback.rating,
        feedback.policy,
        feedback.comment ?? null,
        createdAt,
      );
    const row = this.db.prepare('SELECT * FROM master_feedback WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    return toFeedback(row);
  }

  createNote(
    scope: WorkspaceScope,
    input: Omit<MasterNote, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>,
  ): MasterNote {
    const id = crypto.randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO master_notes (
           id, user_id, workspace_id, title, content, tags, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        scope.userId,
        scope.workspaceId,
        input.title,
        input.content,
        JSON.stringify(input.tags || []),
        now,
        now,
      );
    const row = this.db.prepare('SELECT * FROM master_notes WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    return toNote(row);
  }

  listNotes(scope: WorkspaceScope, limit = 100): MasterNote[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM master_notes
         WHERE user_id = ? AND workspace_id = ?
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(scope.userId, scope.workspaceId, limit) as Array<Record<string, unknown>>;
    return rows.map(toNote);
  }

  updateNote(
    scope: WorkspaceScope,
    noteId: string,
    patch: Partial<Pick<MasterNote, 'title' | 'content' | 'tags'>>,
  ): MasterNote | null {
    const updates: string[] = [];
    const values: unknown[] = [];
    if (patch.title !== undefined) {
      updates.push('title = ?');
      values.push(patch.title);
    }
    if (patch.content !== undefined) {
      updates.push('content = ?');
      values.push(patch.content);
    }
    if (patch.tags !== undefined) {
      updates.push('tags = ?');
      values.push(JSON.stringify(patch.tags));
    }
    if (updates.length === 0) return null;
    updates.push('updated_at = ?');
    values.push(nowIso(), noteId, scope.userId, scope.workspaceId);
    this.db
      .prepare(
        `UPDATE master_notes SET ${updates.join(', ')}
         WHERE id = ? AND user_id = ? AND workspace_id = ?`,
      )
      .run(...values);
    const row = this.db
      .prepare('SELECT * FROM master_notes WHERE id = ? AND user_id = ? AND workspace_id = ?')
      .get(noteId, scope.userId, scope.workspaceId) as Record<string, unknown> | undefined;
    return row ? toNote(row) : null;
  }

  deleteNote(scope: WorkspaceScope, noteId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM master_notes WHERE id = ? AND user_id = ? AND workspace_id = ?')
      .run(noteId, scope.userId, scope.workspaceId);
    return result.changes > 0;
  }

  createReminder(
    scope: WorkspaceScope,
    input: Omit<MasterReminder, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>,
  ): MasterReminder {
    const id = crypto.randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO master_reminders (
           id, user_id, workspace_id, title, message, remind_at, cron_expression, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        scope.userId,
        scope.workspaceId,
        input.title,
        input.message,
        input.remindAt,
        input.cronExpression ?? null,
        input.status,
        now,
        now,
      );
    const row = this.db.prepare('SELECT * FROM master_reminders WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    return toReminder(row);
  }

  listReminders(scope: WorkspaceScope, limit = 100): MasterReminder[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM master_reminders
         WHERE user_id = ? AND workspace_id = ?
         ORDER BY remind_at ASC LIMIT ?`,
      )
      .all(scope.userId, scope.workspaceId, limit) as Array<Record<string, unknown>>;
    return rows.map(toReminder);
  }

  updateReminder(
    scope: WorkspaceScope,
    reminderId: string,
    patch: Partial<MasterReminder>,
  ): MasterReminder | null {
    const updates: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      title: 'title',
      message: 'message',
      remindAt: 'remind_at',
      cronExpression: 'cron_expression',
      status: 'status',
    };
    for (const [key, column] of Object.entries(map)) {
      if (!(key in patch)) continue;
      updates.push(`${column} = ?`);
      values.push((patch as SqlPatch)[key] ?? null);
    }
    if (updates.length === 0) return null;
    updates.push('updated_at = ?');
    values.push(nowIso(), reminderId, scope.userId, scope.workspaceId);
    this.db
      .prepare(
        `UPDATE master_reminders SET ${updates.join(', ')}
         WHERE id = ? AND user_id = ? AND workspace_id = ?`,
      )
      .run(...values);
    const row = this.db
      .prepare('SELECT * FROM master_reminders WHERE id = ? AND user_id = ? AND workspace_id = ?')
      .get(reminderId, scope.userId, scope.workspaceId) as Record<string, unknown> | undefined;
    return row ? toReminder(row) : null;
  }

  deleteReminder(scope: WorkspaceScope, reminderId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM master_reminders WHERE id = ? AND user_id = ? AND workspace_id = ?')
      .run(reminderId, scope.userId, scope.workspaceId);
    return result.changes > 0;
  }

  private toDelegationJob(row: Record<string, unknown>): MasterDelegationJob {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      userId: String(row.user_id),
      workspaceId: String(row.workspace_id),
      capability: String(row.capability),
      payload: String(row.payload),
      status: row.status as MasterDelegationJob['status'],
      priority: row.priority as MasterDelegationJob['priority'],
      attempts: Number(row.attempts ?? 0),
      maxAttempts: Number(row.max_attempts ?? 3),
      timeoutMs: Number(row.timeout_ms ?? 120000),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastError: row.last_error ? String(row.last_error) : null,
    };
  }

  createDelegationJob(
    scope: WorkspaceScope,
    job: Omit<
      MasterDelegationJob,
      'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'attempts' | 'lastError'
    >,
  ): MasterDelegationJob {
    const id = crypto.randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO master_subagent_jobs (
           id, run_id, user_id, workspace_id, capability, payload, status, priority,
           attempts, max_attempts, timeout_ms, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        job.runId,
        scope.userId,
        scope.workspaceId,
        job.capability,
        job.payload,
        job.status,
        job.priority,
        job.maxAttempts,
        job.timeoutMs,
        now,
        now,
      );
    return this.listDelegationJobs(scope, job.runId).find((entry) => entry.id === id)!;
  }

  updateDelegationJob(
    scope: WorkspaceScope,
    jobId: string,
    patch: Partial<MasterDelegationJob>,
  ): MasterDelegationJob | null {
    const updates: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      status: 'status',
      attempts: 'attempts',
      lastError: 'last_error',
      payload: 'payload',
      priority: 'priority',
      timeoutMs: 'timeout_ms',
      maxAttempts: 'max_attempts',
    };
    for (const [key, column] of Object.entries(map)) {
      if (!(key in patch)) continue;
      updates.push(`${column} = ?`);
      values.push((patch as SqlPatch)[key] ?? null);
    }
    if (updates.length === 0) return null;
    updates.push('updated_at = ?');
    values.push(nowIso(), jobId, scope.userId, scope.workspaceId);
    this.db
      .prepare(
        `UPDATE master_subagent_jobs SET ${updates.join(', ')}
         WHERE id = ? AND user_id = ? AND workspace_id = ?`,
      )
      .run(...values);
    const row = this.db
      .prepare(
        'SELECT * FROM master_subagent_jobs WHERE id = ? AND user_id = ? AND workspace_id = ?',
      )
      .get(jobId, scope.userId, scope.workspaceId) as Record<string, unknown> | undefined;
    return row ? this.toDelegationJob(row) : null;
  }

  listDelegationJobs(scope: WorkspaceScope, runId: string): MasterDelegationJob[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM master_subagent_jobs
         WHERE user_id = ? AND workspace_id = ? AND run_id = ?
         ORDER BY created_at ASC`,
      )
      .all(scope.userId, scope.workspaceId, runId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.toDelegationJob(row));
  }

  appendDelegationEvent(
    scope: WorkspaceScope,
    event: Omit<MasterDelegationEvent, 'id' | 'userId' | 'workspaceId' | 'createdAt'>,
  ): MasterDelegationEvent {
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO master_subagent_events (
           id, job_id, run_id, user_id, workspace_id, type, payload, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        event.jobId,
        event.runId,
        scope.userId,
        scope.workspaceId,
        event.type,
        event.payload,
        createdAt,
      );
    return {
      id,
      jobId: event.jobId,
      runId: event.runId,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      type: event.type,
      payload: event.payload,
      createdAt,
    };
  }

  listDelegationEvents(scope: WorkspaceScope, runId: string): MasterDelegationEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM master_subagent_events
         WHERE user_id = ? AND workspace_id = ? AND run_id = ?
         ORDER BY created_at ASC`,
      )
      .all(scope.userId, scope.workspaceId, runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      jobId: String(row.job_id),
      runId: String(row.run_id),
      userId: String(row.user_id),
      workspaceId: String(row.workspace_id),
      type: row.type as MasterDelegationEvent['type'],
      payload: String(row.payload),
      createdAt: String(row.created_at),
    }));
  }
  upsertActionLedger(
    scope: WorkspaceScope,
    entry: Omit<
      MasterActionLedgerEntry,
      'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'
    >,
  ): MasterActionLedgerEntry {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO master_action_ledger (
           id, run_id, user_id, workspace_id, step_id, action_type, idempotency_key, state, result_payload, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO UPDATE SET
           state = excluded.state,
           result_payload = excluded.result_payload,
           updated_at = excluded.updated_at`,
      )
      .run(
        crypto.randomUUID(),
        entry.runId,
        scope.userId,
        scope.workspaceId,
        entry.stepId,
        entry.actionType,
        entry.idempotencyKey,
        entry.state,
        entry.resultPayload ?? null,
        now,
        now,
      );
    return this.getActionLedgerByKey(scope, entry.idempotencyKey)!;
  }

  getActionLedgerByKey(
    scope: WorkspaceScope,
    idempotencyKey: string,
  ): MasterActionLedgerEntry | null {
    const row = this.db
      .prepare(
        `SELECT * FROM master_action_ledger
         WHERE idempotency_key = ? AND user_id = ? AND workspace_id = ?`,
      )
      .get(idempotencyKey, scope.userId, scope.workspaceId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      runId: String(row.run_id),
      userId: String(row.user_id),
      workspaceId: String(row.workspace_id),
      stepId: String(row.step_id),
      actionType: String(row.action_type),
      idempotencyKey: String(row.idempotency_key),
      state: row.state as MasterActionLedgerEntry['state'],
      resultPayload: row.result_payload ? String(row.result_payload) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  upsertApprovalRule(
    scope: WorkspaceScope,
    actionType: string,
    fingerprint: string,
    decision: ApprovalDecision,
  ): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO master_approval_rules (
           id, user_id, workspace_id, action_type, fingerprint, decision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, workspace_id, action_type, fingerprint)
         DO UPDATE SET decision = excluded.decision, updated_at = excluded.updated_at`,
      )
      .run(
        crypto.randomUUID(),
        scope.userId,
        scope.workspaceId,
        actionType,
        fingerprint,
        decision,
        now,
        now,
      );
  }

  getApprovalRule(
    scope: WorkspaceScope,
    actionType: string,
    fingerprint: string,
  ): ApprovalDecision | null {
    const row = this.db
      .prepare(
        `SELECT decision FROM master_approval_rules
         WHERE user_id = ? AND workspace_id = ? AND action_type = ? AND fingerprint = ?`,
      )
      .get(scope.userId, scope.workspaceId, actionType, fingerprint) as
      | { decision: ApprovalDecision }
      | undefined;
    return row?.decision || null;
  }

  upsertCapabilityScore(
    scope: WorkspaceScope,
    capability: string,
    confidence: number,
    benchmarkSummary: string,
    lastVerifiedAt: string | null,
  ): MasterCapabilityScore {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO master_capability_scores (
           id, user_id, workspace_id, capability, confidence, last_verified_at, benchmark_summary, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, workspace_id, capability)
         DO UPDATE SET
           confidence = excluded.confidence,
           last_verified_at = excluded.last_verified_at,
           benchmark_summary = excluded.benchmark_summary,
           updated_at = excluded.updated_at`,
      )
      .run(
        crypto.randomUUID(),
        scope.userId,
        scope.workspaceId,
        capability,
        confidence,
        lastVerifiedAt,
        benchmarkSummary,
        now,
      );
    return this.listCapabilityScores(scope).find((entry) => entry.capability === capability)!;
  }

  listCapabilityScores(scope: WorkspaceScope): MasterCapabilityScore[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM master_capability_scores
         WHERE user_id = ? AND workspace_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(scope.userId, scope.workspaceId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      workspaceId: String(row.workspace_id),
      capability: String(row.capability),
      confidence: Number(row.confidence),
      lastVerifiedAt: row.last_verified_at ? String(row.last_verified_at) : null,
      benchmarkSummary: String(row.benchmark_summary || '{}'),
      updatedAt: String(row.updated_at),
    }));
  }

  createCapabilityProposal(
    scope: WorkspaceScope,
    proposal: Omit<
      MasterCapabilityProposal,
      'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'
    >,
  ): MasterCapabilityProposal {
    const id = crypto.randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO master_capability_proposals (
           id, user_id, workspace_id, title, capability_key, status, proposal, fallback_plan, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        scope.userId,
        scope.workspaceId,
        proposal.title,
        proposal.capabilityKey,
        proposal.status,
        proposal.proposal,
        proposal.fallbackPlan,
        now,
        now,
      );
    return this.listCapabilityProposals(scope).find((entry) => entry.id === id)!;
  }

  listCapabilityProposals(scope: WorkspaceScope): MasterCapabilityProposal[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM master_capability_proposals
         WHERE user_id = ? AND workspace_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(scope.userId, scope.workspaceId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      workspaceId: String(row.workspace_id),
      title: String(row.title),
      capabilityKey: String(row.capability_key),
      status: row.status as MasterCapabilityProposal['status'],
      proposal: String(row.proposal),
      fallbackPlan: String(row.fallback_plan),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  createToolForgeArtifact(
    scope: WorkspaceScope,
    artifact: Omit<
      MasterToolForgeArtifact,
      'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'
    >,
  ): MasterToolForgeArtifact {
    const id = crypto.randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO master_toolforge_artifacts (
           id, user_id, workspace_id, name, spec, manifest, test_summary, risk_report, status, published_globally, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        scope.userId,
        scope.workspaceId,
        artifact.name,
        artifact.spec,
        artifact.manifest,
        artifact.testSummary,
        artifact.riskReport,
        artifact.status,
        artifact.publishedGlobally ? 1 : 0,
        now,
        now,
      );
    return this.listToolForgeArtifacts(scope).find((entry) => entry.id === id)!;
  }

  updateToolForgeArtifact(
    scope: WorkspaceScope,
    artifactId: string,
    patch: Partial<MasterToolForgeArtifact>,
  ): MasterToolForgeArtifact | null {
    const updates: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      name: 'name',
      spec: 'spec',
      manifest: 'manifest',
      testSummary: 'test_summary',
      riskReport: 'risk_report',
      status: 'status',
      publishedGlobally: 'published_globally',
    };
    for (const [key, column] of Object.entries(map)) {
      if (!(key in patch)) continue;
      updates.push(`${column} = ?`);
      if (key === 'publishedGlobally') {
        values.push((patch as SqlPatch)[key] ? 1 : 0);
      } else {
        values.push((patch as SqlPatch)[key] ?? null);
      }
    }
    if (updates.length === 0) return null;
    updates.push('updated_at = ?');
    values.push(nowIso(), artifactId, scope.userId, scope.workspaceId);
    this.db
      .prepare(
        `UPDATE master_toolforge_artifacts SET ${updates.join(', ')}
         WHERE id = ? AND user_id = ? AND workspace_id = ?`,
      )
      .run(...values);
    return this.listToolForgeArtifacts(scope).find((entry) => entry.id === artifactId) || null;
  }

  listToolForgeArtifacts(scope: WorkspaceScope): MasterToolForgeArtifact[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM master_toolforge_artifacts
         WHERE user_id = ? AND workspace_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(scope.userId, scope.workspaceId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      workspaceId: String(row.workspace_id),
      name: String(row.name),
      spec: String(row.spec),
      manifest: String(row.manifest),
      testSummary: String(row.test_summary),
      riskReport: String(row.risk_report),
      status: row.status as MasterToolForgeArtifact['status'],
      publishedGlobally: toBool(row.published_globally),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  listGlobalToolForgeArtifacts(limit = 200): MasterToolForgeArtifact[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM master_toolforge_artifacts
         WHERE published_globally = 1 AND status = 'published'
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      workspaceId: String(row.workspace_id),
      name: String(row.name),
      spec: String(row.spec),
      manifest: String(row.manifest),
      testSummary: String(row.test_summary),
      riskReport: String(row.risk_report),
      status: row.status as MasterToolForgeArtifact['status'],
      publishedGlobally: toBool(row.published_globally),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  upsertConnectorSecret(
    scope: WorkspaceScope,
    secret: Omit<
      MasterConnectorSecret,
      'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'
    >,
  ): MasterConnectorSecret {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO master_connector_secrets (
           id, user_id, workspace_id, provider, key_ref, encrypted_payload, issued_at, expires_at, revoked_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, workspace_id, provider, key_ref)
         DO UPDATE SET
           encrypted_payload = excluded.encrypted_payload,
           issued_at = excluded.issued_at,
           expires_at = excluded.expires_at,
           revoked_at = excluded.revoked_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        crypto.randomUUID(),
        scope.userId,
        scope.workspaceId,
        secret.provider,
        secret.keyRef,
        secret.encryptedPayload,
        secret.issuedAt,
        secret.expiresAt,
        secret.revokedAt,
        now,
        now,
      );
    return this.getConnectorSecret(scope, secret.provider, secret.keyRef)!;
  }

  getConnectorSecret(
    scope: WorkspaceScope,
    provider: string,
    keyRef: string,
  ): MasterConnectorSecret | null {
    const row = this.db
      .prepare(
        `SELECT * FROM master_connector_secrets
         WHERE user_id = ? AND workspace_id = ? AND provider = ? AND key_ref = ?`,
      )
      .get(scope.userId, scope.workspaceId, provider, keyRef) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      workspaceId: String(row.workspace_id),
      provider: String(row.provider),
      keyRef: String(row.key_ref),
      encryptedPayload: String(row.encrypted_payload),
      issuedAt: row.issued_at ? String(row.issued_at) : null,
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      revokedAt: row.revoked_at ? String(row.revoked_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  appendAuditEvent(
    scope: WorkspaceScope,
    input: Omit<MasterAuditEvent, 'id' | 'userId' | 'workspaceId' | 'createdAt'>,
  ): MasterAuditEvent {
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO master_audit_events (
           id, user_id, workspace_id, category, action, metadata, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        scope.userId,
        scope.workspaceId,
        input.category,
        input.action,
        input.metadata,
        createdAt,
      );
    return {
      id,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      category: input.category,
      action: input.action,
      metadata: input.metadata,
      createdAt,
    };
  }

  listAuditEvents(scope: WorkspaceScope, limit = 200): MasterAuditEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM master_audit_events
         WHERE user_id = ? AND workspace_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(scope.userId, scope.workspaceId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      workspaceId: String(row.workspace_id),
      category: String(row.category),
      action: String(row.action),
      metadata: String(row.metadata || '{}'),
      createdAt: String(row.created_at),
    }));
  }

  listKnownScopes(limit = 500): WorkspaceScope[] {
    const rows = this.db
      .prepare(
        `SELECT user_id, workspace_id FROM (
           SELECT user_id, workspace_id, updated_at AS ts FROM master_runs
           UNION ALL
           SELECT user_id, workspace_id, updated_at AS ts FROM master_capability_scores
         )
         GROUP BY user_id, workspace_id
         ORDER BY MAX(ts) DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{ user_id: string; workspace_id: string }>;
    return rows.map((row) => ({
      userId: String(row.user_id),
      workspaceId: String(row.workspace_id),
    }));
  }

  close(): void {
    this.db.close();
  }
}
