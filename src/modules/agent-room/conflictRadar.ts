import type { SwarmFriction } from '@/modules/agent-room/swarmTypes';
import { createDefaultFriction } from '@/modules/agent-room/swarmTypes';

function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((total, pattern) => total + (pattern.test(text) ? 1 : 0), 0);
}

export function deriveConflictRadar(artifact: string, now = new Date().toISOString()): SwarmFriction {
  const text = String(artifact || '').toLowerCase();
  if (!text.trim()) {
    return createDefaultFriction(now);
  }

  const riskPatterns = [
    /\b(fehl|risiko|konflikt|blocker|unsicher)\b/i,
    /\b(doubt|risk|conflict|blocker|unclear)\b/i,
    /\b(contradict|inconsistent|problem)\b/i,
  ];
  const severePatterns = [/\b(fatal|kritisch|critical|impossible)\b/i, /\b(abort|stop)\b/i];

  const riskHits = countMatches(text, riskPatterns);
  const severeHits = countMatches(text, severePatterns);
  const score = Math.min(100, riskHits * 25 + severeHits * 35);

  let level: SwarmFriction['level'] = 'low';
  if (score >= 65) level = 'high';
  else if (score >= 30) level = 'medium';

  return {
    level,
    confidence: score,
    hold: level === 'high',
    reasons: [
      riskHits > 0 ? `risk-signals:${riskHits}` : '',
      severeHits > 0 ? `severe-signals:${severeHits}` : '',
    ].filter(Boolean),
    updatedAt: now,
  };
}

