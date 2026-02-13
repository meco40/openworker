import type {
  ApprovalRule,
  TaskActivityRecord,
  TaskActivityType,
  WorkerArtifactRecord,
  WorkerStepRecord,
  WorkerStepStatus,
  WorkerTaskRecord,
  WorkerTaskStatus,
} from './workerTypes';

export function toTask(row: Record<string, unknown>): WorkerTaskRecord {
  return {
    id: row.id as string,
    title: row.title as string,
    objective: row.objective as string,
    status: row.status as WorkerTaskStatus,
    priority: row.priority as WorkerTaskRecord['priority'],
    originPlatform: row.origin_platform as WorkerTaskRecord['originPlatform'],
    originConversation: row.origin_conversation as string,
    originExternalChat: (row.origin_external_chat as string) || null,
    currentStep: (row.current_step as number) || 0,
    totalSteps: (row.total_steps as number) || 0,
    resultSummary: (row.result_summary as string) || null,
    errorMessage: (row.error_message as string) || null,
    resumable: row.resumable === 1,
    lastCheckpoint: (row.last_checkpoint as string) || null,
    workspacePath: (row.workspace_path as string) || null,
    workspaceType: (row.workspace_type as WorkerTaskRecord['workspaceType']) || 'general',
    assignedPersonaId: (row.assigned_persona_id as string) || null,
    planningMessages: (row.planning_messages as string) || null,
    planningComplete: row.planning_complete === 1,
    createdAt: row.created_at as string,
    startedAt: (row.started_at as string) || null,
    completedAt: (row.completed_at as string) || null,
  };
}

export function toStep(row: Record<string, unknown>): WorkerStepRecord {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    stepIndex: row.step_index as number,
    description: row.description as string,
    status: row.status as WorkerStepStatus,
    output: (row.output as string) || null,
    toolCalls: (row.tool_calls as string) || null,
    startedAt: (row.started_at as string) || null,
    completedAt: (row.completed_at as string) || null,
  };
}

export function toArtifact(row: Record<string, unknown>): WorkerArtifactRecord {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    name: row.name as string,
    type: row.type as WorkerArtifactRecord['type'],
    content: row.content as string,
    mimeType: (row.mime_type as string) || null,
    createdAt: row.created_at as string,
  };
}

export function toApprovalRule(row: Record<string, unknown>): ApprovalRule {
  return {
    id: row.id as string,
    commandPattern: row.command_pattern as string,
    createdAt: row.created_at as string,
  };
}

export function toActivity(row: Record<string, unknown>): TaskActivityRecord {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    type: row.type as TaskActivityType,
    message: row.message as string,
    metadata: (row.metadata as string) || null,
    createdAt: row.created_at as string,
  };
}
