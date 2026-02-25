import {
  getSwarmPhaseLabel,
  isSwarmPhase,
  type ResolvedSwarmUnit,
  type SwarmPhase,
} from '@/modules/agent-room/swarmPhases';
import type { AgentRoomSwarmUnit } from '@/server/channels/messages/repository/types';

const VOTE_UP_DELTA = 8;
const VOTE_DOWN_DELTA = -12;
const DEFAULT_SIMPLE_SWARM_MAX_TURNS = 8;
const MIN_SIMPLE_SWARM_MAX_TURNS = 2;
const MAX_SIMPLE_SWARM_MAX_TURNS = 40;

function buildSpeakerPrefixes(
  speakerName: string,
  options?: { includePlainLabel?: boolean },
): string[] {
  const normalizedSpeaker = String(speakerName || '').trim();
  if (!normalizedSpeaker) return [];
  const prefixes = [
    `**[${normalizedSpeaker}]:**`,
    `**${normalizedSpeaker}:**`,
    `[${normalizedSpeaker}]:`,
  ];
  if (options?.includePlainLabel ?? true) {
    prefixes.push(`${normalizedSpeaker}:`);
  }
  return prefixes;
}

export function getSimpleSwarmMaxTurns(): number {
  const raw = Number(
    process.env.AGENT_ROOM_SIMPLE_MAX_TURNS ?? process.env.AGENT_ROOM_MAX_TURNS ?? '',
  );
  if (!Number.isFinite(raw)) return DEFAULT_SIMPLE_SWARM_MAX_TURNS;
  return Math.max(
    MIN_SIMPLE_SWARM_MAX_TURNS,
    Math.min(MAX_SIMPLE_SWARM_MAX_TURNS, Math.floor(raw)),
  );
}

export function chooseNextSpeakerPersonaId(params: {
  turnCount: number;
  leadPersonaId: string;
  units: AgentRoomSwarmUnit[];
}): string {
  const turnCount = Math.max(0, Math.floor(params.turnCount || 0));
  const leadPersonaId = String(params.leadPersonaId || '').trim();
  const orderedPersonaIds: string[] = [];
  const seen = new Set<string>();

  if (leadPersonaId) {
    orderedPersonaIds.push(leadPersonaId);
    seen.add(leadPersonaId);
  }

  for (const unit of params.units) {
    const personaId = String(unit.personaId || '').trim();
    if (!personaId || seen.has(personaId)) continue;
    orderedPersonaIds.push(personaId);
    seen.add(personaId);
  }

  if (orderedPersonaIds.length === 0) return '';
  return orderedPersonaIds[turnCount % orderedPersonaIds.length] || orderedPersonaIds[0];
}

export function countStructuredTurns(artifact: string): number {
  const text = String(artifact || '');
  if (!text.trim()) return 0;
  // One turn per line-prefix like: **[Persona Name]:** ...
  // Anchor to line start so duplicated in-line prefixes are not double-counted.
  const matches = text.match(/^\s*\*\*\[[^\]\n*]+?\]:\*\*/gm);
  return matches ? matches.length : 0;
}

export function extractRecentTurnHistory(artifact: string, maxTurns = 8): string {
  const text = String(artifact || '').trim();
  if (!text) return '';
  const chunks = text.split(/\n{2,}/).filter((chunk) => chunk.trim().length > 0);
  return chunks.slice(-Math.max(1, maxTurns)).join('\n\n');
}

export function buildSimpleTurnPrompt(params: {
  swarmTitle: string;
  task: string;
  phase: SwarmPhase;
  speaker: ResolvedSwarmUnit;
  leadPersonaId: string;
  recentHistory: string;
  units: ResolvedSwarmUnit[];
}): string {
  const isLead = params.speaker.personaId === params.leadPersonaId;
  const participants = params.units
    .map((unit) => `- ${unit.name} (${unit.role})`)
    .join('\n');

  const lines = [
    `You are ${params.speaker.name} (${params.speaker.role}) in a multi-persona swarm.`,
    `ROOM: ${params.swarmTitle}`,
    `GOAL: ${params.task}`,
    `PHASE: ${getSwarmPhaseLabel(params.phase)}`,
    `PARTICIPANTS:\n${participants}`,
    params.recentHistory ? `RECENT HISTORY:\n${params.recentHistory}` : '',
    'RULES:',
    `1) Start exactly with **[${params.speaker.name}]:**`,
    `2) Speak only as ${params.speaker.name}.`,
    '3) Keep it concise and concrete.',
    '4) You may include [VOTE:UP] or [VOTE:DOWN].',
    '5) Do not output another participant label (for example **[Other Agent]:**).',
    isLead
      ? '6) As orchestrator, you may change phase with [CHANGE_PHASE:analysis|ideation|critique|best_case|result].'
      : '6) Do not change phase.',
    '7) If useful, include a mermaid code block for flow/architecture.',
  ];

  return lines.filter(Boolean).join('\n\n');
}

