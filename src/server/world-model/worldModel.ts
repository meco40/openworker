/**
 * World Model — canonical system of record for memory, knowledge and
 * prospective behavior. Additive and fail-closed: nothing runs unless
 * WORLD_MODEL_ENABLED=true (or WORLD_MODEL_E2E=true for integration tests).
 */
export * from '@/server/world-model/config';
export * from '@/server/world-model/mode';
export * from '@/server/world-model/types';

export {
  getWorldModelDb,
  runWithWorldModelScope,
  getWorldModelScope,
  runWorldModelMigrations,
  closeWorldModelDb,
  withWorldModelTransaction,
} from '@/server/world-model/db';

export {
  insertObservation,
  insertObservationWithResult,
  getObservationById,
} from '@/server/world-model/repositories/observationRepository';
export {
  insertEvent,
  getEventById,
  listEventTransitions,
  listEventTimeline,
} from '@/server/world-model/repositories/eventRepository';
export {
  insertOpenLoop,
  getOpenLoopByKey,
  listDueOpenLoops,
  insertStandingIntent,
  listArmedStandingIntents,
} from '@/server/world-model/repositories/prospectiveRepository';
export {
  enqueueOutboxEvent,
  listPendingOutboxEvents,
} from '@/server/world-model/repositories/outboxRepository';
export {
  upsertEntity,
  findEntityByName,
  insertRelation,
  listActiveRelations,
  listRelationHistory,
} from '@/server/world-model/repositories/entityRepository';

