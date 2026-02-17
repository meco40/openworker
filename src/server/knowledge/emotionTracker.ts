/**
 * Emotion Tracker — detects emotional states and tracks relationship trends.
 * Used by RolePlay personas for emotional continuity and relationship awareness.
 */

export interface EmotionalState {
  emotion: string;
  intensity: number; // 0.0–1.0
  trigger: string | null;
}

export type RelationshipStatus = 'positive' | 'neutral' | 'tense' | 'broken' | 'new' | 'rekindled';

export type RelationshipTrend = 'improving' | 'stable' | 'declining';

interface EmotionPattern {
  keyword: RegExp;
  emotion: string;
  baseIntensity: number;
}

const EMOTION_PATTERNS: EmotionPattern[] = [
  { keyword: /\btraurig\b/i, emotion: 'traurig', baseIntensity: 0.7 },
  { keyword: /\bgluecklich\b/i, emotion: 'gluecklich', baseIntensity: 0.7 },
  { keyword: /\bfroh\b/i, emotion: 'froh', baseIntensity: 0.6 },
  { keyword: /\bwuetend\b/i, emotion: 'wuetend', baseIntensity: 0.8 },
  { keyword: /\bangst\b/i, emotion: 'aengstlich', baseIntensity: 0.7 },
  { keyword: /\baengstlich\b/i, emotion: 'aengstlich', baseIntensity: 0.6 },
  { keyword: /\baufgeregt\b/i, emotion: 'aufgeregt', baseIntensity: 0.6 },
  { keyword: /\benttaeuscht\b/i, emotion: 'enttaeuscht', baseIntensity: 0.7 },
  { keyword: /\beinsam\b/i, emotion: 'einsam', baseIntensity: 0.7 },
  { keyword: /\bverliebt\b/i, emotion: 'verliebt', baseIntensity: 0.8 },
  { keyword: /\bnervoes\b/i, emotion: 'nervoes', baseIntensity: 0.5 },
  { keyword: /\bstolz\b/i, emotion: 'stolz', baseIntensity: 0.6 },
];

const INTENSIFIER_PATTERN = /\b(so|sehr|extrem|total|mega|unglaublich|solche)\b/i;
const TRIGGER_PATTERN = /\b(wegen\s+.{1,40}?)(?:\.|,|$)/i;

/**
 * Detects the primary emotion from a text message.
 * Returns null if no clear emotional signal is found.
 */
export function detectEmotion(text: string): EmotionalState | null {
  for (const pattern of EMOTION_PATTERNS) {
    if (pattern.keyword.test(text)) {
      let intensity = pattern.baseIntensity;

      // Intensifier boost
      if (INTENSIFIER_PATTERN.test(text)) {
        intensity = Math.min(1.0, intensity + 0.15);
      }

      // Extract trigger ("wegen X")
      const triggerMatch = text.match(TRIGGER_PATTERN);
      const trigger = triggerMatch ? triggerMatch[1].trim() : null;

      return {
        emotion: pattern.emotion,
        intensity,
        trigger,
      };
    }
  }

  return null;
}

const STATUS_ORDER: RelationshipStatus[] = [
  'broken',
  'tense',
  'neutral',
  'new',
  'positive',
  'rekindled',
];

function statusIndex(status: RelationshipStatus): number {
  const idx = STATUS_ORDER.indexOf(status);
  return idx >= 0 ? idx : 2; // default to neutral
}

/**
 * Derives the relationship trend from a sequence of status snapshots.
 * History is ordered chronologically (oldest first, newest last).
 */
export function deriveRelationshipTrend(history: RelationshipStatus[]): RelationshipTrend {
  if (history.length <= 1) return 'stable';

  const first = statusIndex(history[0]);
  const last = statusIndex(history[history.length - 1]);

  if (last > first) return 'improving';
  if (last < first) return 'declining';
  return 'stable';
}
