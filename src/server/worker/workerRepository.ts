import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from './repositories/migrations';
import type { WorkerRepository } from './workerTypes';

// Import specialized repositories
import { TaskRepository } from './repositories/taskRepository';
import { StepRepository } from './repositories/stepRepository';
import { ArtifactRepository } from './repositories/artifactRepository';
import { ActivityRepository } from './repositories/activityRepository';
import { FlowRepository } from './repositories/flowRepository';
import { SubagentRepository } from './repositories/subagentRepository';
import { DeliverableRepository } from './repositories/deliverableRepository';
import { ApprovalRuleRepository } from './repositories/approvalRuleRepository';
import { UserSettingsRepository } from './repositories/userSettingsRepository';

/**
 * Main SQLite implementation of the WorkerRepository interface.
 *
 * This class acts as a facade, delegating all operations to specialized
 * repository classes organized by domain:
 *
 * - TaskRepository: Task CRUD and lifecycle operations
 * - StepRepository: Step management within tasks
 * - ArtifactRepository: Artifact storage and retrieval
 * - ActivityRepository: Activity logging
 * - FlowRepository: Orchestra flows (drafts, published, runs, nodes)
 * - SubagentRepository: Subagent session management
 * - DeliverableRepository: Task deliverables
 * - ApprovalRuleRepository: Command approval rules
 * - UserSettingsRepository: Per-user settings
 */
export class SqliteWorkerRepository implements WorkerRepository {
  private readonly db: BetterSqlite3.Database;

  // Specialized repository instances
  private readonly taskRepo: TaskRepository;
  private readonly stepRepo: StepRepository;
  private readonly artifactRepo: ArtifactRepository;
  private readonly activityRepo: ActivityRepository;
  private readonly flowRepo: FlowRepository;
  private readonly subagentRepo: SubagentRepository;
  private readonly deliverableRepo: DeliverableRepository;
  private readonly approvalRuleRepo: ApprovalRuleRepository;
  private readonly userSettingsRepo: UserSettingsRepository;

