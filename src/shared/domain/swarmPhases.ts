/**
 * Canonical swarm phase constants and logic.
 *
 * Both frontend and backend re-export from here.
 * Server code must import from `@/shared/domain/swarmPhases` — never from `src/modules/`.
 */

export const SWARM_PHASES = [
  'analysis',
  'research',
  'ideation',
  'critique',
  'best_case',
  'result',
] as const;

export type SwarmPhase = (typeof SWARM_PHASES)[number];

const PHASE_LABELS: Record<SwarmPhase, string> = {
  analysis: 'Analysis',
  research: 'Research',
  ideation: 'Ideation',
  critique: 'Critique',
  best_case: 'Best Case',
  result: 'Result',
};

const PHASE_PROMPTS: Record<SwarmPhase, string> = {
  analysis: 'Analysiert die Aufgabe und benennt Kernannahmen, Risiken und Randbedingungen.',
  research: 'Recherchiert belastbare externe Quellen und sammelt faktenbasierte Evidenz.',
  ideation: 'Erstellt mehrere Lösungswege mit klaren Trade-offs.',
  critique: 'Prüft die Ideen kritisch, sucht Schwächen und Widersprüche.',
  best_case: 'Einigt euch auf die bestmögliche Lösung mit klarer Begründung.',
  result: 'Liefert ein finales, umsetzbares Ergebnis inkl. kurzer Begründung.',
};

const PHASE_ROUNDS: Record<SwarmPhase, number> = {
  analysis: 1,
  research: 1,
  ideation: 2,
  critique: 3,
  best_case: 1,
  result: 1,
};

export function getPhaseRounds(phase: SwarmPhase): number {
  return PHASE_ROUNDS[phase] || 1;
}

export function isSwarmPhase(value: string): value is SwarmPhase {
  return (SWARM_PHASES as readonly string[]).includes(value);
}

export function getSwarmPhaseLabel(phase: SwarmPhase): string {
  return PHASE_LABELS[phase];
}

export function getNextSwarmPhase(currentPhase: SwarmPhase): SwarmPhase | null {
  const index = SWARM_PHASES.indexOf(currentPhase);
  if (index < 0 || index >= SWARM_PHASES.length - 1) {
    return null;
  }
  return SWARM_PHASES[index + 1];
}

export function buildPhasePrompt(params: {
  task: string;
  phase: SwarmPhase;
  leadPersonaId?: string;
  units?: Array<{ personaId: string; role: string }>;
}): string {
  const task = String(params.task || '').trim();
  const phaseText = PHASE_PROMPTS[params.phase];
  const lead = String(params.leadPersonaId || '').trim();
  const units = Array.isArray(params.units)
    ? params.units
        .map((unit) => `${String(unit.role || '').trim()}: ${String(unit.personaId || '').trim()}`)
        .filter((entry) => entry !== ':')
    : [];
  const scope = [
    lead ? `LEAD PERSONA: ${lead}` : '',
    units.length > 0 ? `SWARM UNITS:\n- ${units.join('\n- ')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return [`SWARM PHASE: ${getSwarmPhaseLabel(params.phase)}`, phaseText, scope, `TASK: ${task}`]
    .filter(Boolean)
    .join('\n\n');
}

export interface ResolvedSwarmUnit {
  personaId: string;
  role: string;
  name: string;
  emoji: string;
}

/**
 * Builds a prompt for a single agent's turn within a swarm phase.
 */
export function buildAgentTurnPrompt(params: {
  task: string;
  phase: SwarmPhase;
  unit: ResolvedSwarmUnit;
  agentIndex: number;
  priorResponses: string[];
  isLastAgentInPhase: boolean;
}): string {
  const task = String(params.task || '').trim();
  const phaseText = PHASE_PROMPTS[params.phase];
  const { unit, agentIndex, priorResponses, isLastAgentInPhase } = params;

  const identity = `Du bist ${unit.emoji} **${unit.name}**, ${unit.role}, in einem KI-Agenten-Swarm.`;

  const priorContext =
    agentIndex > 0 && priorResponses.length > 0
      ? `Die anderen Agenten haben bereits in dieser Phase geantwortet:\n\n${priorResponses.join('\n\n')}`
      : '';

  const diagramInstruction =
    isLastAgentInPhase && params.phase === 'result'
      ? '\n- Füge am Ende deiner Antwort EINEN ```mermaid```-Codeblock ein, der die empfohlene Lösung als Diagramm darstellt (z.B. Flussdiagramm, Komponentendiagramm oder Sequenzdiagramm).'
      : '';

  const instructions = [
    `Beginne deine Antwort GENAU mit: **[${unit.name}]:**`,
    `Antworte NUR als ${unit.name} (${unit.role}) – schreibe NICHT für andere Agenten.`,
    agentIndex > 0
      ? 'Beziehe dich auf die bisherigen Antworten: stimme zu, widersprich oder ergänze sie konkret.'
      : '',
    'Sei spezifisch, direkt und nutze deine Expertise.',
    diagramInstruction,
  ]
    .filter(Boolean)
    .join('\n');

  return [
    identity,
    `SWARM PHASE: ${getSwarmPhaseLabel(params.phase)}`,
    phaseText,
    priorContext,
    `AUFGABE: ${task}`,
    `ANWEISUNGEN:\n${instructions}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
