import { queryAll, queryOne, run } from '@/lib/db';
import { isAuthRequired } from '@/server/auth/userContext';

export interface RequestUserContext {
  userId: string;
  authenticated: boolean;
  service?: boolean;
}

/** The route should hide resource existence from users outside its workspace. */
export function hasWorkspaceAccess(
  userContext: RequestUserContext,
  workspaceId: string | null | undefined,
): boolean {
  const normalized = normalizeWorkspaceId(workspaceId);
  if (!normalized) return false;

  const workspace = queryOne<{ id: string }>('SELECT id FROM workspaces WHERE id = ?', [
    normalized,
  ]);
  if (!workspace) return false;

  // Optional-auth mode is an intentional local single-principal mode. Production
  // cannot enter this branch because assertProductionAuthConfig() is fail-closed.
  if (userContext.service || (!isAuthRequired() && !userContext.authenticated)) {
    return true;
  }

  return Boolean(
    queryOne('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [
      normalized,
      userContext.userId,
    ]),
  );
}

export function normalizeWorkspaceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 200 ? normalized : null;
}

export function getAccessibleWorkspaceIds(userContext: RequestUserContext): string[] {
  if (userContext.service || (!isAuthRequired() && !userContext.authenticated)) {
    return queryAll<{ id: string }>('SELECT id FROM workspaces ORDER BY name').map((row) => row.id);
  }

  return queryAll<{ workspace_id: string }>(
    `
      SELECT workspace_id
      FROM workspace_members
      WHERE user_id = ?
      ORDER BY workspace_id
    `,
    [userContext.userId],
  ).map((row) => row.workspace_id);
}

export function grantWorkspaceOwner(workspaceId: string, userId: string): void {
  run(
    `
      INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (?, ?, 'owner')
      ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = 'owner'
    `,
    [workspaceId, userId],
  );
}

export function canAccessAgent(userContext: RequestUserContext, agentId: string): boolean {
  const agent = queryOne<{ workspace_id: string }>('SELECT workspace_id FROM agents WHERE id = ?', [
    agentId,
  ]);
  return Boolean(agent && hasWorkspaceAccess(userContext, agent.workspace_id));
}

export function getAgentWorkspaceId(agentId: string): string | null {
  return (
    queryOne<{ workspace_id: string }>('SELECT workspace_id FROM agents WHERE id = ?', [agentId])
      ?.workspace_id ?? null
  );
}

export function canAccessTask(userContext: RequestUserContext, taskId: string): boolean {
  const task = queryOne<{ workspace_id: string }>('SELECT workspace_id FROM tasks WHERE id = ?', [
    taskId,
  ]);
  return Boolean(task && hasWorkspaceAccess(userContext, task.workspace_id));
}

export function getTaskWorkspaceId(taskId: string): string | null {
  return (
    queryOne<{ workspace_id: string }>('SELECT workspace_id FROM tasks WHERE id = ?', [taskId])
      ?.workspace_id ?? null
  );
}

export function canAccessSession(userContext: RequestUserContext, sessionId: string): boolean {
  const session = queryOne<{ workspace_id: string | null }>(
    `
      SELECT COALESCE(s.workspace_id, a.workspace_id, t.workspace_id) AS workspace_id
      FROM openclaw_sessions s
      LEFT JOIN agents a ON a.id = s.agent_id
      LEFT JOIN tasks t ON t.id = s.task_id
      WHERE s.openclaw_session_id = ? OR s.id = ?
      LIMIT 1
    `,
    [sessionId, sessionId],
  );
  return Boolean(session?.workspace_id && hasWorkspaceAccess(userContext, session.workspace_id));
}

export function getAccessibleWorkspacePlaceholders(userContext: RequestUserContext): {
  placeholders: string;
  ids: string[];
} {
  const ids = getAccessibleWorkspaceIds(userContext);
  return { placeholders: ids.map(() => '?').join(', '), ids };
}

export function getAccessibleSessionCount(userContext: RequestUserContext): number {
  const { placeholders, ids } = getAccessibleWorkspacePlaceholders(userContext);
  if (ids.length === 0) return 0;

  const row = queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM openclaw_sessions
     WHERE workspace_id IN (${placeholders})`,
    ids,
  );
  return Number(row?.count || 0);
}
