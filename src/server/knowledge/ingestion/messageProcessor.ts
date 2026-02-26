import type { IngestionWindow } from '@/server/knowledge/ingestionCursor';
import type { ExtractionPersonaContext } from '@/server/knowledge/prompts';
import type { KnowledgeExtractionResult } from '@/server/knowledge/extractor';
import type { KnowledgeExtractorLike, KnowledgeRepositoryLike, MemoryServiceLike } from './types';
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

export interface ProcessWindowContext {
  window: IngestionWindow;
  extractor: KnowledgeExtractorLike;
  repo: KnowledgeRepositoryLike;
  memoryService?: MemoryServiceLike | null;
  resolvePersonaName?: (personaId: string) => string | null;
}

export interface ProcessWindowResult {
  factsStored: number;
  eventsStored: number;
  entitiesCreated: number;
  entitiesMerged: number;
  taskCompletions: TaskCompletionResult[];
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
  const { window, extractor, repo, memoryService, resolvePersonaName } = context;

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

  // Upsert episode and meeting ledger
  upsertEpisodeAndLedger(repo, {
    window,
    extraction,
    facts,
    filteredDecisions: meetingLedger.decisions,
    filteredNegotiatedTerms: meetingLedger.negotiatedTerms,
    filteredOpenPoints: meetingLedger.openPoints,
    filteredActionItems: meetingLedger.actionItems,
  });

  // Store facts to Mem0
  const factResult = await storeFacts(memoryService, repo, facts, {
    window,
    extraction,
    dominantEmotion,
    corrections,
  });

  // Store events
  const eventResult = await storeEvents(repo, {
    window,
    extraction,
    personaName,
  });

  // Store entities
  const entityResult = storeEntities(repo, {
    window,
    entities: extraction.entities || [],
  });

  // Detect and store task completions
  const taskCompletions = await storeTaskCompletions(
    memoryService,
    window,
    meetingLedger.actionItems,
    {
      userId: window.userId,
      personaId: window.personaId,
      conversationId: window.conversationId,
      topicKey: extraction.meetingLedger.topicKey,
    },
  );

  return {
    factsStored: facts.length - factResult.skippedCount,
    eventsStored: eventResult.stored,
    entitiesCreated: entityResult.created,
    entitiesMerged: entityResult.merged,
    taskCompletions,
  };
}
