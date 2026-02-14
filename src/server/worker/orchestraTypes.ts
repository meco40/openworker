import type { WorkspaceType } from './workerTypes';

export type OrchestraFlowStatus = 'draft' | 'published' | 'archived';
export type OrchestraRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type OrchestraNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type SubagentSessionStatus =
  | 'started'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface WorkerFlowTemplateRecord {
  id: string;
  userId: string;
  workspaceType: WorkspaceType;
  name: string;
  description: string | null;
  templateJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerFlowDraftRecord {
  id: string;
  templateId: string | null;
  userId: string;
  workspaceType: WorkspaceType;
  name: string;
  graphJson: string;
  status: OrchestraFlowStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerFlowPublishedRecord {
  id: string;
  draftId: string | null;
  templateId: string | null;
  userId: string;
  workspaceType: WorkspaceType;
  name: string;
  graphJson: string;
  version: number;
  createdAt: string;
}

export interface WorkerRunRecord {
  id: string;
  taskId: string;
  userId: string;
  flowPublishedId: string;
  status: OrchestraRunStatus;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkerRunNodeRecord {
  id: string;
  runId: string;
  nodeId: string;
  personaId: string | null;
  status: OrchestraNodeStatus;
  outputSummary: string | null;
  errorMessage: string | null;
  metadata: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkerSubagentSessionRecord {
  id: string;
  taskId: string;
  runId: string | null;
  nodeId: string | null;
  userId: string;
  personaId: string | null;
  status: SubagentSessionStatus;
  sessionRef: string | null;
  metadata: string | null;
  startedAt: string;
  completedAt: string | null;
}

export type DeliverableType = 'file' | 'url' | 'artifact' | 'text';

export interface WorkerTaskDeliverableRecord {
  id: string;
  taskId: string;
  runId: string | null;
  nodeId: string | null;
  type: DeliverableType;
  name: string;
  content: string;
  mimeType: string | null;
  metadata: string | null;
  createdAt: string;
}