export function parseTurnDirectives(params: {
  rawText: string;
  speakerPersonaId: string;
  leadPersonaId: string;
  currentPhase: SwarmPhase;
}): { cleanText: string; consensusDelta: number; nextPhase: SwarmPhase } {
  const rawText = String(params.rawText || '').trim();
  let consensusDelta = 0;
  if (/\[VOTE:DOWN\]/i.test(rawText)) {
    consensusDelta = VOTE_DOWN_DELTA;
  } else if (/\[VOTE:UP\]/i.test(rawText)) {
    consensusDelta = VOTE_UP_DELTA;
  }

  let nextPhase = params.currentPhase;
  if (String(params.speakerPersonaId || '').trim() === String(params.leadPersonaId || '').trim()) {
    const phaseMatch = rawText.match(/\[CHANGE_PHASE:([a-z_]+)\]/i);
    const candidate = String(phaseMatch?.[1] || '').trim().toLowerCase();
    if (candidate && isSwarmPhase(candidate)) {
      nextPhase = candidate;
    }
  }

  const cleanText = rawText
    .replace(/\[VOTE:UP\]|\[VOTE:DOWN\]/gi, '')
    .replace(/\[CHANGE_PHASE:[^\]]+\]/gi, '')
    .trim();

  return {
    cleanText,
    consensusDelta,
    nextPhase,
  };
}

export function shouldCompleteSwarmAfterTurn(nextPhase: SwarmPhase): boolean {
  return shouldCompleteSwarmAfterTurnWithTurnCount(nextPhase, 0);
}

export function shouldCompleteSwarmAfterTurnWithTurnCount(
  nextPhase: SwarmPhase,
  nextTurnCount: number,
  maxTurns = getSimpleSwarmMaxTurns(),
): boolean {
  const safeTurnCount = Number.isFinite(nextTurnCount) ? Math.max(0, Math.floor(nextTurnCount)) : 0;
  return nextPhase === 'result' || safeTurnCount >= maxTurns;
}

export function stripLeadingSpeakerPrefix(text: string, speakerName: string): string {
  const raw = String(text || '').trimStart();
  const prefixes = buildSpeakerPrefixes(speakerName);
  if (!raw || prefixes.length === 0) return raw;
  const lowerRaw = raw.toLowerCase();

  for (const prefix of prefixes) {
    if (lowerRaw.startsWith(prefix.toLowerCase())) {
      return raw.slice(prefix.length).trim();
    }
  }

  return raw;
}

export function stripTrailingOtherSpeakerTurns(
  text: string,
  activeSpeakerName: string,
  participantNames: string[],
): string {
  const raw = String(text || '').trim();
  if (!raw) return '';

  const active = String(activeSpeakerName || '').trim().toLowerCase();
  const otherNames = Array.from(
    new Set(
      participantNames
        .map((name) => String(name || '').trim())
        .filter((name) => name && name.toLowerCase() !== active),
    ),
  );
  if (otherNames.length === 0) return raw;

  const lowerRaw = raw.toLowerCase();
  let cutIndex = -1;
  for (const name of otherNames) {
    for (const prefix of buildSpeakerPrefixes(name, { includePlainLabel: false })) {
      const index = lowerRaw.indexOf(prefix.toLowerCase());
      if (index > 0 && (cutIndex === -1 || index < cutIndex)) {
        cutIndex = index;
      }
    }
  }

  if (cutIndex <= 0) return raw;
  return raw.slice(0, cutIndex).trim();
}
