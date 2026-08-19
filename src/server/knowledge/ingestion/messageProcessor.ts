import type { IngestionWindow } from '@/server/knowledge/ingestionCursor';
import type { ExtractionPersonaContext } from '@/server/knowledge/prompts';
import type { KnowledgeExtractionResult } from '@/server/knowledge/extractor';
import type { KnowledgeExtractorLike, KnowledgeRepositoryLike, MemoryServiceLike } from './types';
import type { MessageRepository } from '@/server/channels/messages/repository';
import { GERMAN_SELF_REFERENCES } from './constants';
import { detectDominantEmotion } from './emotionTracker';
import { detectCorrections, processFacts, processMeetingLedger, storeFacts } from './factExtractor';
import { storeEvents } from './eventExtractor';
import {
  storeEntities,
  normalizeSelfReferences,
  validateEventSpeakerRoles,
} from './entityExtractor';
import { upsertEpisodeAndLedger } from './episodeExtractor';
import { storeTaskCompletions, type TaskCompletionResult } from './taskCompletion';
import { normalizeExtraction } from '@/server/world-model/projector/normalizeExtraction';
import { projectWindow } from '@/server/world-model/projector/projectWindow';
import { getWorldModelConfig } from '@/server/world-model/config';
import { isWorldModelRequired } from '@/server/world-model/mode';
import type { WorldModelProjection } from '@/server/world-model/projector/types';
import { enqueueProjectionPending } from '@/server/world-model/repositories/projectionPendingRepository';
import { detectTaskCompletion } from '@/server/knowledge/taskTracker';
import { getObservationById } from '@/server/world-model/repositories/observationRepository';
import { matchStandingIntents } from '@/server/world-model/services/prospectiveEngine';
import { processIncomingStandingIntents } from '@/server/world-model/services/standingIntentCompiler';

export interface ProcessWindowContext {
  window: IngestionWindow;
  extractor: KnowledgeExtractorLike;
  repo: KnowledgeRepositoryLike;
  memoryService?: MemoryServiceLike | null;
  resolvePersonaName?: (personaId: string) => string | null;
  markMessagesMemoryPending?: MessageRepository['markMessagesMemoryPending'];
}

export interface ProcessWindowResult {
  factsStored: number;
  eventsStored: number;
  entitiesCreated: number;
  entitiesMerged: number;
  taskCompletions: TaskCompletionResult[];
  mem0FailCount: number;
  /** Number of facts that were not persisted and must be retried. */
  mem0PendingCount: number;
  /** World-Model-Projektion, die nach dem kanonischen Commit gesetzt wurde. */
  worldModelProjected: boolean;
  worldModelObservationId?: string;
  worldModelProjection?: WorldModelProjection;
}

/**
 * Build persona context with resolved human-readable name.
 */
export function buildPersonaContext(
  window: IngestionWindow,
  resolvePersonaName?: (personaId: string) => string | null,
): { personaName: string; personaContext: ExtractionPersonaContext } {
  const resolvedName = resolvePersonaName?.(window.personaId) || null;
  const personaName = resolvedName || window.personaId;
  const personaContext: ExtractionPersonaContext = {
    name: personaName,
    identityTerms: GERMAN_SELF_REFERENCES,
  };

  return { personaName, personaContext };
}

/**
 * Normalize extraction results by replacing self-references with persona name.
 */
export function normalizeExtractionSelfReferences(
  extraction: KnowledgeExtractionResult,
  personaName: string,
  personaId: string,
): void {
  if (!extraction.entities || personaName === personaId) return;

  normalizeSelfReferences(extraction.entities, personaName, personaId);

  // Fix event subjects/counterparts that are self-references
  if (extraction.events) {
    const selfRefs = new Set(['ich', 'me', 'myself', personaId.toLowerCase()]);
    for (const event of extraction.events) {
      if (event.subject && selfRefs.has(event.subject.toLowerCase())) {
        event.subject = personaName;
      }
      if (event.counterpart && selfRefs.has(event.counterpart.toLowerCase())) {
        event.counterpart = personaName;
      }
    }
  }
}

/**
 * Process a single ingestion window: extract knowledge, normalize, and store.
 */
