import { sanitizeKnowledgeFacts } from '@/server/knowledge/textQuality';
import { detectFactSubject } from '@/server/knowledge/extractor';
import { checkMemoryPoisoning } from '@/server/knowledge/security/memoryPoisoningGuard';
import { detectContradictionSignal } from '@/server/knowledge/contradictionDetector';
import { transitionLifecycle } from '@/server/knowledge/factLifecycle';
import type { LifecycleStatus } from '@/server/knowledge/factLifecycle';
import { detectCorrection } from '@/server/knowledge/correctionDetector';
import type { IngestionWindow } from '@/server/knowledge/ingestionCursor';
import {
  collectUserRuleEvidenceTexts,
  keepOnlyEvidenceBackedRuleStatements,
  inferSourceStart,
  inferSourceEnd,
} from './qualityChecks';
import {
  MEM0_STORE_FACT_TIMEOUT_MS,
  DEFAULT_TOPIC_KEY,
  MEM0_MAX_CONSECUTIVE_FAILURES_PER_WINDOW,
} from './constants';
import type { MemoryServiceLike, KnowledgeRepositoryLike } from './types';
import type { KnowledgeExtractionResult } from '@/server/knowledge/extractor';
import type { EmotionDetectionResult } from './emotionTracker';
import { createMemoryIdempotencyKey } from '@/server/memory/idempotency';

export interface CorrectionResult {
  oldValue?: string;
  newValue?: string;
  correctionType: string;
}

export interface FactProcessingContext {
  window: IngestionWindow;
  extraction: KnowledgeExtractionResult;
  dominantEmotion: EmotionDetectionResult | null;
  corrections: CorrectionResult[];
}

export interface FactProcessingResult {
  facts: string[];
  topicKey: string;
  mem0FailCount: number;
  mem0SkippedCount: number;
  /** Facts that were not persisted and must be retried before checkpointing. */
  mem0PendingCount: number;
}

/**
 * Detect corrections in user messages.
 */
export function detectCorrections(window: IngestionWindow): CorrectionResult[] {
  const corrections: CorrectionResult[] = [];

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

  return corrections;
}

/**
 * Process and sanitize facts from extraction.
 */
export function processFacts(
  extraction: KnowledgeExtractionResult,
  window: IngestionWindow,
): string[] {
  const userRuleEvidenceTexts = collectUserRuleEvidenceTexts(
    window,
    extraction.meetingLedger.sourceRefs || [],
  );

  return keepOnlyEvidenceBackedRuleStatements(
    sanitizeKnowledgeFacts(extraction.facts),
    userRuleEvidenceTexts,
  );
}

/**
 * Process meeting ledger items with quality checks.
 */
export function processMeetingLedger(
  extraction: KnowledgeExtractionResult,
  window: IngestionWindow,
): {
  decisions: string[];
  negotiatedTerms: string[];
  openPoints: string[];
  actionItems: string[];
} {
  const userRuleEvidenceTexts = collectUserRuleEvidenceTexts(
    window,
    extraction.meetingLedger.sourceRefs || [],
  );

  return {
    decisions: keepOnlyEvidenceBackedRuleStatements(
      extraction.meetingLedger.decisions,
      userRuleEvidenceTexts,
    ),
    negotiatedTerms: keepOnlyEvidenceBackedRuleStatements(
      extraction.meetingLedger.negotiatedTerms,
      userRuleEvidenceTexts,
    ),
    openPoints: keepOnlyEvidenceBackedRuleStatements(
      extraction.meetingLedger.openPoints,
      userRuleEvidenceTexts,
    ),
    actionItems: keepOnlyEvidenceBackedRuleStatements(
      extraction.meetingLedger.actionItems,
      userRuleEvidenceTexts,
    ),
  };
}

/**
 * Store facts to Mem0 with all metadata, rate limiting, and error handling.
 */
