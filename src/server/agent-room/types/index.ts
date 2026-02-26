/**
 * Agent Room domain types
 */

import type { SwarmPhase } from '@/modules/agent-room/swarmPhases';

export interface AgentSession {
  personaId: string;
  sessionId: string;
  lastSeq: number;
}

/**
 * Typed entries for phaseBuffer. Replaces fragile colon-delimited string encoding
 * with a discriminated union for type safety and debuggability.
 */
export type PhaseBufferEntry =
  | { type: 'agentsession'; personaId: string; sessionId: string; lastSeq: number }
  | { type: 'speaker'; personaId: string };

export interface SwarmFriction {
  level: 'low' | 'medium' | 'high';
  confidence: number;
  hold: boolean;
  reasons: string[];
  updatedAt: string;
}

export interface TurnDirectiveResult {
  cleanText: string;
  consensusDelta: number;
  nextPhase: SwarmPhase;
}

export interface PhaseAdvanceResult {
  nextPhase: SwarmPhase;
  phaseComplete: boolean;
  swarmComplete: boolean;
}

export interface SpeakerSelectionParams {
  turnCount: number;
  leadPersonaId: string;
  units: Array<{ personaId: string; role: string }>;
}

export interface TurnPromptParams {
  swarmTitle: string;
  task: string;
  phase: SwarmPhase;
  speaker: {
    personaId: string;
    role: string;
    name: string;
    emoji: string;
  };
  leadPersonaId: string;
  recentHistory: string;
  units: Array<{
    personaId: string;
    role: string;
    name: string;
    emoji: string;
  }>;
  phaseRound?: number;
  phaseRoundsTotal?: number;
}