  constructor(dbPath = process.env.WORKER_DB_PATH || '.local/worker.db') {
    // Initialize database connection
    if (dbPath === ':memory:') {
      this.db = new BetterSqlite3(':memory:');
    } else {
      const fullPath = path.resolve(dbPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      this.db = new BetterSqlite3(fullPath);
    }
    this.db.exec('PRAGMA journal_mode = WAL');
    runMigrations(this.db);

    // Initialize specialized repositories with the shared database instance
    this.taskRepo = new TaskRepository(this.db);
    this.stepRepo = new StepRepository(this.db);
    this.artifactRepo = new ArtifactRepository(this.db);
    this.activityRepo = new ActivityRepository(this.db);
    this.flowRepo = new FlowRepository(this.db);
    this.subagentRepo = new SubagentRepository(this.db);
    this.deliverableRepo = new DeliverableRepository(this.db);
    this.approvalRuleRepo = new ApprovalRuleRepository(this.db);
    this.userSettingsRepo = new UserSettingsRepository(this.db);
  }

  // ═══════════════════════════════════════════════════════════════
  // Tasks
  // ═══════════════════════════════════════════════════════════════

  createTask(input: Parameters<TaskRepository['createTask']>[0]) {
    return this.taskRepo.createTask(input);
  }

  getTask(id: string) {
    return this.taskRepo.getTask(id);
  }

  getTaskForUser(id: string, userId: string) {
    return this.taskRepo.getTaskForUser(id, userId);
  }

  updateStatus(
    id: string,
    status: Parameters<TaskRepository['updateStatus']>[1],
    extra?: Parameters<TaskRepository['updateStatus']>[2],
  ) {
    return this.taskRepo.updateStatus(id, status, extra);
  }

  listTasks(filter?: Parameters<TaskRepository['listTasks']>[0]) {
    return this.taskRepo.listTasks(filter);
  }

  listTasksForUser(userId: string, filter?: Parameters<TaskRepository['listTasksForUser']>[1]) {
    return this.taskRepo.listTasksForUser(userId, filter);
  }

  cancelTask(id: string) {
    return this.taskRepo.cancelTask(id);
  }

  deleteTask(id: string) {
    return this.taskRepo.deleteTask(id);
  }

  getNextQueuedTask() {
    return this.taskRepo.getNextQueuedTask();
  }

  getActiveTask() {
    return this.taskRepo.getActiveTask();
  }

  markInterrupted(id: string) {
    return this.taskRepo.markInterrupted(id);
  }

  saveCheckpoint(id: string, checkpoint: Record<string, unknown>) {
    return this.taskRepo.saveCheckpoint(id, checkpoint);
  }

  setTaskRunContext(id: string, updates: Parameters<TaskRepository['setTaskRunContext']>[1]) {
    return this.taskRepo.setTaskRunContext(id, updates);
  }

  setCurrentStep(id: string, stepIndex: number) {
    return this.taskRepo.setCurrentStep(id, stepIndex);
  }

  setTotalSteps(id: string, total: number) {
    return this.taskRepo.setTotalSteps(id, total);
  }

  setWorkspacePath(id: string, wsPath: string) {
    return this.taskRepo.setWorkspacePath(id, wsPath);
  }

  updateObjective(id: string, objective: string) {
    return this.taskRepo.updateObjective(id, objective);
  }

  assignPersona(taskId: string, personaId: string | null) {
    return this.taskRepo.assignPersona(taskId, personaId);
  }

  getPlanningMessages(taskId: string) {
    return this.taskRepo.getPlanningMessages(taskId);
  }

  savePlanningMessages(
    taskId: string,
    messages: Parameters<TaskRepository['savePlanningMessages']>[1],
  ) {
    return this.taskRepo.savePlanningMessages(taskId, messages);
  }

  completePlanning(taskId: string) {
    return this.taskRepo.completePlanning(taskId);
  }

  // ═══════════════════════════════════════════════════════════════
  // Steps
  // ═══════════════════════════════════════════════════════════════

  saveSteps(taskId: string, steps: Parameters<StepRepository['saveSteps']>[1]) {
    return this.stepRepo.saveSteps(taskId, steps);
  }

  getSteps(taskId: string) {
    return this.stepRepo.getSteps(taskId);
  }

  updateStepStatus(
    stepId: string,
    status: Parameters<StepRepository['updateStepStatus']>[1],
    output?: string,
    toolCalls?: string,
  ) {
    return this.stepRepo.updateStepStatus(stepId, status, output, toolCalls);
  }

  // ═══════════════════════════════════════════════════════════════
  // Artifacts
  // ═══════════════════════════════════════════════════════════════

  saveArtifact(input: Parameters<ArtifactRepository['saveArtifact']>[0]) {
    return this.artifactRepo.saveArtifact(input);
  }

  getArtifacts(taskId: string) {
    return this.artifactRepo.getArtifacts(taskId);
  }

  // ═══════════════════════════════════════════════════════════════
  // Activities
  // ═══════════════════════════════════════════════════════════════

  addActivity(input: Parameters<ActivityRepository['addActivity']>[0]) {
    return this.activityRepo.addActivity(input);
  }

  getActivities(taskId: string, limit?: number) {
    return this.activityRepo.getActivities(taskId, limit);
  }

  // ═══════════════════════════════════════════════════════════════
  // Orchestra Flows
  // ═══════════════════════════════════════════════════════════════

  listFlowDrafts(userId: string, workspaceType?: Parameters<FlowRepository['listFlowDrafts']>[1]) {
    return this.flowRepo.listFlowDrafts(userId, workspaceType);
  }

  getFlowDraft(id: string, userId: string) {
    return this.flowRepo.getFlowDraft(id, userId);
  }

  createFlowDraft(input: Parameters<FlowRepository['createFlowDraft']>[0]) {
    return this.flowRepo.createFlowDraft(input);
  }

  updateFlowDraft(
    id: string,
    userId: string,
    updates: Parameters<FlowRepository['updateFlowDraft']>[2],
    expectedUpdatedAt?: string,
  ) {
    return this.flowRepo.updateFlowDraft(id, userId, updates, expectedUpdatedAt);
  }

  publishFlowDraft(id: string, userId: string) {
    return this.flowRepo.publishFlowDraft(id, userId);
  }

  deleteFlowDraft(id: string, userId: string) {
    return this.flowRepo.deleteFlowDraft(id, userId);
  }

  deletePublishedFlow(id: string, userId: string) {
    return this.flowRepo.deletePublishedFlow(id, userId);
  }

  getFlowPublished(id: string, userId: string) {
    return this.flowRepo.getFlowPublished(id, userId);
  }

  listPublishedFlows(
    userId: string,
    workspaceType?: Parameters<FlowRepository['listPublishedFlows']>[1],
  ) {
    return this.flowRepo.listPublishedFlows(userId, workspaceType);
  }

  createRun(input: Parameters<FlowRepository['createRun']>[0]) {
    return this.flowRepo.createRun(input);
  }

  updateRunStatus(runId: string, updates: Parameters<FlowRepository['updateRunStatus']>[1]) {
    return this.flowRepo.updateRunStatus(runId, updates);
  }

  upsertRunNodeStatus(
    runId: string,
    nodeId: string,
    updates: Parameters<FlowRepository['upsertRunNodeStatus']>[2],
  ) {
    return this.flowRepo.upsertRunNodeStatus(runId, nodeId, updates);
  }

  listRunNodes(runId: string) {
    return this.flowRepo.listRunNodes(runId);
  }

  getOrchestraMetrics() {
    return this.flowRepo.getOrchestraMetrics();
  }

  // ═══════════════════════════════════════════════════════════════
  // Subagent Sessions
  // ═══════════════════════════════════════════════════════════════

  createSubagentSession(input: Parameters<SubagentRepository['createSubagentSession']>[0]) {
    return this.subagentRepo.createSubagentSession(input);
  }

  updateSubagentSession(
    taskId: string,
    sessionId: string,
    updates: Parameters<SubagentRepository['updateSubagentSession']>[2],
  ) {
    return this.subagentRepo.updateSubagentSession(taskId, sessionId, updates);
  }

  listSubagentSessions(taskId: string, limit?: number) {
    return this.subagentRepo.listSubagentSessions(taskId, limit);
  }

  listActiveSubagentSessions(taskId: string) {
    return this.subagentRepo.listActiveSubagentSessions(taskId);
  }

  // ═══════════════════════════════════════════════════════════════
  // Deliverables
  // ═══════════════════════════════════════════════════════════════

  addDeliverable(input: Parameters<DeliverableRepository['addDeliverable']>[0]) {
    return this.deliverableRepo.addDeliverable(input);
  }

  listDeliverables(taskId: string) {
    return this.deliverableRepo.listDeliverables(taskId);
  }

  // ═══════════════════════════════════════════════════════════════
  // Approval Rules
  // ═══════════════════════════════════════════════════════════════

  addApprovalRule(commandPattern: string) {
    return this.approvalRuleRepo.addApprovalRule(commandPattern);
  }

  removeApprovalRule(id: string) {
    return this.approvalRuleRepo.removeApprovalRule(id);
  }

  isCommandApproved(command: string) {
    return this.approvalRuleRepo.isCommandApproved(command);
  }

  listApprovalRules() {
    return this.approvalRuleRepo.listApprovalRules();
  }

  // ═══════════════════════════════════════════════════════════════
  // User Settings
  // ═══════════════════════════════════════════════════════════════

  getUserSettings(userId: string) {
    return this.userSettingsRepo.getUserSettings(userId);
  }

  saveUserSettings(
    userId: string,
    updates: Parameters<UserSettingsRepository['saveUserSettings']>[1],
  ) {
    return this.userSettingsRepo.saveUserSettings(userId, updates);
  }
}

// ─── Singleton ───────────────────────────────────────────────

let instance: SqliteWorkerRepository | null = null;

export function getWorkerRepository(): SqliteWorkerRepository {
  if (!instance) {
    instance = new SqliteWorkerRepository();
  }
  return instance;
}
