import type { SwarmFriction } from '@/modules/agent-room/swarmTypes';
import { createDefaultFriction } from '@/modules/agent-room/swarmTypes';

interface PatternDef {
  pattern: RegExp;
  label: string;
  severity: 'risk' | 'severe';
}

const SIGNAL_PATTERNS: PatternDef[] = [
  {
    pattern: /\b(fehl|risiko|konflikt|blocker|unsicher)\b/i,
    label: 'Risk keywords (DE)',
    severity: 'risk',
  },
  {
    pattern: /\b(doubt|risk|conflict|blocker|unclear)\b/i,
    label: 'Risk keywords (EN)',
    severity: 'risk',
  },
  {
    pattern: /\b(contradict|inconsistent|disagree)\b/i,
    label: 'Disagreement signal',
    severity: 'risk',
  },
  {
    pattern: /\b(fatal|critical failure|impossible)\b/i,
    label: 'Critical blocker',
    severity: 'severe',
  },
  { pattern: /\[VOTE:DOWN\]/i, label: 'Agent voted DOWN', severity: 'severe' },
];

/**
 * Extract the sentence containing a regex match for context display.
 * Returns up to `limit` unique excerpts.
 */
function extractExcerpts(text: string, pattern: RegExp, limit = 2): string[] {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 10);
  const excerpts: string[] = [];
  for (const sentence of sentences) {
    if (pattern.test(sentence)) {
      const trimmed = sentence.trim().slice(0, 120);
      excerpts.push(trimmed.length < sentence.trim().length ? `${trimmed}…` : trimmed);
      if (excerpts.length >= limit) break;
    }
  }
  return excerpts;
}

/**
 * Analyze the current phase section of the artifact (text after the last
 * `--- Phase ---` marker) for conflict signals. Returns structured friction
 * data with actual context excerpts instead of opaque hit counts.
 */
export function deriveConflictRadar(
  artifact: string,
  now = new Date().toISOString(),
): SwarmFriction {
  const fullText = String(artifact || '');
  if (!fullText.trim()) {
    return createDefaultFriction(now);
  }

  // Only analyze the current phase section (after last marker)
  const markerRegex = /^---\s+.+?\s+---$/gm;
  let lastMarkerEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = markerRegex.exec(fullText))) {
    lastMarkerEnd = m.index + m[0].length;
  }
  const text = fullText.slice(lastMarkerEnd);
  if (!text.trim()) {
    return createDefaultFriction(now);
  }

  let riskHits = 0;
  let severeHits = 0;
  const reasons: string[] = [];

  for (const def of SIGNAL_PATTERNS) {
    if (def.pattern.test(text)) {
      if (def.severity === 'severe') severeHits++;
      else riskHits++;

      const excerpts = extractExcerpts(text, def.pattern, 1);
      if (excerpts.length > 0) {
        reasons.push(`${def.label}: "${excerpts[0]}"`);
      } else {
        reasons.push(def.label);
      }
    }
  }

  const score = Math.min(100, riskHits * 25 + severeHits * 35);

  let level: SwarmFriction['level'] = 'low';
  if (score >= 65) level = 'high';
  else if (score >= 30) level = 'medium';

  return {
    level,
    confidence: score,
    hold: level === 'high',
    reasons,
    updatedAt: now,
  };
}
