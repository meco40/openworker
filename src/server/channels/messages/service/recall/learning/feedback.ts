/**
 * Feedback learning operations
 */

import type { Conversation } from '@/server/channels/messages/repository';
import { getMemoryService } from '@/server/memory/runtime';
import {
  detectMemoryFeedbackSignal,
  extractCorrectionContent,
  MEMORY_FEEDBACK_WINDOW_MS,
  type LastRecallState,
} from '../../types';
import { isMem0FactualWriteBlocked } from '@/server/world-model/mem0Policy';

/**
 * Learn from user feedback about memory recall
 * Adjusts memory weights based on positive/negative feedback
 */
export async function learnFromFeedback(
  conversation: Conversation,
  userInput: string,
  lastRecallState: LastRecallState | undefined,
): Promise<void> {
  if (!conversation.personaId) return;

  const feedback = detectMemoryFeedbackSignal(userInput);
  if (!feedback) return;

  if (!lastRecallState) return;
  if (lastRecallState.personaId !== conversation.personaId) return;
  if (Date.now() - lastRecallState.queriedAt > MEMORY_FEEDBACK_WINDOW_MS) {
    return;
  }

  try {
    await getMemoryService().registerFeedback(
      conversation.personaId,
      lastRecallState.nodeIds,
      feedback,
      lastRecallState.userId,
    );

    if (feedback === 'negative' && !isMem0FactualWriteBlocked()) {
      const correction = extractCorrectionContent(userInput);
      if (correction) {
        const memoryService = getMemoryService();
        const metadata = {
          subject: 'user',
          sourceRole: 'user',
          sourceType: 'feedback_correction',
        };
        if (typeof memoryService.storeMemory === 'function') {
          await memoryService.storeMemory({
            personaId: conversation.personaId,
            type: 'fact',
            content: correction,
            importance: 5,
            userId: lastRecallState.userId,
            metadata,
          });
        } else {
          await memoryService.store(
            conversation.personaId,
            'fact',
            correction,
            5,
            lastRecallState.userId,
            metadata,
          );
        }
      }
    }
  } catch (error) {
    console.error('Memory feedback learning failed:', error);
  }
}