export {
  planEvent,
  applyPlanChange,
  confirmEventOutcome,
  getEventHistory,
  resolveEventOpenLoop,
} from '@/server/world-model/services/eventService';
export {
  recordObservation,
  deriveWriteHealth,
} from '@/server/world-model/services/observationService';
export { scopeWhere, scopeKey, sameScope, scopeParts } from '@/server/world-model/scope';
export type { WorldModelScope } from '@/server/world-model/scope';
export {
  deriveArtifactKey,
  stableDedupKey,
  textFingerprint,
} from '@/server/world-model/projector/idempotency';
export { normalizeExtraction } from '@/server/world-model/projector/normalizeExtraction';
export { projectWindow } from '@/server/world-model/projector/projectWindow';
export { planQuery, extractEntityMention } from '@/server/world-model/retrieval/queryPlanner';
export {
  hybridRank,
  suppressInactiveBeforeLowerSource,
} from '@/server/world-model/retrieval/hybridRanker';
export { buildEmbeddingText, hashText } from '@/server/world-model/embeddings/embeddingText';
export { getConfiguredEmbeddingProvider } from '@/server/world-model/embeddings/provider';
export { summarizeWorldModelMetrics, worldModelHealthStatus } from '@/server/world-model/metrics';
export {
  buildScopeWhere,
  retentionCutoffDays,
  exportWorldModelScope,
  hashWorldModelExport,
  restoreWorldModelScope,
  deleteWorldModelScope,
  purgeWorldModelRetention,
} from '@/server/world-model/dataLifecycle';
export {
  classifyEventUtterance,
  pickEventCandidate,
  outcomeForUtterance,
} from '@/server/world-model/services/eventLinker';
export {
  resolveCorrection,
  applyCancellationForReplacement,
} from '@/server/world-model/services/correctionResolver';
export {
  insertAssertion,
  listActiveAssertions,
  retractAssertion,
  expireAssertion,
} from '@/server/world-model/repositories/assertionRepository';
export {
  assertFact,
  supersedeFact,
  denyFact,
  confirmFact,
  retractFact,
  expireFact,
} from '@/server/world-model/services/assertionService';
export {
  startActionAttempt,
  finishActionAttempt,
} from '@/server/world-model/repositories/actionAttemptRepository';
export { executeAction } from '@/server/world-model/services/actionService';
export {
  canTransitionTask,
  resolveTaskTransition,
  isTaskCompletionAllowed,
} from '@/server/world-model/services/canonicalTaskService';
export {
  collectDueFollowUps,
  matchStandingIntents,
  markFollowUpAsked,
  resolveFollowUp,
  heartbeatScan,
} from '@/server/world-model/services/prospectiveEngine';
export {
  deliverDueOpenLoops,
  resolveOpenLoopAsAnswered,
  resolveOpenLoopAsAnsweredInTx,
} from '@/server/world-model/services/openLoopService';
export { compileStandingIntent } from '@/server/world-model/services/standingIntentCompiler';
export {
  dispatchStandingIntentAction,
  buildIntentFiredHandler,
  executeStandingIntentFollowUp,
} from '@/server/world-model/services/standingIntentDispatcher';
export { scanHeartbeat, heartbeatNeedsAction } from '@/server/world-model/runtime/heartbeatRuntime';
export { runProspectiveRuntimeOnce } from '@/server/world-model/runtime/prospectiveRuntime';
export {
  registerOutboxHandler,
  dispatchOutboxOnce,
  startOutboxDispatcher,
  stopOutboxDispatcher,
} from '@/server/world-model/outboxDispatcher';
export { bridgeChatMessages, bridgeCanReachWorldModel } from '@/server/world-model/bridge';
export { retrieveContext, formatWorldModelContext } from '@/server/world-model/retrieval';
export {
  insertShadowEdge,
  createGraphitiShadowHandler,
  countShadowEdges,
} from '@/server/world-model/graphiti/shadow';
export {
  isMem0PrimaryMemory,
  isMem0PreferencesOnly,
  isMem0FactualWriteBlocked,
  allowedMem0Types,
  isMem0TypeAllowed,
} from '@/server/world-model/mem0Policy';
export {
  deliverProactiveQuestion,
  deliverIntentFiredNotification,
  createProactiveQuestionHandler,
  createProactiveIntentFiredHandler,
} from '@/server/world-model/services/proactiveChannelDelivery';
export {
  correlateInboundResponse,
  looksLikeResponse,
} from '@/server/world-model/services/inboundResponseCorrelation';
export {
  mirrorTaskCreation,
  mirrorTaskStatusChange,
  mirrorTaskDeletion,
  projectMissionControlTaskCreated,
  projectMissionControlTaskStatusChanged,
  projectMissionControlTaskDeleted,
  executeMissionControlAction,
  validateTaskTransition,
} from '@/server/world-model/services/missionControlBridge';
export {
  collectEmbeddingTargets,
  processEmbeddingBatch,
  runEmbeddingWorkerOnce,
  startEmbeddingWorker,
} from '@/server/world-model/embeddings/embeddingWorker';
export {
  vectorSearch,
  isVectorSearchAvailable,
  countEmbeddings,
} from '@/server/world-model/retrieval/vector';
export {
  addGraphitiMessages,
  checkGraphitiHealth,
  upsertGraphitiNodes,
  upsertGraphitiEdges,
  clearGraphitiScope,
  resetGraphitiCircuit,
} from '@/server/world-model/graphiti/client';
export {
  projectOutboxEvent,
  createGraphitiProjectorHandler,
  rebuildGraphitiFromPostgres,
} from '@/server/world-model/graphiti/projector';
export { evaluateGraphitiValue } from '@/server/world-model/graphiti/evaluator';
export { consolidateMemory } from '@/server/world-model/consolidation/service';
export {
  CONSOLIDATION_POLICY_VERSION,
  validateConsolidationPolicy,
  normalizedSourceObservationIds,
} from '@/server/world-model/consolidation/policy';
export {
  upsertWorldModelIngestionCheckpoint,
  getWorldModelIngestionCheckpoint,
} from '@/server/world-model/repositories/ingestionCheckpointRepository';
export {
  enqueueProjectionPending,
  listDueProjectionPending,
  markProjectionPendingSucceeded,
  markProjectionPendingFailed,
} from '@/server/world-model/repositories/projectionPendingRepository';
export {
  insertDeliveryReceipt,
  getDeliveryReceiptByOutboxEventId,
} from '@/server/world-model/repositories/deliveryReceiptRepository';
export {
  insertTask,
  updateTaskStatus,
  updateTaskStatusByExternalId,
  getTaskById,
  getTaskByExternalId,
  listActiveTasks,
  completeTaskWithEvidence,
  completeTaskByTitle,
} from '@/server/world-model/repositories/taskRepository';
export {
  resolveEntity,
  createEntityWithAliases,
} from '@/server/world-model/services/entityService';
export { processIncomingStandingIntents } from '@/server/world-model/services/standingIntentCompiler';
export {
  runProjectionRetryOnce,
  startProjectionRetryWorker,
} from '@/server/world-model/services/projectionRetryWorker';
export {
  searchAssertions,
  type AssertionRetrievalHit,
} from '@/server/world-model/retrieval/assertions';
export { searchTasks, type TaskRetrievalHit } from '@/server/world-model/retrieval/tasks';
export {
  searchRelations,
  type RelationRetrievalHit,
} from '@/server/world-model/retrieval/relations';
export {
  searchOpenLoops,
  type OpenLoopRetrievalHit,
} from '@/server/world-model/retrieval/openLoops';
