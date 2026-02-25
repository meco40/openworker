export const SWARM_PHASES = ['analysis', 'ideation', 'critique', 'best_case', 'result'] as const;

export type SwarmPhase = (typeof SWARM_PHASES)[number];

const PHASE_LABELS: Record<SwarmPhase, string> = {
  analysis: 'Analysis',
  ideation: 'Ideation',
  critique: 'Critique',
  best_case: 'Best Case',
  result: 'Result',
};

const PHASE_PROMPTS: Record<SwarmPhase, string> = {
  analysis: 'Analysiert die Aufgabe und benennt Kernannahmen, Risiken und Randbedingungen.',
  ideation: 'Erstellt mehrere Lösungswege mit klaren Trade-offs.',
  critique: 'Prüft die Ideen kritisch, sucht Schwächen und Widersprüche.',
  best_case: 'Einigt euch auf die bestmögliche Lösung mit klarer Begründung.',
  result: 'Liefert ein finales, umsetzbares Ergebnis inkl. kurzer Begründung.',
};

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
 * Agents execute sequentially; each agent sees the prior agents' responses.
 *
 * @param params.isLastAgentInPhase - When true AND phase=result, adds a mermaid diagram instruction
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

/**
 * Builds a phase prompt that includes resolved persona names and emojis.
 * @deprecated Use buildAgentTurnPrompt for sequential per-agent execution.
 */
export function buildPhasePromptWithNames(params: {
  task: string;
  phase: SwarmPhase;
  units: ResolvedSwarmUnit[];
}): string {
  const task = String(params.task || '').trim();
  const phaseText = PHASE_PROMPTS[params.phase];
  const unitLines = params.units.map((u) => `- ${u.emoji} **${u.name}** (${u.role})`).join('\n');
  const names = params.units.map((u) => u.name).join(', ');

  const formatInstruction =
    params.units.length > 0
      ? `Du bist ein Swarm aus ${params.units.length} KI-Agenten (${names}). ` +
        `Führe eine strukturierte Diskussion mit MINDESTENS 2 Runden.\n` +
        `In Runde 1 gibt jede Persona ihre Einschätzung. In Runde 2 reagiert jede Persona auf die anderen, widerspricht oder baut darauf auf.\n` +
        `Formatiere JEDE Antwort GENAU so (mit eckigen Klammern):\n` +
        `**[Name]:** <Antwort der Persona>\n\n` +
        `Personas im Swarm:\n${unitLines}\n\n` +
        `Wichtig: Alle Personas müssen in JEDER Runde antworten. Zeige echte Meinungsverschiedenheiten und Debatte.`
      : '';

  return [
    `SWARM PHASE: ${getSwarmPhaseLabel(params.phase)}`,
    formatInstruction,
    phaseText,
    `AUFGABE: ${task}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
