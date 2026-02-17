import type { MemoryService } from '../memory/service';
import {
  KnowledgeExtractionInput,
  KnowledgeExtractionResult,
  KnowledgeExtractor,
  detectFactSubject,
} from './extractor';
import type { ExtractionPersonaContext } from './prompts';
import type { IngestionWindow, KnowledgeIngestionCursor } from './ingestionCursor';
import type { KnowledgeRepository } from './repository';
import { sanitizeKnowledgeFacts } from './textQuality';
import { deduplicateEvent } from './eventDedup';
import { EntityExtractor, isRelationWord } from './entityExtractor';
import { createId } from '../../shared/lib/ids';
import { detectContradictionSignal } from './contradictionDetector';

interface IngestionCursorLike {
  getPendingWindows(limitConversations?: number): IngestionWindow[];
  markWindowProcessed(window: IngestionWindow): void;
}

interface KnowledgeExtractorLike {
  extract(input: KnowledgeExtractionInput): Promise<KnowledgeExtractionResult>;
}

interface KnowledgeRepositoryLike {
  getIngestionCheckpoint?: KnowledgeRepository['getIngestionCheckpoint'];
  upsertIngestionCheckpoint?: KnowledgeRepository['upsertIngestionCheckpoint'];
  upsertEpisode: KnowledgeRepository['upsertEpisode'];
  upsertMeetingLedger: KnowledgeRepository['upsertMeetingLedger'];
  upsertEvent?: KnowledgeRepository['upsertEvent'];
  findOverlappingEvents?: KnowledgeRepository['findOverlappingEvents'];
  appendEventSources?: KnowledgeRepository['appendEventSources'];
  // Entity Graph (optional — only used when entityGraphEnabled)
  upsertEntity?: KnowledgeRepository['upsertEntity'];
  addAlias?: KnowledgeRepository['addAlias'];
  addRelation?: KnowledgeRepository['addRelation'];
  updateEntityProperties?: KnowledgeRepository['updateEntityProperties'];
  resolveEntity?: KnowledgeRepository['resolveEntity'];
  getEntityWithRelations?: KnowledgeRepository['getEntityWithRelations'];
}

interface MemoryServiceLike {
  store: (...args: Parameters<MemoryService['store']>) => Promise<unknown>;
}

export interface KnowledgeIngestionServiceDependencies {
  cursor: IngestionCursorLike;
  extractor: KnowledgeExtractorLike;
  knowledgeRepository: KnowledgeRepositoryLike;
  memoryService: MemoryServiceLike;
}

export interface KnowledgeIngestionError {
  conversationId: string;
  personaId: string;
  reason: string;
}

export interface KnowledgeIngestionRunResult {
  processedConversations: number;
  processedMessages: number;
  errors: KnowledgeIngestionError[];
}

export interface IngestConversationWindowInput {
  conversationId: string;
  userId: string;
  personaId: string;
  messages: IngestionWindow['messages'];
  summaryText?: string;
  personaContext?: ExtractionPersonaContext;
}

function inferSourceStart(window: IngestionWindow): number {
  const firstSeq = Number(window.messages[0]?.seq || window.fromSeqExclusive || 0);
  return Math.max(0, Math.floor(firstSeq));
}

function inferSourceEnd(window: IngestionWindow): number {
  const lastSeq = Number(
    window.messages[window.messages.length - 1]?.seq ||
      window.toSeqInclusive ||
      window.fromSeqExclusive,
  );
  return Math.max(0, Math.floor(lastSeq));
}

export class KnowledgeIngestionService {
  constructor(private readonly deps: KnowledgeIngestionServiceDependencies) {}

  async ingestConversationWindow(input: IngestConversationWindowInput): Promise<void> {
    const personaId = String(input.personaId || '').trim();
    if (!personaId) return;

    const sortedMessages = [...(input.messages || [])]
      .filter((message) => Number.isFinite(Number(message.seq)))
      .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
    if (sortedMessages.length === 0) return;

    const checkpoint = this.deps.knowledgeRepository.getIngestionCheckpoint?.(
      input.conversationId,
      personaId,
    );
    const fromSeqExclusive = Math.max(0, Math.floor(Number(checkpoint?.lastSeq || 0)));
    const deltaMessages = sortedMessages.filter(
      (message) => Math.floor(Number(message.seq || 0)) > fromSeqExclusive,
    );
    if (deltaMessages.length === 0) return;

    const toSeqInclusive = Math.max(
      fromSeqExclusive,
      Math.floor(Number(deltaMessages[deltaMessages.length - 1].seq || fromSeqExclusive)),
    );

    const window: IngestionWindow = {
      conversationId: input.conversationId,
      userId: input.userId,
      personaId,
      fromSeqExclusive,
      toSeqInclusive,
      messages: deltaMessages,
    };

    await this.processWindow(window);
    this.deps.knowledgeRepository.upsertIngestionCheckpoint?.({
      conversationId: window.conversationId,
      personaId: window.personaId,
      lastSeq: window.toSeqInclusive,
    });
  }

