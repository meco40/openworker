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

    if (feedback === 'negative') {
      const correction = extractCorrectionContent(userInput);
      if (correction) {
        await getMemoryService().store(
          conversation.personaId,
          'fact',
          correction,
          5,
          lastRecallState.userId,
          {
            subject: 'user',
            sourceRole: 'user',
            sourceType: 'feedback_correction',
          },
        );
      }
    }
  } catch (error) {
    console.error('Memory feedback learning failed:', error);
  }
}
