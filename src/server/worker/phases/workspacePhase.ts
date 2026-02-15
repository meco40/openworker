// ─── Workspace Phase ─────────────────────────────────────────
// Handles workspace setup and initialization for tasks.

import { getWorkspaceManager, type WorkspaceType } from '../workspaceManager';
import { getWorkerRepository } from '../workerRepository';
import { broadcastStatus } from '../utils/broadcast';

export interface WorkspaceSetupResult {
  workspacePath: string;
  workspaceType: WorkspaceType;
}

/**
 * Sets up the workspace for a task.
 * Creates the workspace if it doesn't exist, or returns the existing path.
 * Broadcasts status update when workspace is ready.
 */
export function setupWorkspace(taskId: string, workspaceType: WorkspaceType): WorkspaceSetupResult {
  const wsMgr = getWorkspaceManager();
  const repo = getWorkerRepository();
  const wsType = workspaceType || 'general';

  let workspacePath: string;

  if (wsMgr.exists(taskId)) {
    workspacePath = wsMgr.getWorkspacePath(taskId);
  } else {
    workspacePath = wsMgr.createWorkspace(taskId, wsType);
    repo.setWorkspacePath(taskId, workspacePath);
  }

  broadcastStatus(taskId, 'planning', 'Workspace erstellt. Aufgabe wird analysiert...');

  return { workspacePath, workspaceType: wsType };
}
