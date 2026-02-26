/**
 * A single turn in the structured artifact.
 */
export interface ArtifactTurn {
  /** Unique turn ID (sequential) */
  id: string;
  /** Phase during which this turn occurred */
  phase: string;
  /** Persona ID of the speaker */
  speakerPersonaId: string;
  /** Display name of the speaker */
  speakerName: string;
  /** The turn content (markdown text) */
  content: string;
  /** ISO timestamp of when the turn was recorded */
  timestamp: string;
  /** Consensus vote delta applied by this turn (-12, 0, or +8) */
  voteDelta?: number;
}

/**
 * A phase transition marker in the structured artifact.
 */
export interface PhaseTransition {
  from: string;
  to: string;
  /** The turn ID after which this transition occurred */
  afterTurnId: string;
}

/**
 * Fully structured artifact representation.
 * Stored alongside the legacy markdown `artifact` string for backward compat.
 */
export interface StructuredArtifact {
  /** Ordered list of turns */
  turns: ArtifactTurn[];
  /** Phase transition markers */
  phaseTransitions: PhaseTransition[];
}

/**
 * Parse a legacy markdown artifact string into a StructuredArtifact.
 * Handles the `**[Name]:** content` format and `--- Phase Label ---` dividers.
 */
export function parseArtifactToStructured(
  artifact: string | null | undefined,
  fallbackPhase?: string,
): StructuredArtifact {
  const result: StructuredArtifact = { turns: [], phaseTransitions: [] };
  if (!artifact) return result;

  const lines = artifact.split('\n');
  let currentPhase = fallbackPhase || 'analysis';
  let turnIndex = 0;

  // Regex for phase markers: --- Phase Label ---
  const phaseMarkerRe = /^---\s+(.+?)\s+---$/;
  // Regex for turn lines: **[Speaker Name]:** content
  const turnStartRe = /^\*\*\[([^\]]+)\]:\*\*\s*([\s\S]*)$/;

  let currentTurnName = '';
  let currentTurnContent = '';
  let inTurn = false;

  const flushTurn = (): void => {
    if (!inTurn || !currentTurnName) return;
    const turnId = `turn-${turnIndex}`;
    result.turns.push({
      id: turnId,
      phase: currentPhase,
      speakerPersonaId: '', // Cannot resolve from name alone
      speakerName: currentTurnName,
      content: currentTurnContent.trim(),
      timestamp: new Date().toISOString(),
    });
    turnIndex++;
    inTurn = false;
    currentTurnName = '';
    currentTurnContent = '';
  };

  for (const line of lines) {
    const phaseMatch = line.match(phaseMarkerRe);
    if (phaseMatch) {
      flushTurn();
      const previousPhase = currentPhase;
      // Try to map label back to phase key (best effort)
      currentPhase = labelToPhaseKey(phaseMatch[1]) || phaseMatch[1];
      if (result.turns.length > 0) {
        result.phaseTransitions.push({
          from: previousPhase,
          to: currentPhase,
          afterTurnId: result.turns[result.turns.length - 1].id,
        });
      }
      continue;
    }

    const turnMatch = line.match(turnStartRe);
    if (turnMatch) {
      flushTurn();
      currentTurnName = turnMatch[1].trim();
      currentTurnContent = turnMatch[2] || '';
      inTurn = true;
      continue;
    }

    if (inTurn) {
      currentTurnContent += '\n' + line;
    }
  }

  flushTurn();
  return result;
}

/**
 * Render a StructuredArtifact back to legacy markdown format.
 */
export function renderStructuredToMarkdown(structured: StructuredArtifact): string {
  const parts: string[] = [];
  let lastPhase = '';

  for (const turn of structured.turns) {
    // Check if the phase changed
    if (turn.phase !== lastPhase && lastPhase !== '') {
      const transition = structured.phaseTransitions.find(
        (t) => t.afterTurnId === structured.turns[structured.turns.indexOf(turn) - 1]?.id,
      );
      const label = transition ? phaseKeyToLabel(transition.to) : phaseKeyToLabel(turn.phase);
      parts.push(`--- ${label} ---`);
      parts.push('');
    }
    lastPhase = turn.phase;
    parts.push(`**[${turn.speakerName}]:** ${turn.content}`);
    parts.push('');
  }

  return parts.join('\n').trim();
}

/**
 * Append a turn to a StructuredArtifact.
 */
export function appendTurnToStructured(
  structured: StructuredArtifact,
  turn: Omit<ArtifactTurn, 'id'>,
  phaseComplete?: boolean,
  nextPhase?: string,
): StructuredArtifact {
  const newTurnId = `turn-${structured.turns.length}`;
  const newTurns = [...structured.turns, { ...turn, id: newTurnId }];
  const newTransitions = [...structured.phaseTransitions];

  if (phaseComplete && nextPhase && nextPhase !== turn.phase) {
    newTransitions.push({
      from: turn.phase,
      to: nextPhase,
      afterTurnId: newTurnId,
    });
  }

  return { turns: newTurns, phaseTransitions: newTransitions };
}

// ── Phase label helpers ─────────────────────────────────────────

const PHASE_LABEL_MAP: Record<string, string> = {
  analysis: 'Analysis',
  ideation: 'Ideation',
  critique: 'Critique',
  best_case: 'Best Case',
  result: 'Result',
};

const LABEL_TO_PHASE: Record<string, string> = Object.fromEntries(
  Object.entries(PHASE_LABEL_MAP).map(([k, v]) => [v.toLowerCase(), k]),
);

function phaseKeyToLabel(phase: string): string {
  return PHASE_LABEL_MAP[phase] || phase;
}

function labelToPhaseKey(label: string): string | null {
  return LABEL_TO_PHASE[label.toLowerCase().trim()] || null;
}
