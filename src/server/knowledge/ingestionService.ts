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
import { createId } from '../../shared/lib/ids';

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

    for (const fact of facts) {
      // Detect subject based on self-references in the fact
      const subject = detectFactSubject(fact);

      const metadata = {
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
  }
}

export type { KnowledgeIngestionCursor, KnowledgeExtractor };
