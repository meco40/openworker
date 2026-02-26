/**
 * Canonical Agent Room domain types.
 *
 * Both frontend (`src/modules/agent-room/`) and backend (`src/server/agent-room/`)
 * re-export from here — this is the single source of truth.
 */

// ── Swarm Lifecycle ──────────────────────────────────────────────────

export type SwarmStatus = 'idle' | 'running' | 'hold' | 'completed' | 'aborted' | 'error';

export interface SwarmUnit {
  personaId: string;
  role: string;
}

export interface SwarmFriction {
  level: 'low' | 'medium' | 'high';
  confidence: number;
  hold: boolean;
  reasons: string[];
  updatedAt: string;
}

// ── Phase Buffer ─────────────────────────────────────────────────────

export interface AgentSession {
  personaId: string;
  sessionId: string;
  lastSeq: number;
}

/**
 * Typed entries for phaseBuffer. Discriminated union for type safety.
 */
export type PhaseBufferEntry =
  | { type: 'agentsession'; personaId: string; sessionId: string; lastSeq: number }
  | { type: 'speaker'; personaId: string }
  | { type: 'speakerOverride'; personaId: string }
  | { type: 'phaseSummaryPending'; fromPhase: string };

// ── Turn Processing ──────────────────────────────────────────────────

export interface TurnDirectiveResult {
  cleanText: string;
  consensusDelta: number;
  nextPhase: string;
}

export interface PhaseAdvanceResult {
  nextPhase: string;
  phaseComplete: boolean;
  swarmComplete: boolean;
}

export interface SpeakerSelectionParams {
  turnCount: number;
  leadPersonaId: string;
  units: Array<{ personaId: string; role: string }>;
  /** When provided, enables role-based weighting per phase. */
  currentPhase?: string;
}

export interface TurnPromptParams {
  swarmTitle: string;
  task: string;
  phase: string;
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

// ── Vote ─────────────────────────────────────────────────────────────

export type SwarmVote = 'up' | 'down';

export interface TurnVote {
  turnIndex: number;
  personaId: string;
  vote: SwarmVote;
  timestamp: string;
}
