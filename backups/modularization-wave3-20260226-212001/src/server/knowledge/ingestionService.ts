import type { MemoryService } from '@/server/memory/service';
import {
  KnowledgeExtractionInput,
  KnowledgeExtractionResult,
  KnowledgeExtractor,
  detectFactSubject,
} from '@/server/knowledge/extractor';
import type { ExtractionPersonaContext } from '@/server/knowledge/prompts';
import type { IngestionWindow, KnowledgeIngestionCursor } from '@/server/knowledge/ingestionCursor';
import type { KnowledgeRepository } from '@/server/knowledge/repository';
import { sanitizeKnowledgeFacts } from '@/server/knowledge/textQuality';
import { isRuleLikeStatement } from '@/server/knowledge/retrieval/query/rulesExtractor';
import { deduplicateEvent } from '@/server/knowledge/eventDedup';
import { EntityExtractor, isRelationWord } from '@/server/knowledge/entityExtractor';
import { createId } from '@/shared/lib/ids';
import { detectContradictionSignal } from '@/server/knowledge/contradictionDetector';
import { checkMemoryPoisoning } from '@/server/knowledge/security/memoryPoisoningGuard';
import { detectEmotion } from '@/server/knowledge/emotionTracker';
import { detectCorrection } from '@/server/knowledge/correctionDetector';
import { expandMultilingualAliases } from '@/server/knowledge/multilingualAliases';
import { detectProjectStatusSignal } from '@/server/knowledge/projectTracker';
import { detectTaskCompletion } from '@/server/knowledge/taskTracker';
import type { TrackedTask } from '@/server/knowledge/taskTracker';
import { transitionLifecycle } from '@/server/knowledge/factLifecycle';
import type { LifecycleStatus } from '@/server/knowledge/factLifecycle';
import { resolveRelativeTime } from '@/server/knowledge/timeResolver';

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
  /** Optional — when null/undefined, Mem0 storage is silently skipped. */
  memoryService?: MemoryServiceLike | null;
  /** Optional: resolve persona ID → human-readable name (e.g. "Lea"). */
  resolvePersonaName?: (personaId: string) => string | null;
}

