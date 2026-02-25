import {
  SWARM_PHASES,
  getSwarmPhaseLabel,
  type SwarmPhase,
} from '@/modules/agent-room/swarmPhases';

const MERMAID_BLOCK_REGEX = /```mermaid\s*([\s\S]*?)```/gi;

export function extractMermaidBlocks(text: string): string[] {
  const source = String(text || '');
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = MERMAID_BLOCK_REGEX.exec(source))) {
    const content = String(match[1] || '').trim();
    if (content) {
      blocks.push(content);
    }
  }
  return blocks;
}

export function sanitizeMermaidSource(source: string): string {
  const text = String(source || '')
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .trim();
  // Mermaid init directives can change rendering security defaults, strip them.
  return text.replace(/%%\{init:[\s\S]*?\}%%/gi, '').trim();
}

/**
 * Strip markdown formatting for use inside Mermaid node labels.
 * Removes bold/italic, code spans, bullets, heading prefixes, and brackets.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[[\](){}|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Derive the first meaningful sentence (≤ 55 chars) from a text block.
 * Used as a short label in the auto-generated flowchart.
 */
function firstSentence(text: string, maxLen = 55): string {
  const clean = stripMarkdown(text).replace(/\n/g, ' ');
  const sentence = clean.split(/[.!?]/)[0].trim();
  if (!sentence) return clean.slice(0, maxLen);
  return sentence.length > maxLen ? sentence.slice(0, maxLen - 1) + '…' : sentence;
}

/**
 * Auto-generate a Mermaid LR flowchart from the swarm artifact + phase rail.
 *
 * When `activePhases` is provided, use the phase rail to determine WHICH nodes
 * to render (at minimum all phases up to + including `currentPhase`). This
 * ensures the Logic Graph always shows the full phase progression even when the
 * artifact has been clamped or is missing the final phase.
 *
 * Artifact sections (split by ---) are used as label sources in order; when a
 * phase has no matching artifact section the phase label is used as the fallback.
 */
function buildAutoFlowchart(
  artifact: string,
  activePhases?: { phase: SwarmPhase; currentPhase: SwarmPhase; status: string },
): string | null {
  const raw = String(artifact || '').trim();

  // Determine which phases to show
  let phasesToShow: SwarmPhase[];
  if (activePhases) {
    const currentIdx = SWARM_PHASES.indexOf(activePhases.currentPhase);
    const endIdx =
      activePhases.status === 'completed'
        ? SWARM_PHASES.length - 1
        : currentIdx < 0
          ? 0
          : currentIdx;
    phasesToShow = SWARM_PHASES.slice(0, endIdx + 1);
  } else {
    // Fallback: derive from artifact sections
    if (!raw) return null;
    const sections = raw
      .split(/\n\n---\n\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    // A single plain text block is not enough signal for a logic graph.
    // Keep null behavior unless explicit phase metadata is available.
    if (sections.length <= 1) return null;
    phasesToShow = sections.map((_, i) => SWARM_PHASES[i]).filter(Boolean) as SwarmPhase[];
  }

  if (phasesToShow.length === 0) return null;

  // Build artifact-section lookup (by index, best effort)
  const artifactSections = raw
    ? raw
        .split(/\n\n---\n\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const lines: string[] = ['flowchart LR'];
  const nodeIds: string[] = [];

  phasesToShow.forEach((phase, i) => {
    const label = getSwarmPhaseLabel(phase);
    const section = artifactSections[i];
    const summary = section ? firstSentence(section) : '';
    // Escape double quotes inside label
    const escapedSummary = summary ? summary.replace(/"/g, "'") : '';
    const nodeContent = escapedSummary ? `"**${label}**\n${escapedSummary}"` : `"**${label}**"`;
    lines.push(`  ${phase}[${nodeContent}]`);
    nodeIds.push(phase);
  });

  for (let i = 1; i < nodeIds.length; i++) {
    lines.push(`  ${nodeIds[i - 1]} --> ${nodeIds[i]}`);
  }

  return lines.join('\n');
}

export function buildLogicGraphSource(
  artifact: string,
  activePhases?: { phase: SwarmPhase; currentPhase: SwarmPhase; status: string },
): string | null {
  // First try to extract an explicit Mermaid block from the LLM output.
  // Prefer the LAST block so the result-phase diagram (added at the end) wins
  // over any earlier incidental blocks.
  const blocks = extractMermaidBlocks(artifact);
  if (blocks.length > 0) {
    const sanitized = sanitizeMermaidSource(blocks[blocks.length - 1]);
    if (sanitized) return sanitized;
  }

  // Fallback: auto-generate from artifact phase sections + swarm phase rail
  return buildAutoFlowchart(artifact, activePhases);
}
