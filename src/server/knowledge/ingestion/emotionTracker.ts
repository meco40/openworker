import { detectEmotion, type EmotionalState } from '@/server/knowledge/emotionTracker';
import type { IngestionWindow } from '@/server/knowledge/ingestionCursor';

// Re-export the EmotionalState type as EmotionDetectionResult for convenience
export type EmotionDetectionResult = EmotionalState;

/**
 * Detect the dominant emotion across all messages in a window.
 * Scans messages for emotional signals and returns the most intense one.
 */
export function detectDominantEmotion(window: IngestionWindow): EmotionalState | null {
  let dominantEmotion: EmotionalState | null = null;

  for (const msg of window.messages) {
    const content = String(msg.content || '');
    const detected = detectEmotion(content);
    if (detected && (!dominantEmotion || detected.intensity > dominantEmotion.intensity)) {
      dominantEmotion = detected;
    }
  }

  return dominantEmotion;
}

// Re-export the base detectEmotion function and EmotionalState type for convenience
export { detectEmotion, type EmotionalState } from '@/server/knowledge/emotionTracker';
