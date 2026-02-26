import type { SwarmPhase } from '@/shared/domain/swarmPhases';
import type { TurnDirectiveResult } from '@/server/agent-room/types';

const VOTE_UP_DELTA = 8;
const VOTE_DOWN_DELTA = -12;

export function parseTurnDirectives(params: {
  rawText: string;
  speakerPersonaId: string;
  leadPersonaId: string;
  currentPhase: SwarmPhase;
}): TurnDirectiveResult {
  const rawText = String(params.rawText || '').trim();
  let consensusDelta = 0;
  if (/\[VOTE:DOWN\]/i.test(rawText)) {
    consensusDelta = VOTE_DOWN_DELTA;
  } else if (/\[VOTE:UP\]/i.test(rawText)) {
    consensusDelta = VOTE_UP_DELTA;
  }

  // Phase transitions are server-controlled
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