  async runOnce(): Promise<KnowledgeIngestionRunResult> {
    const windows = this.deps.cursor.getPendingWindows();
    let processedConversations = 0;
    let processedMessages = 0;
    const errors: KnowledgeIngestionError[] = [];

    for (const window of windows) {
      try {
        await this.processWindow(window);
        this.deps.cursor.markWindowProcessed(window);
        processedConversations += 1;
        processedMessages += window.messages.length;
      } catch (error) {
        errors.push({
          conversationId: window.conversationId,
          personaId: window.personaId,
          reason: error instanceof Error ? error.message : 'Unknown ingestion error',
        });
      }
    }

    return {
      processedConversations,
      processedMessages,
      errors,
    };
  }

  private async processWindow(window: IngestionWindow): Promise<void> {
    // Build persona context from ingestion window (can be extended to load from repository)
    const personaContext: ExtractionPersonaContext = {
      name: window.personaId, // Fallback to ID, should be replaced with actual name
      identityTerms: ['ich', 'mein', 'meine'], // German self-references
    };

    const extraction = await this.deps.extractor.extract({
      conversationId: window.conversationId,
      userId: window.userId,
      personaId: window.personaId,
      messages: window.messages,
      personaContext,
    });

    const sourceSeqStart = inferSourceStart(window);
    const sourceSeqEnd = inferSourceEnd(window);

    const facts = sanitizeKnowledgeFacts(extraction.facts);
    const topicKey = String(extraction.meetingLedger.topicKey || '').trim() || 'general-meeting';

    this.deps.knowledgeRepository.upsertEpisode({
      userId: window.userId,
      personaId: window.personaId,
      conversationId: window.conversationId,
      topicKey,
      counterpart: extraction.meetingLedger.counterpart,
      teaser: extraction.teaser,
      episode: extraction.episode,
      facts,
      sourceSeqStart,
      sourceSeqEnd,
      sourceRefs: extraction.meetingLedger.sourceRefs,
      eventAt: window.messages[window.messages.length - 1]?.createdAt || null,
    });

    this.deps.knowledgeRepository.upsertMeetingLedger({
      userId: window.userId,
      personaId: window.personaId,
      conversationId: window.conversationId,
      topicKey,
      counterpart: extraction.meetingLedger.counterpart,
      eventAt: window.messages[window.messages.length - 1]?.createdAt || null,
      participants: extraction.meetingLedger.participants,
      decisions: extraction.meetingLedger.decisions,
      negotiatedTerms: extraction.meetingLedger.negotiatedTerms,
      openPoints: extraction.meetingLedger.openPoints,
      actionItems: extraction.meetingLedger.actionItems,
      sourceRefs: extraction.meetingLedger.sourceRefs,
      confidence: extraction.meetingLedger.confidence,
    });

    for (let factIdx = 0; factIdx < facts.length; factIdx++) {
      const fact = facts[factIdx];
      // Detect subject based on self-references in the fact
      const subject = detectFactSubject(fact);

      const metadata: Record<string, unknown> = {
        topicKey,
        conversationId: window.conversationId,
        sourceSeqStart,
        sourceSeqEnd,
        subject, // 'assistant' for persona self-references, 'user' for user references, 'conversation' for neutral
        sourceRole: subject === 'assistant' ? 'assistant' : subject === 'user' ? 'user' : 'mixed',
        sourceType: 'knowledge_ingestion',
        artifactType: 'fact',
        // Mark self-references for special retrieval handling
        selfReference: subject === 'assistant',
      };

      // ── Within-batch contradiction detection ───────────────
      // Compare this fact against earlier facts in the same extraction.
      // When a later fact contradicts an earlier one, annotate metadata so
      // downstream consumers (retrieval, UI) can surface the correction.
      for (let prevIdx = 0; prevIdx < factIdx; prevIdx++) {
        const signal = detectContradictionSignal(fact, facts[prevIdx]);
        if (signal.hasContradiction) {
          metadata.contradictionDetected = true;
          metadata.contradictionType = signal.contradictionType;
          metadata.contradictionConfidence = signal.confidence;
          metadata.supersedes = facts[prevIdx];
          break; // one contradiction annotation is sufficient
        }
      }

      try {
        await this.deps.memoryService.store(
          window.personaId,
          'fact',
          fact,
          4,
          window.userId,
          metadata,
        );
      } catch (storeError) {
        console.warn(
          '[KnowledgeIngestion] failed to store fact, continuing with remaining',
          window.personaId,
          storeError instanceof Error ? storeError.message : String(storeError),
        );
      }
    }

    // ── Event aggregation storage ────────────────────────────
    if (
      extraction.events &&
      extraction.events.length > 0 &&
      this.deps.knowledgeRepository.upsertEvent &&
      this.deps.knowledgeRepository.findOverlappingEvents &&
      this.deps.knowledgeRepository.appendEventSources
    ) {
      for (const event of extraction.events) {
        const scope = { userId: window.userId, personaId: window.personaId };
        const dedupResult = deduplicateEvent(event, scope, {
          findOverlappingEvents: this.deps.knowledgeRepository.findOverlappingEvents.bind(
            this.deps.knowledgeRepository,
          ),
          appendEventSources: this.deps.knowledgeRepository.appendEventSources.bind(
            this.deps.knowledgeRepository,
          ),
        });

        if (dedupResult.action === 'new') {
          this.deps.knowledgeRepository.upsertEvent({
            id: createId('kevt'),
            userId: window.userId,
            personaId: window.personaId,
            conversationId: window.conversationId,
            eventType: event.eventType,
            speakerRole: event.speakerRole,
            speakerEntity: event.speakerRole === 'assistant' ? window.personaId : 'User',
            subjectEntity: event.subject,
            counterpartEntity: event.counterpart,
            relationLabel: event.relationLabel,
            startDate: event.startDate,
            endDate: event.endDate,
            dayCount: event.dayCount,
            sourceSeqJson: JSON.stringify(event.sourceSeq),
            sourceSummary: `${event.subject} ${event.eventType} with ${event.counterpart}`,
            isConfirmation: false,
            confidence: 0.85,
          });
        } else if (dedupResult.action === 'confirmation') {
          // Confirmation boosts confidence on existing event — do not insert a new row
          // because the UNIQUE constraint would overwrite the original with is_confirmation=true
          const overlapping = this.deps.knowledgeRepository.findOverlappingEvents({
            userId: window.userId,
            personaId: window.personaId,
            eventType: event.eventType,
            counterpartEntity: event.counterpart,
            from: event.startDate,
            to: event.endDate,
          });
          if (overlapping.length > 0) {
            this.deps.knowledgeRepository.appendEventSources(
              overlapping[0].id,
              event.sourceSeq,
              'Confirmed by user',
            );
          }
        }
        // 'merge' action already handled by deduplicateEvent (appendEventSources)
      }
    }

    // ── Entity Graph storage ─────────────────────────────────
    if (
      extraction.entities &&
      extraction.entities.length > 0 &&
      this.deps.knowledgeRepository.upsertEntity &&
      this.deps.knowledgeRepository.addAlias &&
      this.deps.knowledgeRepository.resolveEntity
    ) {
      const entityExtractor = new EntityExtractor();
      const repo = this.deps.knowledgeRepository;

      for (const rawEntity of extraction.entities) {
        const validated = entityExtractor.validateOwner(rawEntity, window.messages);
        if (!validated.name) continue;

        const graphFilter = { userId: window.userId, personaId: window.personaId };
        const existing = repo.resolveEntity(validated.name, graphFilter);

        const verdict = entityExtractor.mergeWithExisting(
          validated,
          existing?.entity ?? null,
          existing && repo.getEntityWithRelations
            ? repo.getEntityWithRelations(existing.entity.id).aliases
            : [],
        );

        if (verdict.action === 'create') {
          const newEntity = repo.upsertEntity({
            id: createId('ent'),
            userId: window.userId,
            personaId: window.personaId,
            canonicalName: validated.name,
            category: validated.category,
            owner: validated.owner,
            properties: validated.properties,
          });

          for (const alias of validated.aliases) {
            repo.addAlias({
              entityId: newEntity.id,
              alias,
              aliasType: isRelationWord(alias) ? 'relation' : 'name',
              owner: validated.owner,
              confidence: 0.8,
            });
          }

          if (repo.addRelation) {
            for (const rel of validated.relations) {
              const target = repo.resolveEntity(rel.targetName, graphFilter);
              if (target) {
                repo.addRelation({
                  sourceEntityId: rel.direction === 'outgoing' ? newEntity.id : target.entity.id,
                  targetEntityId: rel.direction === 'outgoing' ? target.entity.id : newEntity.id,
                  relationType: rel.relationType,
                  properties: {},
                  confidence: 0.8,
                });
              }
            }
          }
        } else {
          // Merge: add new aliases and properties
          if (verdict.newAliases && repo.addAlias) {
            for (const alias of verdict.newAliases) {
              repo.addAlias({
                entityId: existing!.entity.id,
                alias,
                aliasType: isRelationWord(alias) ? 'relation' : 'name',
                owner: validated.owner,
                confidence: 0.8,
              });
            }
          }
          if (verdict.updates?.properties && repo.updateEntityProperties) {
            repo.updateEntityProperties(existing!.entity.id, verdict.updates.properties);
          }
        }
      }
    }
  }
}

export type { KnowledgeIngestionCursor, KnowledgeExtractor };
