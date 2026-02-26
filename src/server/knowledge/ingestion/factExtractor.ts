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
  MEM0_MAX_CONSECUTIVE_FAILURES_PER_WINDOW,
  MEM0_RATE_LIMIT_DELAY_MS,
  DEFAULT_TOPIC_KEY,
} from './constants';
import type { MemoryServiceLike, KnowledgeRepositoryLike } from './types';
import type { KnowledgeExtractionResult } from '@/server/knowledge/extractor';
import type { EmotionDetectionResult } from './emotionTracker';

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
): Promise<{ failCount: number; skippedCount: number }> {
  if (!memoryService) {
    return { failCount: 0, skippedCount: 0 };
  }

  const { window, extraction, dominantEmotion, corrections } = context;
  const topicKey = String(extraction.meetingLedger.topicKey || '').trim() || DEFAULT_TOPIC_KEY;
  const sourceSeqStart = inferSourceStart(window);
  const sourceSeqEnd = inferSourceEnd(window);

  let mem0FailCount = 0;
  let mem0SkippedCount = 0;
  let mem0ConsecutiveFailCount = 0;

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
      continue;
    }

    // Detect subject based on self-references in the fact
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

    // Poisoning guard: flag suspicious content
    if (poisoningCheck.riskLevel === 'suspicious') {
      metadata.securityFlag = 'suspicious';
      metadata.securityReason = poisoningCheck.reason;
    }

    // Emotion metadata
    if (dominantEmotion) {
      metadata.emotionalTone = dominantEmotion.emotion;
      metadata.emotionIntensity = dominantEmotion.intensity;
      if (dominantEmotion.trigger) {
        metadata.emotionTrigger = dominantEmotion.trigger;
      }
    }

    // Correction annotations
    if (corrections.length > 0) {
      metadata.hasCorrections = true;
      metadata.correctionCount = corrections.length;
    }

    // Within-batch contradiction detection
    let lifecycleStatus: LifecycleStatus = 'new';
    for (let prevIdx = 0; prevIdx < factIdx; prevIdx++) {
      const signal = detectContradictionSignal(fact, facts[prevIdx]);
      if (signal.hasContradiction) {
        metadata.contradictionDetected = true;
        metadata.contradictionType = signal.contradictionType;
        metadata.contradictionConfidence = signal.confidence;
        metadata.supersedes = facts[prevIdx];
        metadata.supersededFactLifecycleStatus = transitionLifecycle('new', 'contradicted');
        break;
      }
    }

    // Fact lifecycle: apply correction signals
    if (corrections.length > 0) {
      lifecycleStatus = transitionLifecycle(lifecycleStatus, 'corrected_by_user');
    }
    metadata.lifecycleStatus = lifecycleStatus;

    // Circuit breaker for consecutive failures
    if (mem0ConsecutiveFailCount >= MEM0_MAX_CONSECUTIVE_FAILURES_PER_WINDOW) {
      mem0SkippedCount++;
      continue;
    }

    try {
      // Rate-limit Mem0 calls
      if (factIdx > 0) {
        await new Promise((resolve) => setTimeout(resolve, MEM0_RATE_LIMIT_DELAY_MS));
      }
      await memoryService.store(window.personaId, 'fact', fact, 4, window.userId, metadata);
      mem0ConsecutiveFailCount = 0;
    } catch (storeError) {
      mem0FailCount++;
      mem0ConsecutiveFailCount++;
      const errorText = storeError instanceof Error ? storeError.message : String(storeError);
      if (mem0ConsecutiveFailCount >= MEM0_MAX_CONSECUTIVE_FAILURES_PER_WINDOW) {
        console.warn(
          '[KnowledgeIngestion] Mem0 store failed, opening circuit for remaining facts:',
          errorText,
        );
      } else {
        console.warn(
          '[KnowledgeIngestion] Mem0 store failed, continuing with next fact:',
          errorText,
        );
      }
    }
  }

  if (mem0FailCount > 0 || mem0SkippedCount > 0) {
    console.warn(
      `[KnowledgeIngestion] Mem0 store summary for window ${window.personaId} seq=${sourceSeqStart}-${sourceSeqEnd}: failed=${mem0FailCount}, skipped_after_circuit=${mem0SkippedCount}, total_facts=${facts.length}`,
    );
  }

  return { failCount: mem0FailCount, skippedCount: mem0SkippedCount };
}
