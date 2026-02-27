import { getSwarmPhaseLabel, getPhaseRounds, type SwarmPhase } from '@/shared/domain/swarmPhases';
import type { TurnPromptParams } from '@/server/agent-room/types';

function buildPhaseGuidance(phase: SwarmPhase, round: number): string {
  switch (phase) {
    case 'analysis':
      return 'Identify key assumptions, risks, constraints, and open questions about the task.';
    case 'research':
      return 'Research factual evidence from external sources. Use web search to collect up-to-date references and cite concrete URLs.';
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

export function buildSimpleTurnPrompt(params: TurnPromptParams): string {
  const participants = params.units.map((unit) => `- ${unit.name} (${unit.role})`).join('\n');

  const phaseLabel = getSwarmPhaseLabel(
    params.phase as import('@/shared/domain/swarmPhases').SwarmPhase,
  );
  const roundInfo =
    params.phaseRound && params.phaseRoundsTotal && params.phaseRoundsTotal > 1
      ? ` (Round ${params.phaseRound} of ${params.phaseRoundsTotal})`
      : '';

  const phaseGuidance = buildPhaseGuidance(params.phase as SwarmPhase, params.phaseRound ?? 1);

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
    params.phase === 'research'
      ? '7) In this phase, actively use the "web_search" tool for internet research and include source URLs in your answer.'
      : '',
    params.phase === 'result'
      ? '8) Include a mermaid code block summarizing the final decision as a diagram.'
      : '8) If useful, include a mermaid code block for flow/architecture.',
  ];

  return lines.filter(Boolean).join('\n\n');
}

export { buildPhaseGuidance, getPhaseRounds };
