import type {
  ApprovalRule,
  TaskActivityRecord,
  TaskActivityType,
  WorkerArtifactRecord,
  WorkerStepRecord,
  WorkerStepStatus,
  WorkerTaskRecord,
  WorkerTaskStatus,
  WorkerUserSettingsRecord,
} from './workerTypes';
import type {
  WorkerFlowDraftRecord,
  WorkerFlowPublishedRecord,
  WorkerRunRecord,
  WorkerRunNodeRecord,
  WorkerSubagentSessionRecord,
  WorkerTaskDeliverableRecord,
} from './orchestraTypes';

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
    userId: (row.user_id as string) || null,
    flowPublishedId: (row.flow_published_id as string) || null,
    currentRunId: (row.current_run_id as string) || null,
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

export function toFlowDraft(row: Record<string, unknown>): WorkerFlowDraftRecord {
  return {
    id: row.id as string,
    templateId: (row.template_id as string) || null,
    userId: row.user_id as string,
    workspaceType: row.workspace_type as WorkerFlowDraftRecord['workspaceType'],
    name: row.name as string,
    graphJson: row.graph_json as string,
    status: row.status as WorkerFlowDraftRecord['status'],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function toFlowPublished(row: Record<string, unknown>): WorkerFlowPublishedRecord {
  return {
    id: row.id as string,
    draftId: (row.draft_id as string) || null,
    templateId: (row.template_id as string) || null,
    userId: row.user_id as string,
    workspaceType: row.workspace_type as WorkerFlowPublishedRecord['workspaceType'],
    name: row.name as string,
    graphJson: row.graph_json as string,
    version: Number(row.version || 1),
    createdAt: row.created_at as string,
  };
}

export function toRun(row: Record<string, unknown>): WorkerRunRecord {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    userId: row.user_id as string,
    flowPublishedId: row.flow_published_id as string,
    status: row.status as WorkerRunRecord['status'],
    errorMessage: (row.error_message as string) || null,
    createdAt: row.created_at as string,
    startedAt: (row.started_at as string) || null,
    completedAt: (row.completed_at as string) || null,
  };
}

export function toSubagentSession(row: Record<string, unknown>): WorkerSubagentSessionRecord {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    runId: (row.run_id as string) || null,
    nodeId: (row.node_id as string) || null,
    userId: row.user_id as string,
    personaId: (row.persona_id as string) || null,
    status: row.status as WorkerSubagentSessionRecord['status'],
    sessionRef: (row.session_ref as string) || null,
    metadata: (row.metadata as string) || null,
    startedAt: row.started_at as string,
    completedAt: (row.completed_at as string) || null,
  };
}

export function toDeliverable(row: Record<string, unknown>): WorkerTaskDeliverableRecord {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    runId: (row.run_id as string) || null,
    nodeId: (row.node_id as string) || null,
    type: row.type as WorkerTaskDeliverableRecord['type'],
    name: row.name as string,
    content: row.content as string,
    mimeType: (row.mime_type as string) || null,
    metadata: (row.metadata as string) || null,
    createdAt: row.created_at as string,
  };
}

export function toRunNode(row: Record<string, unknown>): WorkerRunNodeRecord {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    nodeId: row.node_id as string,
    personaId: (row.persona_id as string) || null,
    status: row.status as WorkerRunNodeRecord['status'],
    outputSummary: (row.output_summary as string) || null,
    errorMessage: (row.error_message as string) || null,
    metadata: (row.metadata as string) || null,
    startedAt: (row.started_at as string) || null,
    completedAt: (row.completed_at as string) || null,
  };
}

export function toUserSettings(row: Record<string, unknown>): WorkerUserSettingsRecord {
  return {
    userId: row.user_id as string,
    defaultWorkspaceRoot: (row.default_workspace_root as string) || null,
    updatedAt: row.updated_at as string,
  };
}