export async function storeFacts(
  memoryService: MemoryServiceLike | null | undefined,
  repo: KnowledgeRepositoryLike,
  facts: string[],
  context: FactProcessingContext,
): Promise<{
  failCount: number;
  skippedCount: number;
  pendingCount: number;
  memoryIds: string[];
}> {
  if (!memoryService) {
    return { failCount: 0, skippedCount: facts.length, pendingCount: facts.length, memoryIds: [] };
  }

  const { window, extraction, dominantEmotion, corrections } = context;
  const topicKey = String(extraction.meetingLedger.topicKey || '').trim() || DEFAULT_TOPIC_KEY;
  const sourceSeqStart = inferSourceStart(window);
  const sourceSeqEnd = inferSourceEnd(window);

  // ── Phase 1: pre-process all facts synchronously (metadata + guards) ──────
  interface PreparedFact {
    fact: string;
    metadata: Record<string, unknown>;
  }
  const prepared: PreparedFact[] = [];
  let skippedCount = 0;

  for (let factIdx = 0; factIdx < facts.length; factIdx++) {
    const fact = facts[factIdx];

    // Memory Poisoning Guard
    const poisoningCheck = checkMemoryPoisoning(fact);
    if (poisoningCheck.riskLevel === 'blocked') {
      console.warn(
        '[KnowledgeIngestion] poisoning guard blocked fact:',
        poisoningCheck.reason,
        fact.slice(0, 80),
      );
      skippedCount++;
      continue;
    }

    const subject = detectFactSubject(fact);
    const metadata: Record<string, unknown> = {
      topicKey,
      conversationId: window.conversationId,
      sourceSeqStart,
      sourceSeqEnd,
      subject,
      sourceRole: subject === 'assistant' ? 'assistant' : subject === 'user' ? 'user' : 'mixed',
      sourceType: 'knowledge_ingestion',
      artifactType: 'fact',
      selfReference: subject === 'assistant',
    };

    if (poisoningCheck.riskLevel === 'suspicious') {
      metadata.securityFlag = 'suspicious';
      metadata.securityReason = poisoningCheck.reason;
    }

    if (dominantEmotion) {
      metadata.emotionalTone = dominantEmotion.emotion;
      metadata.emotionIntensity = dominantEmotion.intensity;
      if (dominantEmotion.trigger) {
        metadata.emotionTrigger = dominantEmotion.trigger;
      }
    }

    if (corrections.length > 0) {
      metadata.hasCorrections = true;
      metadata.correctionCount = corrections.length;
    }

    // Within-batch contradiction detection (against already-prepared facts)
    let lifecycleStatus: LifecycleStatus = 'new';
    for (const prev of prepared) {
      const signal = detectContradictionSignal(fact, prev.fact);
      if (signal.hasContradiction) {
        metadata.contradictionDetected = true;
        metadata.contradictionType = signal.contradictionType;
        metadata.contradictionConfidence = signal.confidence;
        metadata.supersedes = prev.fact;
        prev.metadata.lifecycleStatus = transitionLifecycle('new', 'contradicted');
        prev.metadata.lifecycleSignal = 'contradicted';
        prev.metadata.supersededBy = fact;
        metadata.supersededFactLifecycleStatus = prev.metadata.lifecycleStatus;
        break;
      }
    }

    if (corrections.length > 0) {
      // The correction is the active replacement. The superseded source is
      // marked above when it is present in the same extraction window.
      lifecycleStatus = 'confirmed';
      metadata.lifecycleSignal = 'user_confirmed';
    }
    metadata.lifecycleStatus = lifecycleStatus;
    metadata.idempotencyKey = createMemoryIdempotencyKey([
      'knowledge-fact',
      window.userId,
      window.personaId,
      window.conversationId,
      sourceSeqStart,
      sourceSeqEnd,
      fact,
    ]);

    prepared.push({ fact, metadata });
  }

  if (prepared.length === 0) {
    return { failCount: 0, skippedCount, pendingCount: 0, memoryIds: [] };
  }

  // Resolve contradictions against already persisted facts as well. This
  // closes the former batch-only lifecycle gap without trusting raw Mem0 IDs:
  // the MemoryService applies the same user/persona scope check before update.
  if (memoryService.listPage && memoryService.update) {
    try {
      const existing = await memoryService.listPage(
        window.personaId,
        { page: 1, pageSize: 200, type: 'fact' },
        window.userId,
      );
      for (const preparedFact of prepared) {
        const prior = existing.nodes.find((node) => {
          const signal = detectContradictionSignal(preparedFact.fact, node.content);
          return signal.hasContradiction && node.metadata?.lifecycleStatus !== 'superseded';
        });
        if (!prior) continue;
        preparedFact.metadata.contradictionDetected = true;
        preparedFact.metadata.supersedesMemoryId = prior.id;
        preparedFact.metadata.lifecycleStatus = 'confirmed';
        preparedFact.metadata.lifecycleSignal = 'user_confirmed';
        await memoryService.update(
          window.personaId,
          prior.id,
          {
            metadata: {
              lifecycleStatus: 'superseded',
              lifecycleSignal: 'contradicted',
              supersededBy: preparedFact.fact,
              lastVerified: new Date().toISOString(),
            },
          },
          window.userId,
        );
      }
    } catch (error) {
      // A lifecycle maintenance failure must not turn a successfully stored
      // fact into a false ingestion failure. It remains visible for retry.
      console.warn(
        '[KnowledgeIngestion] persisted contradiction maintenance skipped:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // ── Phase 2: store facts sequentially with per-window circuit breaker ──────
  // Sequential execution ensures at most 1 in-flight Mem0 call at a time,
  // preventing connection pool exhaustion.
  let failCount = 0;
  let pendingCount = 0;
  let consecutiveFailures = 0;
  const memoryIds: string[] = [];

  for (let i = 0; i < prepared.length; i++) {
    // Per-window circuit breaker: stop after too many consecutive failures
    if (consecutiveFailures >= MEM0_MAX_CONSECUTIVE_FAILURES_PER_WINDOW) {
      console.warn(
        `[KnowledgeIngestion] Per-window circuit breaker open after ${consecutiveFailures} consecutive failures; skipping remaining ${prepared.length - i} fact(s).`,
      );
      skippedCount += prepared.length - i;
      pendingCount += prepared.length - i;
      break;
    }

    const { fact, metadata } = prepared[i];
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      const storePromise = memoryService.storeMemory
        ? memoryService.storeMemory({
            personaId: window.personaId,
            type: 'fact',
            content: fact,
            importance: 4,
            userId: window.userId,
            metadata,
            signal: controller.signal,
          })
        : memoryService.store(
            window.personaId,
            'fact',
            fact,
            4,
            window.userId,
            metadata,
            controller.signal,
          );
      storePromise.catch(() => {});
      const stored = await Promise.race([
        storePromise,
        new Promise<never>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            controller.abort();
            reject(
              new Error(
                `[KnowledgeIngestion] Mem0 fact store timeout after ${MEM0_STORE_FACT_TIMEOUT_MS}ms`,
              ),
            );
          }, MEM0_STORE_FACT_TIMEOUT_MS);
        }),
      ]);
      if (stored && typeof stored === 'object' && 'id' in stored) {
        const storedId = String((stored as { id?: unknown }).id || '').trim();
        if (storedId) memoryIds.push(storedId);
      }
      consecutiveFailures = 0;
    } catch (err) {
      failCount++;
      pendingCount++;
      consecutiveFailures++;
      const errorText = err instanceof Error ? err.message : String(err);
      console.warn(
        `[KnowledgeIngestion] Mem0 store failed for fact ${i + 1}/${prepared.length}:`,
        errorText,
      );
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  // ── Phase 3: aggregate ────────────────────────────────────────────────────
  if (failCount > 0) {
    console.warn(
      `[KnowledgeIngestion] Mem0 store summary for window ${window.personaId}` +
        ` seq=${sourceSeqStart}-${sourceSeqEnd}: failed=${failCount}/${prepared.length}`,
    );
  }

  return { failCount, skippedCount, pendingCount, memoryIds };
}
