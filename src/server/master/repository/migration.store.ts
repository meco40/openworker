import type { MasterSqliteDb } from '@/server/master/repository/db';

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

const SCOPE_SOURCE_TABLES = [
  { table: 'master_runs', timestampColumn: 'updated_at' },
  { table: 'master_steps', timestampColumn: 'updated_at' },
  { table: 'master_feedback', timestampColumn: 'created_at' },
  { table: 'master_notes', timestampColumn: 'updated_at' },
  { table: 'master_reminders', timestampColumn: 'updated_at' },
  { table: 'master_subagent_jobs', timestampColumn: 'updated_at' },
  { table: 'master_subagent_events', timestampColumn: 'created_at' },
  { table: 'master_subagent_sessions', timestampColumn: 'updated_at' },
  { table: 'master_action_ledger', timestampColumn: 'updated_at' },
  { table: 'master_approval_requests', timestampColumn: 'updated_at' },
  { table: 'master_approval_rules', timestampColumn: 'updated_at' },
  { table: 'master_tool_policies', timestampColumn: 'updated_at' },
  { table: 'master_capability_scores', timestampColumn: 'updated_at' },
  { table: 'master_capability_proposals', timestampColumn: 'updated_at' },
  { table: 'master_toolforge_artifacts', timestampColumn: 'updated_at' },
  { table: 'master_connector_secrets', timestampColumn: 'updated_at' },
  { table: 'master_audit_events', timestampColumn: 'created_at' },
] as const;

interface ScopeMigrationInput {
  userId: string;
  fromWorkspaceId: string;
  toWorkspaceId: string;
}

interface ApprovalRuleRow {
  id: string;
  action_type: string;
  fingerprint: string;
  decision: string;
  created_at: string;
  updated_at: string;
}

interface CapabilityScoreRow {
  id: string;
  capability: string;
  confidence: number;
  last_verified_at: string | null;
  benchmark_summary: string;
  updated_at: string;
}

