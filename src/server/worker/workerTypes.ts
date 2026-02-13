// ─── Worker Domain Types ─────────────────────────────────────
import type { ChannelType } from '../../../types';
import type { WorkspaceType } from './workspaceManager';
import type {
  WorkerFlowDraftRecord,
  WorkerFlowPublishedRecord,
  WorkerRunRecord,
} from './orchestraTypes';

export type { WorkspaceType } from './workspaceManager';

export type WorkerTaskStatus =
  | 'inbox'
  | 'queued'
  | 'assigned'
  | 'planning'
  | 'clarifying'
  | 'executing'
  | 'testing'
  | 'review'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'waiting_approval';

export type WorkerTaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export type WorkerStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface WorkerTaskRecord {
  id: string;
  title: string;
  objective: string;
  status: WorkerTaskStatus;
  priority: WorkerTaskPriority;
  originPlatform: ChannelType;
  originConversation: string;
  originExternalChat: string | null;
  currentStep: number;
  totalSteps: number;
  resultSummary: string | null;
  errorMessage: string | null;
  resumable: boolean;
  lastCheckpoint: string | null;
  workspacePath: string | null;
  workspaceType: WorkspaceType;
  userId?: string | null;
  flowPublishedId?: string | null;
  currentRunId?: string | null;
  assignedPersonaId: string | null;
  planningMessages: string | null;
  planningComplete: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkerStepRecord {
  id: string;
  taskId: string;
  stepIndex: number;
  description: string;
  status: WorkerStepStatus;
  output: string | null;
  toolCalls: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkerArtifactRecord {
  id: string;
  taskId: string;
  name: string;
  type: 'code' | 'file' | 'doc' | 'image' | 'data';
  content: string;
  mimeType: string | null;
  createdAt: string;
}

export interface ApprovalRule {
  id: string;
  commandPattern: string;
  createdAt: string;
}

// ─── Planning Types ──────────────────────────────────────────

export interface PlanningMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PlanningQuestion {
  question: string;
  options: string[];
  context?: string;
}

export type TaskActivityType =
  | 'status_change'
  | 'persona_assigned'
  | 'step_completed'
  | 'step_failed'
  | 'error'
  | 'note'
  | 'agent_message';

export interface TaskActivityRecord {
  id: string;
  taskId: string;
  type: TaskActivityType;
  message: string;
  metadata: string | null;
  createdAt: string;
}

// ─── Input Types ─────────────────────────────────────────────

export interface CreateTaskInput {
  title: string;
  objective: string;
  priority?: WorkerTaskPriority;
  originPlatform: ChannelType;
  originConversation: string;
  originExternalChat?: string | null;
  workspaceType?: WorkspaceType;
  usePlanning?: boolean;
  userId?: string | null;
}

export interface SaveStepInput {
  taskId: string;
  stepIndex: number;
  description: string;
}

export interface SaveArtifactInput {
  taskId: string;
  name: string;
  type: WorkerArtifactRecord['type'];
  content: string;
  mimeType?: string;
}

export interface SaveActivityInput {
  taskId: string;
  type: TaskActivityType;
  message: string;
  metadata?: Record<string, unknown>;
}

// ─── Repository Interface ────────────────────────────────────

export interface WorkerRepository {
  // Tasks
  createTask(input: CreateTaskInput): WorkerTaskRecord;
  getTask(id: string): WorkerTaskRecord | null;
  getTaskForUser(id: string, userId: string): WorkerTaskRecord | null;
  updateStatus(
    id: string,
    status: WorkerTaskStatus,
    extra?: { summary?: string; error?: string },
  ): void;
  listTasks(filter?: { status?: WorkerTaskStatus; limit?: number }): WorkerTaskRecord[];
  listTasksForUser(
    userId: string,
    filter?: { status?: WorkerTaskStatus; limit?: number },
  ): WorkerTaskRecord[];
  cancelTask(id: string): void;
  getNextQueuedTask(): WorkerTaskRecord | null;
  getActiveTask(): WorkerTaskRecord | null;
  markInterrupted(id: string): void;
  saveCheckpoint(id: string, checkpoint: Record<string, unknown>): void;
  setTaskRunContext(
    id: string,
    updates: { flowPublishedId?: string | null; currentRunId?: string | null },
  ): void;

  // Steps
  saveSteps(taskId: string, steps: SaveStepInput[]): void;
  getSteps(taskId: string): WorkerStepRecord[];
  updateStepStatus(
    stepId: string,
    status: WorkerStepStatus,
    output?: string,
    toolCalls?: string,
  ): void;

  // Artifacts
  saveArtifact(input: SaveArtifactInput): WorkerArtifactRecord;
  getArtifacts(taskId: string): WorkerArtifactRecord[];

  // Persona Assignment
  assignPersona(taskId: string, personaId: string | null): void;

  // Planning
  getPlanningMessages(taskId: string): PlanningMessage[];
  savePlanningMessages(taskId: string, messages: PlanningMessage[]): void;
  completePlanning(taskId: string): void;

  // Activities
  addActivity(input: SaveActivityInput): TaskActivityRecord;
  getActivities(taskId: string, limit?: number): TaskActivityRecord[];

  // Approval Rules
  addApprovalRule(commandPattern: string): void;
  removeApprovalRule(id: string): void;
  isCommandApproved(command: string): boolean;
  listApprovalRules(): ApprovalRule[];

  // Orchestra Flows
  listFlowDrafts(userId: string, workspaceType?: WorkspaceType): WorkerFlowDraftRecord[];
  getFlowDraft(id: string, userId: string): WorkerFlowDraftRecord | null;
  createFlowDraft(input: {
    userId: string;
    workspaceType: WorkspaceType;
    name: string;
    graphJson: string;
    templateId?: string | null;
  }): WorkerFlowDraftRecord;
  updateFlowDraft(
    id: string,
    userId: string,
    updates: { name?: string; graphJson?: string; workspaceType?: WorkspaceType },
  ): WorkerFlowDraftRecord | null;
  publishFlowDraft(id: string, userId: string): WorkerFlowPublishedRecord | null;
  getFlowPublished(id: string, userId: string): WorkerFlowPublishedRecord | null;
  listPublishedFlows(userId: string, workspaceType?: WorkspaceType): WorkerFlowPublishedRecord[];
  createRun(input: {
    taskId: string;
    userId: string;
    flowPublishedId: string;
    status?: WorkerRunRecord['status'];
  }): WorkerRunRecord;
}
