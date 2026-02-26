import type { ResolvedSwarmUnit, SwarmPhase } from '@/modules/agent-room/swarmPhases';

export interface ParsedAgentTurn {
  personaId: string;
  personaName: string;
  personaEmoji: string;
  content: string;
}

function isLikelyCommandMarker(name: string): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) {
    return true;
  }
  if (/^(?:cmd|command)[-_][a-z0-9-]{8,}$/i.test(name)) {
    return true;
  }
  return false;
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
    const personaId = String(unit.personaId || '')
      .trim()
      .toLowerCase();
    if (personaId) {
      nameMap.set(personaId, unit);
    }
  }
  const fallbackUnit =
    units.find((u) => u.personaId === fallbackPersonaId) ??
    units.find((u) => u.role === 'lead') ??
    units[0];

  // Split on speaker marker patterns.
  // Matches:
  // - **[Name]:** (primary format in swarm artifacts)
  // - **Name:**
  // - **[Name]**: (legacy)
  const markerPattern = /\*\*\[?([^\]\n*]+?)\]?(?::\*\*|\*\*\s*:)/g;
  const rawSegments: Array<{ start: number; end: number; name: string }> = [];

  let match: RegExpExecArray | null;
  while ((match = markerPattern.exec(text)) !== null) {
    rawSegments.push({
      start: match.index,
      end: match.index + match[0].length,
      name: match[1].trim(),
    });
  }

  // Some model outputs prefix a turn with an inline command id marker:
  // **[Persona]:** **[<command-id>]:** actual content
  // Merge these metadata markers into the preceding speaker marker so content
  // remains attributed to the declared persona.
  const segments: Array<{ start: number; end: number; name: string }> = [];
  for (const segment of rawSegments) {
    const previous = segments[segments.length - 1];
    if (
      previous &&
      isLikelyCommandMarker(segment.name) &&
      text.slice(previous.end, segment.start).trim().length === 0
    ) {
      previous.end = segment.end;
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    // No markers found — assign to command fallback persona first
    return [
      {
        personaId: fallbackUnit.personaId,
        personaName: fallbackUnit.name,
        personaEmoji: fallbackUnit.emoji,
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
      // Unknown name — use command fallback persona
      turns.push({
        personaId: fallbackUnit.personaId,
        personaName: fallbackUnit.name,
        personaEmoji: fallbackUnit.emoji,
        content,
      });
    }
  }

  return turns;
}

export type { SwarmPhase };