export async function processWindow(context: ProcessWindowContext): Promise<ProcessWindowResult> {
  const { window, extractor, repo, memoryService, resolvePersonaName, markMessagesMemoryPending } =
    context;

  // Build persona context
  const { personaName, personaContext } = buildPersonaContext(window, resolvePersonaName);

  // Extract knowledge
  const extraction = await extractor.extract({
    conversationId: window.conversationId,
    userId: window.userId,
    personaId: window.personaId,
    messages: window.messages,
    personaContext,
  });

  // Normalize self-references
  normalizeExtractionSelfReferences(extraction, personaName, window.personaId);

  // Validate speaker roles
  validateEventSpeakerRoles(extraction.events, extraction.entities, personaName);

  // Detect emotions
  const dominantEmotion = detectDominantEmotion(window);

  // Detect corrections
  const corrections = detectCorrections(window);

  // Process facts and meeting ledger
  const facts = processFacts(extraction, window);
  const meetingLedger = processMeetingLedger(extraction, window);

  const wmConfig = getWorldModelConfig();
  let worldModelProjected = false;
  let worldModelObservationId: string | undefined;
  let worldModelProjection: WorldModelProjection | undefined;

  // --- Phase 3: Kanonische PostgreSQL-Projektion zuerst ---
  // Wenn das World Model aktiv ist, ist PostgreSQL die verbindliche Wahrheit.
  // Mem0 und SQLite Knowledge werden danach als kontrollierte Projektionen
  // befüllt. Ein Mem0/SQLite-Fehler blockiert die Ingestion nicht mehr, sondern
  // wird als Projektionsfehler geloggt.
  if (wmConfig.enabled || wmConfig.e2eEnabled) {
    try {
      worldModelProjection = normalizeExtraction({
        result: extraction,
        workspaceId: window.workspaceId ?? '',
        userId: window.userId,
        personaId: window.personaId,
      });
      const completedTaskEvidence = worldModelProjection.tasks.flatMap((task) => {
        const trackedTask = {
          id: task.title,
          userId: window.userId,
          personaId: window.personaId,
          title: task.title,
          description: null,
          taskType: 'one_time' as const,
          status: 'open' as const,
          deadline: null,
          recurrence: null,
          location: null,
          relatedEntityId: null,
          createdAt: new Date().toISOString(),
          completedAt: null,
          sourceConversationId: window.conversationId,
        };
        const match = window.messages
          .filter((message) => message.role === 'user')
          .map((message) => ({
            message,
            match: detectTaskCompletion(String(message.content ?? ''), [trackedTask]),
          }))
          .find((candidate) => candidate.match);
        return match?.match
          ? [
              {
                title: task.title,
                messageSeq: Number(match.message.seq ?? 0),
                evidenceText: String(match.message.content ?? ''),
                confidence: match.match.matchConfidence,
              },
            ]
          : [];
      });
      const projected = await projectWindow({
        scope: {
          userId: window.userId,
          personaId: window.personaId,
          workspaceId: window.workspaceId ?? '',
        },
        projection: worldModelProjection,
        observation: {
          userId: window.userId,
          personaId: window.personaId,
          workspaceId: window.workspaceId ?? '',
          sourceType: 'automation',
          sourceId: `${window.conversationId}:${window.fromSeqExclusive + 1}-${window.toSeqInclusive}`,
          occurredAt: new Date().toISOString(),
          payload: {
            conversationId: window.conversationId,
            fromSeq: window.fromSeqExclusive + 1,
            toSeq: window.toSeqInclusive,
            extractionVersion: '1',
            windowId: `${window.conversationId}:${window.fromSeqExclusive + 1}-${window.toSeqInclusive}`,
            text: window.messages
              .map((message) => String(message.content ?? ''))
              .filter(Boolean)
              .join('\n'),
            rawExtraction: extraction,
            texts: window.messages.map((message) => ({
              seq: Number(message.seq ?? 0),
              role: message.role,
              content: message.content,
            })),
          },
          sourceAuthority: 'persona',
        },
        extraction,
        completedTaskEvidence,
      });
      worldModelObservationId = projected.observationId;
      worldModelProjected = true;
      for (const message of window.messages) {
        if (message.role !== 'user') continue;
        await processIncomingStandingIntents({
          userId: window.userId,
          personaId: window.personaId,
          workspaceId: window.workspaceId ?? '',
          text: String(message.content ?? ''),
        });
      }
      const projectedObservation = await getObservationById(projected.observationId, {
        userId: window.userId,
        personaId: window.personaId,
        workspaceId: window.workspaceId ?? '',
      });
      if (projectedObservation) await matchStandingIntents(projectedObservation);
    } catch (error) {
      await markMessagesMemoryPending?.(
        window.messages.map((message) => message.id),
        true,
        error instanceof Error ? error.message : String(error),
      );
      if (isWorldModelRequired(wmConfig.mode)) throw error;
      await enqueueProjectionPending({
        scope: {
          userId: window.userId,
          personaId: window.personaId,
          workspaceId: window.workspaceId ?? '',
        },
        projectionType: 'world_model_window',
        sourceWindowId: `${window.conversationId}:${window.fromSeqExclusive + 1}-${window.toSeqInclusive}`,
        payload: {
          conversationId: window.conversationId,
          fromSeqExclusive: window.fromSeqExclusive,
          toSeqInclusive: window.toSeqInclusive,
          rawExtraction: extraction,
          messageIds: window.messages.map((message) => message.id),
        },
        errorMessage: error instanceof Error ? error.message : String(error),
      }).catch((pendingError) => {
        console.error('[knowledge-ingestion] could not persist projection retry:', pendingError);
      });
      console.error('[knowledge-ingestion] world-model projection failed (fail-soft):', error);
    }
  }

  // --- Alt-Projektionen (Mem0 + SQLite Knowledge) ---
  // Im World-Model-Modus sind diese abgeleitet. Im Legacy-Modus (World Model off)
  // bleiben sie die primäre Wahrheit.
  const factResult = await storeFacts(memoryService, repo, facts, {
    window,
    extraction,
    dominantEmotion,
    corrections,
  });

  if (factResult.pendingCount > 0) {
    // Legacy-Modus: Mem0 ist primär, daher abbrechen.
    if (!wmConfig.enabled && !wmConfig.e2eEnabled) {
      return {
        factsStored: factResult.memoryIds.length,
        eventsStored: 0,
        entitiesCreated: 0,
        entitiesMerged: 0,
        taskCompletions: [],
        mem0FailCount: factResult.failCount,
        mem0PendingCount: factResult.pendingCount,
        worldModelProjected,
        worldModelProjection,
      };
    }

    // World-Model-Modus: Kanonisches Commit ist bereits erfolgt. Mem0-/SQLite-
    // Projektionsfehler dürfen den Checkpoint nicht blockieren.
    await markMessagesMemoryPending?.(
      window.messages.map((message) => message.id),
      true,
      `${factResult.pendingCount} factual Mem0 projection(s) pending`,
    );
    console.warn(
      '[knowledge-ingestion] Mem0 projection incomplete after canonical commit:',
      factResult.pendingCount,
    );
    if (worldModelObservationId) {
      await enqueueProjectionPending({
        scope: {
          userId: window.userId,
          personaId: window.personaId,
          workspaceId: window.workspaceId ?? '',
        },
        projectionType: 'mem0_fact',
        sourceObservationId: worldModelObservationId,
        sourceWindowId: `${window.conversationId}:${window.fromSeqExclusive + 1}-${window.toSeqInclusive}`,
        payload: {
          facts,
          rawExtraction: extraction,
          messageIds: window.messages.map((message) => message.id),
        },
        errorMessage: `${factResult.pendingCount} factual Mem0 projection(s) pending`,
      });
    }
  }

  let eventResult = { stored: 0, confirmed: 0 };
  let entityResult = { created: 0, merged: 0, relationsAdded: 0 };
  let taskCompletions: TaskCompletionResult[] = [];
  let sqliteProjectionSucceeded = true;
  try {
    upsertEpisodeAndLedger(repo, {
      window,
      extraction,
      facts,
      memoryIds: factResult.memoryIds,
      filteredDecisions: meetingLedger.decisions,
      filteredNegotiatedTerms: meetingLedger.negotiatedTerms,
      filteredOpenPoints: meetingLedger.openPoints,
      filteredActionItems: meetingLedger.actionItems,
    });

    eventResult = await storeEvents(repo, {
      window,
      extraction,
      personaName,
    });

    entityResult = storeEntities(repo, {
      window,
      entities: extraction.entities || [],
    });

    taskCompletions = await storeTaskCompletions(memoryService, window, meetingLedger.actionItems, {
      userId: window.userId,
      personaId: window.personaId,
      conversationId: window.conversationId,
      topicKey: extraction.meetingLedger.topicKey,
    });
  } catch (error) {
    if (!wmConfig.enabled && !wmConfig.e2eEnabled) throw error;
    sqliteProjectionSucceeded = false;
    await markMessagesMemoryPending?.(
      window.messages.map((message) => message.id),
      true,
      error instanceof Error ? error.message : String(error),
    );
    await enqueueProjectionPending({
      scope: {
        userId: window.userId,
        personaId: window.personaId,
        workspaceId: window.workspaceId ?? '',
      },
      projectionType: 'sqlite_knowledge',
      sourceObservationId: worldModelObservationId ?? null,
      sourceWindowId: `${window.conversationId}:${window.fromSeqExclusive + 1}-${window.toSeqInclusive}`,
      payload: {
        conversationId: window.conversationId,
        fromSeqExclusive: window.fromSeqExclusive,
        toSeqInclusive: window.toSeqInclusive,
        messages: window.messages,
        rawExtraction: extraction,
        facts,
        memoryIds: factResult.memoryIds,
        personaName,
      },
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    console.error('[knowledge-ingestion] SQLite knowledge projection failed (retryable):', error);
  }

  if (
    (wmConfig.enabled || wmConfig.e2eEnabled) &&
    worldModelProjected &&
    sqliteProjectionSucceeded &&
    factResult.pendingCount === 0
  ) {
    await markMessagesMemoryPending?.(
      window.messages.map((message) => message.id),
      false,
    );
  }

  return {
    factsStored: factResult.memoryIds.length,
    eventsStored: eventResult.stored,
    entitiesCreated: entityResult.created,
    entitiesMerged: entityResult.merged,
    taskCompletions,
    mem0FailCount: factResult.failCount,
    mem0PendingCount: factResult.pendingCount,
    worldModelProjected,
    worldModelObservationId,
    worldModelProjection,
  };
}
