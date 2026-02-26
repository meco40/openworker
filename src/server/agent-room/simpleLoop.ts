import {
  getNextSwarmPhase,
  getSwarmPhaseLabel,
  type ResolvedSwarmUnit,
  type SwarmPhase,
} from '@/modules/agent-room/swarmPhases';
import type { AgentRoomSwarmUnit } from '@/server/channels/messages/repository/types';

const VOTE_UP_DELTA = 8;
const VOTE_DOWN_DELTA = -12;
const DEFAULT_SIMPLE_SWARM_MAX_TURNS = 40;

/**
 * Number of full rounds (every agent speaks once = 1 round) per phase.
 * Critique gets 3 rounds for thorough debate; other phases get 1 round.
 */
const PHASE_ROUNDS: Record<SwarmPhase, number> = {
  analysis: 1,
  ideation: 2,
  critique: 3,
  best_case: 1,
  result: 1,
};

export function getPhaseRounds(phase: SwarmPhase): number {
  return PHASE_ROUNDS[phase] || 1;
}

/** Turns required before auto-advancing a phase = rounds × agents. */
export function getTurnsRequiredForPhase(phase: SwarmPhase, numAgents: number): number {
  return getPhaseRounds(phase) * Math.max(1, numAgents);
}

/**
 * Count `**[Name]:**` turns that appear AFTER the last `--- Phase ---` marker.
 * This gives the turn count within the current phase.
 */
export function countTurnsInCurrentPhase(artifact: string): number {
  const text = String(artifact || '').trim();
  if (!text) return 0;
  const phaseMarkerRegex = /^---\s+.+?\s+---$/gm;
  let lastMarkerEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = phaseMarkerRegex.exec(text))) {
    lastMarkerEnd = m.index + m[0].length;
  }
  const textAfterMarker = text.slice(lastMarkerEnd);
  const turns = textAfterMarker.match(/^\s*\*\*\[[^\]\n*]+?\]:\*\*/gm);
  return turns ? turns.length : 0;
}

/**
 * Determine the next phase after a turn completes, based on
 * server-side turn counting — NOT on AI model directives.
 * Returns { nextPhase, phaseComplete } where `phaseComplete` means
 * the current phase just finished and a phase marker should be inserted.
 */
export function computeNextPhaseAfterTurn(params: {
  currentPhase: SwarmPhase;
  artifactAfterTurn: string;
  numAgents: number;
}): { nextPhase: SwarmPhase; phaseComplete: boolean; swarmComplete: boolean } {
  const turnsInPhase = countTurnsInCurrentPhase(params.artifactAfterTurn);
  const required = getTurnsRequiredForPhase(params.currentPhase, params.numAgents);

  if (turnsInPhase >= required) {
    const next = getNextSwarmPhase(params.currentPhase);
    if (!next) {
      // We're at 'result' and have completed the required turns
      return { nextPhase: params.currentPhase, phaseComplete: true, swarmComplete: true };
    }
    return { nextPhase: next, phaseComplete: true, swarmComplete: false };
  }
  return { nextPhase: params.currentPhase, phaseComplete: false, swarmComplete: false };
}
const MIN_SIMPLE_SWARM_MAX_TURNS = 4;
const MAX_SIMPLE_SWARM_MAX_TURNS = 60;

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
  const envVal = process.env.AGENT_ROOM_SIMPLE_MAX_TURNS ?? process.env.AGENT_ROOM_MAX_TURNS;
  if (!envVal) return DEFAULT_SIMPLE_SWARM_MAX_TURNS;
  const raw = Number(envVal);
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
  phaseRound?: number;
  phaseRoundsTotal?: number;
}): string {
  const participants = params.units.map((unit) => `- ${unit.name} (${unit.role})`).join('\n');

  const phaseLabel = getSwarmPhaseLabel(params.phase);
  const roundInfo =
    params.phaseRound && params.phaseRoundsTotal && params.phaseRoundsTotal > 1
      ? ` (Round ${params.phaseRound} of ${params.phaseRoundsTotal})`
      : '';

  const phaseGuidance = buildPhaseGuidance(params.phase, params.phaseRound ?? 1);

  const lines = [
    `You are ${params.speaker.name} (${params.speaker.role}) in a multi-persona swarm.`,
    `ROOM: ${params.swarmTitle}`,
    `GOAL: ${params.task}`,
    `PHASE: ${phaseLabel}${roundInfo}`,
    `PARTICIPANTS:\n${participants}`,
    params.recentHistory ? `RECENT CONVERSATION:\n${params.recentHistory}` : '',
    phaseGuidance ? `PHASE GUIDANCE: ${phaseGuidance}` : '',
    'RULES:',
    `1) Start exactly with **[${params.speaker.name}]:**`,
    `2) Speak only as ${params.speaker.name}.`,
    '3) Respond directly to what the other participants said — this is a live discussion.',
    '4) Keep it concise and concrete.',
    '5) Do not output another participant label (for example **[Other Agent]:**).',
    '6) Do not change phase — phases are managed automatically.',
    params.phase === 'result'
      ? '7) Include a mermaid code block summarizing the final decision as a diagram.'
      : '7) If useful, include a mermaid code block for flow/architecture.',
  ];

  return lines.filter(Boolean).join('\n\n');
}

function buildPhaseGuidance(phase: SwarmPhase, round: number): string {
  switch (phase) {
    case 'analysis':
      return 'Identify key assumptions, risks, constraints, and open questions about the task.';
    case 'ideation':
      if (round === 1)
        return 'Propose your concrete solution approach with clear trade-offs. Be creative and specific.';
      return "Respond to the other participant's ideas. Build on strengths, challenge weaknesses, and refine the approach together.";
    case 'critique':
      if (round === 1)
        return 'Critically examine the proposed ideas. Find weaknesses, gaps, and contradictions.';
      if (round === 2)
        return 'Respond to the first round of critique. Defend, refine, or withdraw ideas based on the feedback.';
      return 'Final critique round. Converge on the strongest approach. Identify remaining risks.';
    case 'best_case':
      return 'Agree on the single best solution with clear justification. Resolve any remaining disagreements.';
    case 'result':
      return 'Deliver the final, actionable result with a concise rationale and a summary diagram.';
    default:
      return '';
  }
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

  // Phase transitions are server-controlled (automatic based on turn counts).
  // Strip any [CHANGE_PHASE:] the model might still emit, but do NOT act on it.
  const nextPhase = params.currentPhase;

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
  // Only hard-cap on maxTurns. Phase-based completion is handled by computeNextPhaseAfterTurn.
  return safeTurnCount >= maxTurns;
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

  const active = String(activeSpeakerName || '')
    .trim()
    .toLowerCase();
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
