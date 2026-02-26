import type { SwarmFriction } from '@/server/agent-room/types';

export function deriveConflictRadar(artifact: string): SwarmFriction {
  const now = new Date().toISOString();
  const fullText = String(artifact || '');
  if (!fullText.trim()) {
    return { level: 'low', confidence: 0, hold: false, reasons: [], updatedAt: now };
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
    return { level: 'low', confidence: 0, hold: false, reasons: [], updatedAt: now };
  }

  const signalDefs: Array<{ pattern: RegExp; label: string; severity: 'risk' | 'severe' }> = [
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

  let riskHits = 0;
  let severeHits = 0;
  const reasons: string[] = [];

  for (const def of signalDefs) {
    if (def.pattern.test(text)) {
      if (def.severity === 'severe') severeHits++;
      else riskHits++;
      const sentences = text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 10);
      const excerpt = sentences.find((s) => def.pattern.test(s));
      if (excerpt) {
        const trimmed = excerpt.trim().slice(0, 120);
        reasons.push(
          `${def.label}: "${trimmed.length < excerpt.trim().length ? `${trimmed}…` : trimmed}"`,
        );
      } else {
        reasons.push(def.label);
      }
    }
  }

  const score = Math.min(100, riskHits * 25 + severeHits * 35);
  const level: SwarmFriction['level'] = score >= 65 ? 'high' : score >= 30 ? 'medium' : 'low';
  return {
    level,
    confidence: score,
    hold: false,
    reasons,
    updatedAt: now,
  };
}