interface ConnectorSecretRow {
  id: string;
  provider: string;
  key_ref: string;
  encrypted_payload: string;
  issued_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export function listAllKnownScopes(
  db: MasterSqliteDb,
  limit = 500,
): Array<{
  user_id: string;
  workspace_id: string;
}> {
  const unions = SCOPE_SOURCE_TABLES.map(
    ({ table, timestampColumn }) =>
      `SELECT user_id, workspace_id, MAX(${timestampColumn}) AS ts FROM ${table} GROUP BY user_id, workspace_id`,
  );
  const rows = db
    .prepare(
      `SELECT user_id, workspace_id FROM (
         ${unions.join('\nUNION ALL\n')}
       )
       GROUP BY user_id, workspace_id
       ORDER BY MAX(ts) DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{ user_id: string; workspace_id: string }>;
  return rows;
}

export function migrateUserLegacyScopesToMasterPersona(
  db: MasterSqliteDb,
  userId: string,
  masterPersonaId: string,
): number {
  const rows = listAllKnownScopes(db, 10_000).filter((row) => row.user_id === userId);
  let migratedScopes = 0;

  for (const row of rows) {
    const parsed = parsePersonaWorkspaceId(row.workspace_id);
    if (!parsed || parsed.personaId === masterPersonaId) {
      continue;
    }

    migrateWorkspaceScope(db, {
      userId,
      fromWorkspaceId: row.workspace_id,
      toWorkspaceId: `persona:${masterPersonaId}:${parsed.workspaceId}`,
    });
    migratedScopes += 1;
  }

  return migratedScopes;
}

export function migrateWorkspaceScope(db: MasterSqliteDb, input: ScopeMigrationInput): void {
  if (input.fromWorkspaceId === input.toWorkspaceId) {
    return;
  }

  db.transaction(() => {
    for (const table of SIMPLE_SCOPE_TABLES) {
      db.prepare(`UPDATE ${table} SET workspace_id = ? WHERE user_id = ? AND workspace_id = ?`).run(
        input.toWorkspaceId,
        input.userId,
        input.fromWorkspaceId,
      );
    }

    migrateApprovalRules(db, input);
    migrateCapabilityScores(db, input);
    migrateConnectorSecrets(db, input);
  })();
}

function migrateApprovalRules(db: MasterSqliteDb, input: ScopeMigrationInput): void {
  const oldRows = db
    .prepare(
      `SELECT * FROM master_approval_rules WHERE user_id = ? AND workspace_id = ? ORDER BY updated_at DESC`,
    )
    .all(input.userId, input.fromWorkspaceId) as ApprovalRuleRow[];
  const selectTarget = db.prepare(
    `SELECT * FROM master_approval_rules
     WHERE user_id = ? AND workspace_id = ? AND action_type = ? AND fingerprint = ? LIMIT 1`,
  );
  const updateTarget = db.prepare(
    `UPDATE master_approval_rules
     SET decision = ?, created_at = ?, updated_at = ?
     WHERE id = ?`,
  );
  const updateScope = db.prepare(`UPDATE master_approval_rules SET workspace_id = ? WHERE id = ?`);
  const deleteRow = db.prepare(`DELETE FROM master_approval_rules WHERE id = ?`);

  for (const row of oldRows) {
    const target = selectTarget.get(
      input.userId,
      input.toWorkspaceId,
      row.action_type,
      row.fingerprint,
    ) as ApprovalRuleRow | undefined;
    if (!target) {
      updateScope.run(input.toWorkspaceId, row.id);
      continue;
    }

    if (Date.parse(row.updated_at) > Date.parse(target.updated_at)) {
      updateTarget.run(row.decision, row.created_at, row.updated_at, target.id);
    }
    deleteRow.run(row.id);
  }
}

function migrateCapabilityScores(db: MasterSqliteDb, input: ScopeMigrationInput): void {
  const oldRows = db
    .prepare(
      `SELECT * FROM master_capability_scores
       WHERE user_id = ? AND workspace_id = ? ORDER BY updated_at DESC`,
    )
    .all(input.userId, input.fromWorkspaceId) as CapabilityScoreRow[];
  const selectTarget = db.prepare(
    `SELECT * FROM master_capability_scores
     WHERE user_id = ? AND workspace_id = ? AND capability = ? LIMIT 1`,
  );
  const updateTarget = db.prepare(
    `UPDATE master_capability_scores
     SET confidence = ?, last_verified_at = ?, benchmark_summary = ?, updated_at = ?
     WHERE id = ?`,
  );
  const updateScope = db.prepare(
    `UPDATE master_capability_scores SET workspace_id = ? WHERE id = ?`,
  );
  const deleteRow = db.prepare(`DELETE FROM master_capability_scores WHERE id = ?`);

  for (const row of oldRows) {
    const target = selectTarget.get(input.userId, input.toWorkspaceId, row.capability) as
      | CapabilityScoreRow
      | undefined;
    if (!target) {
      updateScope.run(input.toWorkspaceId, row.id);
      continue;
    }

    if (Date.parse(row.updated_at) > Date.parse(target.updated_at)) {
      updateTarget.run(
        row.confidence,
        row.last_verified_at,
        row.benchmark_summary,
        row.updated_at,
        target.id,
      );
    }
    deleteRow.run(row.id);
  }
}

function migrateConnectorSecrets(db: MasterSqliteDb, input: ScopeMigrationInput): void {
  const oldRows = db
    .prepare(
      `SELECT * FROM master_connector_secrets
       WHERE user_id = ? AND workspace_id = ? ORDER BY updated_at DESC`,
    )
    .all(input.userId, input.fromWorkspaceId) as ConnectorSecretRow[];
  const selectTarget = db.prepare(
    `SELECT * FROM master_connector_secrets
     WHERE user_id = ? AND workspace_id = ? AND provider = ? AND key_ref = ? LIMIT 1`,
  );
  const updateTarget = db.prepare(
    `UPDATE master_connector_secrets
     SET encrypted_payload = ?, issued_at = ?, expires_at = ?, revoked_at = ?, created_at = ?, updated_at = ?
     WHERE id = ?`,
  );
  const updateScope = db.prepare(
    `UPDATE master_connector_secrets SET workspace_id = ? WHERE id = ?`,
  );
  const deleteRow = db.prepare(`DELETE FROM master_connector_secrets WHERE id = ?`);

  for (const row of oldRows) {
    const target = selectTarget.get(
      input.userId,
      input.toWorkspaceId,
      row.provider,
      row.key_ref,
    ) as ConnectorSecretRow | undefined;
    if (!target) {
      updateScope.run(input.toWorkspaceId, row.id);
      continue;
    }

    const winner = chooseConnectorSecretWinner(row, target);
    if (winner === row) {
      updateTarget.run(
        row.encrypted_payload,
        row.issued_at,
        row.expires_at,
        row.revoked_at,
        row.created_at,
        row.updated_at,
        target.id,
      );
    }
    deleteRow.run(row.id);
  }
}

function chooseConnectorSecretWinner(
  left: ConnectorSecretRow,
  right: ConnectorSecretRow,
): ConnectorSecretRow {
  const leftActive = !left.revoked_at;
  const rightActive = !right.revoked_at;
  if (leftActive !== rightActive) {
    return leftActive ? left : right;
  }
  return Date.parse(left.updated_at) > Date.parse(right.updated_at) ? left : right;
}

function parsePersonaWorkspaceId(
  workspaceId: string,
): { personaId: string; workspaceId: string } | null {
  const match = /^persona:([^:]+):(.+)$/.exec(String(workspaceId || '').trim());
  if (!match) return null;
  return { personaId: match[1], workspaceId: match[2] };
}