export interface KnowledgeIngestionServiceOptions {
  minMessagesPerBatch?: number;
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

function normalizeRuleEvidenceText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeRuleEvidence(value: string): string[] {
  return normalizeRuleEvidenceText(value)
    .split(/[^a-z0-9äöüß]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
}

function hasRuleEvidenceMatch(ruleFact: string, evidenceTexts: string[]): boolean {
  const normalizedRuleFact = normalizeRuleEvidenceText(ruleFact);
  if (!normalizedRuleFact) return false;

  const factTokens = new Set(tokenizeRuleEvidence(normalizedRuleFact));
  for (const evidenceText of evidenceTexts) {
    const normalizedEvidence = normalizeRuleEvidenceText(evidenceText);
    if (!normalizedEvidence) continue;
    if (
      normalizedEvidence.includes(normalizedRuleFact) ||
      normalizedRuleFact.includes(normalizedEvidence)
    ) {
      return true;
    }

    const evidenceTokens = tokenizeRuleEvidence(normalizedEvidence);
    if (factTokens.size === 0 || evidenceTokens.length === 0) continue;
    let overlap = 0;
    for (const token of evidenceTokens) {
      if (factTokens.has(token)) overlap += 1;
    }
    if (overlap >= 2) return true;
  }

  return false;
}

function collectUserRuleEvidenceTexts(
  window: IngestionWindow,
  sourceRefs: Array<{ seq: number; quote: string }>,
): string[] {
  const seqToRole = new Map<number, string>();
  for (const message of window.messages) {
    const seq = Math.floor(Number(message.seq || 0));
    if (Number.isFinite(seq) && seq > 0) {
      seqToRole.set(seq, String(message.role || '').toLowerCase());
    }
  }

  const userMessages = window.messages
    .filter((message) => String(message.role || '').toLowerCase() === 'user')
    .map((message) => String(message.content || '').trim());

  const userSourceQuotes = sourceRefs
    .map((sourceRef) => {
      const seq = Math.floor(Number(sourceRef.seq || 0));
      return {
        seq,
        quote: String(sourceRef.quote || '').trim(),
        role: seqToRole.get(seq) || '',
      };
    })
    .filter((entry) => entry.role === 'user')
    .map((entry) => entry.quote);

  const unique = new Set<string>();
  for (const text of [...userMessages, ...userSourceQuotes]) {
    const normalized = normalizeRuleEvidenceText(text);
    if (!normalized) continue;
    unique.add(text.trim());
  }

  return [...unique];
}

function keepOnlyEvidenceBackedRuleStatements(values: string[], evidenceTexts: string[]): string[] {
  const output: string[] = [];
  for (const value of values) {
    const statement = String(value || '').trim();
    if (!statement) continue;
    if (!isRuleLikeStatement(statement)) {
      output.push(statement);
      continue;
    }
    if (hasRuleEvidenceMatch(statement, evidenceTexts)) {
      output.push(statement);
    }
  }
  return output;
}

export class KnowledgeIngestionService {
  private readonly minMessagesPerBatch: number;

  constructor(
    private readonly deps: KnowledgeIngestionServiceDependencies,
    options: KnowledgeIngestionServiceOptions = {},
  ) {
    const configured = Math.floor(Number(options.minMessagesPerBatch || 1));
    this.minMessagesPerBatch = Number.isFinite(configured) ? Math.max(1, configured) : 1;
  }

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
    if (deltaMessages.length < this.minMessagesPerBatch) return;

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
      if (window.messages.length < this.minMessagesPerBatch) continue;
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
    // Build persona context — resolve human-readable name from persona ID
    const resolvedName = this.deps.resolvePersonaName?.(window.personaId) || null;
    const personaName = resolvedName || window.personaId;
    const personaContext: ExtractionPersonaContext = {
      name: personaName,
      identityTerms: ['ich', 'mein', 'meine'], // German self-references
    };

    const extraction = await this.deps.extractor.extract({
      conversationId: window.conversationId,
      userId: window.userId,
      personaId: window.personaId,
      messages: window.messages,
      personaContext,
    });

    // ── Normalize entity names: replace self-references with real persona name ──
    // Prevents duplicate entities like "Ich" or UUID-based persona entities.
    if (extraction.entities && personaName !== window.personaId) {
      const selfRefs = new Set(['ich', 'me', 'myself', window.personaId.toLowerCase()]);
      for (const entity of extraction.entities) {
        // Replace entity name if it's a self-reference
        if (selfRefs.has(entity.name.toLowerCase())) {
          entity.name = personaName;
        }
        // Also fix relation targets that are self-references
        if (entity.relations) {
          for (const rel of entity.relations) {
            if (selfRefs.has(rel.targetName.toLowerCase())) {
              rel.targetName = personaName;
            }
          }
        }
      }
      // Fix event subjects/counterparts that are self-references
      if (extraction.events) {
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

    // ── Post-extraction speaker role validation ──────────────
    // Cross-check speakerRole against subject entity name.
    // If subject IS the persona → speakerRole must be 'assistant'.
    // If subject IS 'User' or known user name → speakerRole must be 'user'.
    if (extraction.events && personaName) {
      // Collect known user-entity names from this extraction
      const userEntityNames = new Set<string>();
      userEntityNames.add('user');
      if (extraction.entities) {
        for (const ent of extraction.entities) {
          if (ent.owner === 'user' && ent.category === 'person') {
            userEntityNames.add(ent.name.toLowerCase());
          }
        }
      }
      const personaLower = personaName.toLowerCase();

      for (const event of extraction.events) {
        const subjectLower = event.subject?.toLowerCase() || '';
        if (subjectLower === personaLower && event.speakerRole !== 'assistant') {
          event.speakerRole = 'assistant';
        } else if (userEntityNames.has(subjectLower) && event.speakerRole !== 'user') {
          event.speakerRole = 'user';
        }
      }
    }

    const sourceSeqStart = inferSourceStart(window);
    const sourceSeqEnd = inferSourceEnd(window);

    // ── Emotion detection across all messages ────────────────
    // Scan messages for emotional signals and track the dominant emotion for metadata.
    let dominantEmotion: ReturnType<typeof detectEmotion> = null;
    for (const msg of window.messages) {
      const content = String(msg.content || '');
      const detected = detectEmotion(content);
      if (detected && (!dominantEmotion || detected.intensity > dominantEmotion.intensity)) {
        dominantEmotion = detected;
      }
    }

    // ── Correction detection in user messages ────────────────
    // Scan user messages for correction signals ("Nein, nicht X sondern Y")
    const corrections: Array<{ oldValue?: string; newValue?: string; correctionType: string }> = [];
    for (const msg of window.messages) {
      if (msg.role !== 'user') continue;
      const corrResult = detectCorrection(String(msg.content || ''));
      if (corrResult.isCorrection) {
        corrections.push({
          oldValue: corrResult.oldValue,
          newValue: corrResult.newValue,
          correctionType: corrResult.correctionType,
        });
      }
    }

    // ── Fact sanitization ────────────────────────────────────
    // NOTE: Pronoun resolution (resolvePronouns) was disabled because it caused
    // more harm than good — it blindly replaced ALL masculine pronouns (er/ihm/sein)
    // with the first extracted entity name, which after self-ref normalization is
    // often the persona itself. This produced broken facts like:
    //   "Ich verspreche, immer für ihn da zu Nata Girl"  (sein→Nata Girl)
    //   "Ich habe Max versprochen, Nata Girl näherzukommen"  (ihm→Nata Girl)
    // The verb "sein" (to be) was also caught as a pronoun.
    // The LLM already produces facts with named entities; resolution is unnecessary.
    const userRuleEvidenceTexts = collectUserRuleEvidenceTexts(
      window,
      extraction.meetingLedger.sourceRefs || [],
    );
    const facts = keepOnlyEvidenceBackedRuleStatements(
      sanitizeKnowledgeFacts(extraction.facts),
      userRuleEvidenceTexts,
    );
    const topicKey = String(extraction.meetingLedger.topicKey || '').trim() || 'general-meeting';
    const filteredDecisions = keepOnlyEvidenceBackedRuleStatements(
      extraction.meetingLedger.decisions,
      userRuleEvidenceTexts,
    );
    const filteredNegotiatedTerms = keepOnlyEvidenceBackedRuleStatements(
      extraction.meetingLedger.negotiatedTerms,
      userRuleEvidenceTexts,
    );
    const filteredOpenPoints = keepOnlyEvidenceBackedRuleStatements(
      extraction.meetingLedger.openPoints,
      userRuleEvidenceTexts,
    );
    const filteredActionItems = keepOnlyEvidenceBackedRuleStatements(
      extraction.meetingLedger.actionItems,
      userRuleEvidenceTexts,
    );

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
      decisions: filteredDecisions,
      negotiatedTerms: filteredNegotiatedTerms,
      openPoints: filteredOpenPoints,
      actionItems: filteredActionItems,
      sourceRefs: extraction.meetingLedger.sourceRefs,
      confidence: extraction.meetingLedger.confidence,
    });

    let mem0FailCount = 0;
    let mem0SkippedCount = 0;
    let mem0ConsecutiveFailCount = 0;
    const MEM0_MAX_CONSECUTIVE_FAILURES_PER_WINDOW = 2;
    for (let factIdx = 0; factIdx < facts.length; factIdx++) {
      const fact = facts[factIdx];

      // ── Memory Poisoning Guard ─────────────────────────────
      // Block injection attempts and flag suspicious content before storage.
      const poisoningCheck = checkMemoryPoisoning(fact);
      if (poisoningCheck.riskLevel === 'blocked') {
        console.warn(
          '[KnowledgeIngestion] poisoning guard blocked fact:',
          poisoningCheck.reason,
          fact.slice(0, 80),
        );
        continue; // Skip this fact entirely
      }

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

      // ── Poisoning guard: flag suspicious content ───────────
      if (poisoningCheck.riskLevel === 'suspicious') {
        metadata.securityFlag = 'suspicious';
        metadata.securityReason = poisoningCheck.reason;
      }

      // ── Emotion metadata ───────────────────────────────────
      if (dominantEmotion) {
        metadata.emotionalTone = dominantEmotion.emotion;
        metadata.emotionIntensity = dominantEmotion.intensity;
        if (dominantEmotion.trigger) {
          metadata.emotionTrigger = dominantEmotion.trigger;
        }
      }

      // ── Correction annotations ─────────────────────────────
      if (corrections.length > 0) {
        metadata.hasCorrections = true;
        metadata.correctionCount = corrections.length;
      }

      // ── Within-batch contradiction detection ───────────────
      // Compare this fact against earlier facts in the same extraction.
      // When a later fact contradicts an earlier one, annotate metadata so
      // downstream consumers (retrieval, UI) can surface the correction.
      // The factLifecycle state machine determines the new status.
      let lifecycleStatus: LifecycleStatus = 'new';
      for (let prevIdx = 0; prevIdx < factIdx; prevIdx++) {
        const signal = detectContradictionSignal(fact, facts[prevIdx]);
        if (signal.hasContradiction) {
          metadata.contradictionDetected = true;
          metadata.contradictionType = signal.contradictionType;
          metadata.contradictionConfidence = signal.confidence;
          metadata.supersedes = facts[prevIdx];
          // Transition the OLD fact's lifecycle to 'superseded'
          metadata.supersededFactLifecycleStatus = transitionLifecycle('new', 'contradicted');
          break; // one contradiction annotation is sufficient
        }
      }

      // ── Fact lifecycle: apply correction signals ────────────
      if (corrections.length > 0) {
        // User corrections transition the old state to 'superseded'
        lifecycleStatus = transitionLifecycle(lifecycleStatus, 'corrected_by_user');
      }
      metadata.lifecycleStatus = lifecycleStatus;

      // Tolerate one transient failure per window; open a short-lived circuit only
      // after repeated consecutive failures to avoid dropping all remaining facts.
      if (this.deps.memoryService) {
        if (mem0ConsecutiveFailCount >= MEM0_MAX_CONSECUTIVE_FAILURES_PER_WINDOW) {
          mem0SkippedCount++;
          continue;
        }
        try {
          // Rate-limit Mem0 calls to avoid connection pool exhaustion
          if (factIdx > 0) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          await this.deps.memoryService.store(
            window.personaId,
            'fact',
            fact,
            4,
            window.userId,
            metadata,
          );
          mem0ConsecutiveFailCount = 0;
        } catch (storeError) {
          mem0FailCount++;
          mem0ConsecutiveFailCount++;
          const errorText = storeError instanceof Error ? storeError.message : String(storeError);
          if (mem0ConsecutiveFailCount >= MEM0_MAX_CONSECUTIVE_FAILURES_PER_WINDOW) {
            console.warn(
              '[KnowledgeIngestion] Mem0 store failed, opening circuit for remaining facts in this window:',
              errorText,
            );
          } else {
            console.warn(
              '[KnowledgeIngestion] Mem0 store failed, continuing with next fact in this window:',
              errorText,
            );
          }
        }
      }
    }
    if (mem0FailCount > 0 || mem0SkippedCount > 0) {
      console.warn(
        `[KnowledgeIngestion] Mem0 store summary for window ${window.personaId} seq=${inferSourceStart(window)}-${inferSourceEnd(window)}: failed=${mem0FailCount}, skipped_after_circuit=${mem0SkippedCount}, total_facts=${facts.length}`,
      );
    }

    // ── Task completion detection ─────────────────────────────
    // Scan user messages for task completion signals against open action items from extraction.
    if (filteredActionItems.length > 0) {
      const openTasks: TrackedTask[] = filteredActionItems.map((item, idx) => ({
        id: `action-${idx}`,
        userId: window.userId,
        personaId: window.personaId,
        title: item,
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
      }));

      for (const msg of window.messages) {
        if (msg.role !== 'user') continue;
        const completionMatch = detectTaskCompletion(String(msg.content || ''), openTasks);
        if (
          completionMatch &&
          this.deps.memoryService &&
          mem0ConsecutiveFailCount < MEM0_MAX_CONSECUTIVE_FAILURES_PER_WINDOW
        ) {
          try {
            await new Promise((resolve) => setTimeout(resolve, 100));
            await this.deps.memoryService.store(
              window.personaId,
              'fact',
              `Aufgabe erledigt: ${completionMatch.task.title}`,
              4,
              window.userId,
              {
                topicKey,
                conversationId: window.conversationId,
                sourceType: 'task_completion',
                artifactType: 'task_status',
                taskTitle: completionMatch.task.title,
                completionConfidence: completionMatch.matchConfidence,
                lifecycleStatus: 'confirmed',
              },
            );
          } catch {
            // Task completion Mem0 failures are non-critical; counted in mem0FailCount is per-window
          }
        }
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
        // ── Time resolution for events ─────────────────────────
        // Resolve relative time expressions (e.g. "gestern", "letzte Woche") to absolute dates.
        const lastMessageTimestamp =
          window.messages[window.messages.length - 1]?.createdAt || new Date().toISOString();
        const timeCtx = { messageTimestamp: lastMessageTimestamp, userTimezone: 'Europe/Berlin' };
        let resolvedStartDate = event.startDate;
        let resolvedEndDate = event.endDate;
        if (event.startDate) {
          const resolved = resolveRelativeTime(event.startDate, timeCtx);
          if (resolved) {
            resolvedStartDate = resolved.absoluteDate;
            if (resolved.absoluteDateEnd) {
              resolvedEndDate = resolved.absoluteDateEnd;
            }
          }
        }

        const scope = { userId: window.userId, personaId: window.personaId };
        const dedupResult = deduplicateEvent(
          { ...event, startDate: resolvedStartDate, endDate: resolvedEndDate },
          scope,
          {
            findOverlappingEvents: this.deps.knowledgeRepository.findOverlappingEvents.bind(
              this.deps.knowledgeRepository,
            ),
            appendEventSources: this.deps.knowledgeRepository.appendEventSources.bind(
              this.deps.knowledgeRepository,
            ),
          },
        );

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
            startDate: resolvedStartDate,
            endDate: resolvedEndDate,
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
            from: resolvedStartDate,
            to: resolvedEndDate,
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
      const upsertEntity = repo.upsertEntity!.bind(repo);
      const addAlias = repo.addAlias!.bind(repo);
      const resolveEntity = repo.resolveEntity!.bind(repo);

      // ── PASS 1: Create/merge all entities + aliases (no relations yet) ──
      const pendingRelations: Array<{
        entityId: string;
        relations: {
          targetName: string;
          relationType: string;
          direction: 'outgoing' | 'incoming';
        }[];
      }> = [];

      for (const rawEntity of extraction.entities) {
        const validated = entityExtractor.validateOwner(rawEntity, window.messages);
        if (!validated.name) continue;

        const graphFilter = { userId: window.userId, personaId: window.personaId };
        const existing = resolveEntity(validated.name, graphFilter);

        const verdict = entityExtractor.mergeWithExisting(
          validated,
          existing?.entity ?? null,
          existing && repo.getEntityWithRelations
            ? repo.getEntityWithRelations(existing.entity.id).aliases
            : [],
        );

        let entityId: string;

        if (verdict.action === 'create') {
          const newEntity = upsertEntity({
            id: createId('ent'),
            userId: window.userId,
            personaId: window.personaId,
            canonicalName: validated.name,
            category: validated.category,
            owner: validated.owner,
            properties: validated.properties,
          });
          entityId = newEntity.id;

          // Add original aliases + multilingual expansions
          const allAliases = new Set(validated.aliases);
          for (const alias of validated.aliases) {
            for (const expanded of expandMultilingualAliases(alias)) {
              allAliases.add(expanded);
            }
          }

          for (const alias of allAliases) {
            addAlias({
              entityId: newEntity.id,
              alias,
              aliasType: isRelationWord(alias) ? 'relation' : 'name',
              owner: validated.owner,
              confidence: 0.8,
            });
          }

          // ── Project status tracking ──────────────────────────
          if (validated.category === 'project') {
            const messageText = window.messages.map((m) => String(m.content || '')).join(' ');
            const projectStatus = detectProjectStatusSignal(messageText);
            if (projectStatus && repo.updateEntityProperties) {
              repo.updateEntityProperties(newEntity.id, {
                ...validated.properties,
                projectStatus,
              });
            }
          }
        } else {
          entityId = existing!.entity.id;

          // Merge: add new aliases and properties
          if (verdict.newAliases && repo.addAlias) {
            const expandedNewAliases = new Set(verdict.newAliases);
            for (const alias of verdict.newAliases) {
              for (const expanded of expandMultilingualAliases(alias)) {
                expandedNewAliases.add(expanded);
              }
            }
            for (const alias of expandedNewAliases) {
              addAlias({
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

        // Collect relations for pass 2 (both create and merge paths)
        if (verdict.relations && verdict.relations.length > 0) {
          pendingRelations.push({ entityId, relations: verdict.relations });
        }
      }

      // ── PASS 2: Store all relations (all entities now exist) ──
      if (repo.addRelation && pendingRelations.length > 0) {
        const graphFilter = { userId: window.userId, personaId: window.personaId };
        for (const { entityId, relations } of pendingRelations) {
          for (const rel of relations) {
            const target = resolveEntity(rel.targetName, graphFilter);
            if (target) {
              repo.addRelation({
                sourceEntityId: rel.direction === 'outgoing' ? entityId : target.entity.id,
                targetEntityId: rel.direction === 'outgoing' ? target.entity.id : entityId,
                relationType: rel.relationType,
                properties: {},
                confidence: 0.8,
              });
            }
          }
        }
      }
    }
  }
}

export type { KnowledgeIngestionCursor, KnowledgeExtractor };
