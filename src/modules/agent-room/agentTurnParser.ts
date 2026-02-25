import type { ResolvedSwarmUnit, SwarmPhase } from '@/modules/agent-room/swarmPhases';

export interface ParsedAgentTurn {
  personaId: string;
  personaName: string;
  personaEmoji: string;
  content: string;
}

/**
 * Parses a raw AI response into per-agent turns.
 * Looks for **[Name]:** markers in the text and splits on them.
 * Falls back to assigning the entire text to the lead persona.
 */
export function parseAgentTurns(
  rawText: string,
  units: ResolvedSwarmUnit[],
  fallbackPersonaId: string,
): ParsedAgentTurn[] {
  const text = String(rawText || '').trim();
  if (!text) return [];

  if (units.length === 0) {
    return [
      { personaId: fallbackPersonaId, personaName: 'Agent', personaEmoji: '🤖', content: text },
    ];
  }

  // Build a map from lowercase name → unit
  const nameMap = new Map<string, ResolvedSwarmUnit>();
  for (const unit of units) {
    nameMap.set(unit.name.toLowerCase(), unit);
  }

  // Split on **[Name]:** pattern
  // Matches: **[Name]:** or **Name:** at the start of a segment
  const markerPattern = /\*\*\[?([^\]\n*]+?)\]?\*\*\s*:/g;
  const segments: Array<{ start: number; end: number; name: string }> = [];

  let match: RegExpExecArray | null;
  while ((match = markerPattern.exec(text)) !== null) {
    segments.push({
      start: match.index,
      end: match.index + match[0].length,
      name: match[1].trim(),
    });
  }

  if (segments.length === 0) {
    // No markers found — assign to lead
    const lead = units.find((u) => u.role === 'lead') ?? units[0];
    return [
      {
        personaId: lead.personaId,
        personaName: lead.name,
        personaEmoji: lead.emoji,
        content: text,
      },
    ];
  }

  const turns: ParsedAgentTurn[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const nextSeg = segments[i + 1];
    const content = text.slice(seg.end, nextSeg ? nextSeg.start : undefined).trim();
    if (!content) continue;

    const unit = nameMap.get(seg.name.toLowerCase());
    if (unit) {
      turns.push({
        personaId: unit.personaId,
        personaName: unit.name,
        personaEmoji: unit.emoji,
        content,
      });
    } else {
      // Unknown name — use lead as fallback
      const lead = units.find((u) => u.role === 'lead') ?? units[0];
      turns.push({
        personaId: lead.personaId,
        personaName: seg.name,
        personaEmoji: lead.emoji,
        content,
      });
    }
  }

  return turns;
}

export type { SwarmPhase };
