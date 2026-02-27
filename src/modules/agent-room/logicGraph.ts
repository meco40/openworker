import {
  SWARM_PHASES,
  getSwarmPhaseLabel,
  type SwarmPhase,
} from '@/modules/agent-room/swarmPhases';

const MERMAID_BLOCK_REGEX = /```mermaid\s*([\s\S]*?)```/gi;
const UNQUOTED_SQUARE_NODE_REGEX = /\b([A-Za-z][A-Za-z0-9_-]*)\[(?!")([^\]\n]+)\]/g;

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
    .replace(/<br\s*\/?>/gi, '\\n')
    .replace(/<[^>]+>/g, '');
  // Mermaid init directives can change rendering security defaults, strip them.
  const withoutInit = text.replace(/%%\{init:[\s\S]*?\}%%/gi, '').trim();
  return quoteUnsafeSquareNodeLabels(withoutInit);
}

function sanitizeNodeLabelText(label: string): string {
  return String(label || '')
    .replace(/<br\s*\/?>/gi, '\\n')
    .replace(/<[^>]+>/g, '')
    .replace(/"/g, "'")
    .replace(/\s*\\n\s*/g, '\\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function quoteUnsafeSquareNodeLabels(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('subgraph ')) {
        return line;
      }
      return line.replace(UNQUOTED_SQUARE_NODE_REGEX, (_match, nodeId: string, label: string) => {
        const safeLabel = sanitizeNodeLabelText(label);
        if (!safeLabel) {
          return `${nodeId}["Node"]`;
        }
        return `${nodeId}["${safeLabel}"]`;
      });
    })
    .join('\n')
    .trim();
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
 * Derive the first meaningful sentence (≤ maxLen chars) from a text block.
 * Used as a short label in the auto-generated flowchart.
 */
function firstSentence(text: string, maxLen = 60): string {
  const clean = stripMarkdown(text).replace(/\n/g, ' ');
  const sentence = clean.split(/[.!?]/)[0].trim();
  if (!sentence) return clean.slice(0, maxLen);
  return sentence.length > maxLen ? sentence.slice(0, maxLen - 1) + '…' : sentence;
}

/** Safe Mermaid node ID from agent name */
function nodeId(agentName: string, index: number): string {
  return `n${index}_${agentName.replace(/[^a-zA-Z0-9]/g, '')}`;
}

interface ArtifactSection {
  phase: SwarmPhase;
  turns: Array<{ agentName: string; content: string }>;
}

/**
 * Parse artifact into phase sections with agent turns.
 * Uses `--- Phase Label ---` markers and `**[Name]:**` turn markers.
 */
function parseArtifactSections(artifact: string): ArtifactSection[] {
  const text = String(artifact || '').trim();
  if (!text) return [];

  // Build label→phase lookup
  const labelToPhase = new Map<string, SwarmPhase>();
  for (const phase of SWARM_PHASES) {
    labelToPhase.set(getSwarmPhaseLabel(phase).toLowerCase(), phase);
  }

  // Find phase markers
  const markerPattern = /^---\s*(.+?)\s*---$/gm;
  const markers: Array<{ phase: SwarmPhase; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = markerPattern.exec(text))) {
    const label = m[1].trim().toLowerCase();
    const phase = labelToPhase.get(label) ?? 'analysis';
    markers.push({ phase, end: m.index + m[0].length });
  }

  // Extract sections between markers
  const sections: ArtifactSection[] = [];
  const turnPattern = /\*\*\[([^\]]+)\]:\*\*\s*([\s\S]*?)(?=\*\*\[[^\]]+\]:\*\*|$)/g;

  if (markers.length === 0) {
    // Legacy: treat entire artifact as analysis
    const turns: Array<{ agentName: string; content: string }> = [];
    let tm: RegExpExecArray | null;
    while ((tm = turnPattern.exec(text))) {
      turns.push({ agentName: tm[1].trim(), content: tm[2].trim() });
    }
    if (turns.length > 0) sections.push({ phase: 'analysis', turns });
    return sections;
  }

  for (let i = 0; i < markers.length; i++) {
    const sectionEnd =
      i + 1 < markers.length ? text.lastIndexOf('---', markers[i + 1].end) : text.length;
    const sectionText = text.slice(markers[i].end, sectionEnd).trim();
    const turns: Array<{ agentName: string; content: string }> = [];
    // Reset regex state
    turnPattern.lastIndex = 0;
    let tm: RegExpExecArray | null;
    while ((tm = turnPattern.exec(sectionText))) {
      turns.push({ agentName: tm[1].trim(), content: tm[2].trim() });
    }
    sections.push({ phase: markers[i].phase, turns });
  }
  return sections;
}

/**
 * Auto-generate a Mermaid TD (top-down) flowchart from the swarm artifact.
 *
 * Instead of showing phase names as a pipeline, this diagram shows the
 * actual discussion content: each agent's key contribution per phase,
 * grouped under phase subgraphs with connections showing the discussion flow.
 */
function buildAutoFlowchart(
  artifact: string,
  activePhases?: { phase: SwarmPhase; currentPhase: SwarmPhase; status: string },
): string | null {
  const sections = parseArtifactSections(artifact);
  if (sections.length === 0) return null;

  // If there's only 1 section with 1 turn and no real content, skip
  const totalTurns = sections.reduce((sum, s) => sum + s.turns.length, 0);
  if (totalTurns === 0) return null;

  const lines: string[] = ['flowchart TD'];
  let nodeCounter = 0;
  const phaseLastNodes: string[] = [];

  for (const section of sections) {
    const phaseLabel = getSwarmPhaseLabel(section.phase);
    const subgraphId = `sg_${section.phase}`;
    lines.push(`  subgraph ${subgraphId}["${phaseLabel}"]`);

    const sectionNodeIds: string[] = [];
    for (const turn of section.turns) {
      const nid = nodeId(turn.agentName, nodeCounter++);
      const summary = firstSentence(turn.content, 50);
      const escapedName = turn.agentName.replace(/"/g, "'");
      const escapedSummary = summary.replace(/"/g, "'");
      if (escapedSummary) {
        lines.push(`    ${nid}["**${escapedName}**<br/>${escapedSummary}"]`);
      } else {
        lines.push(`    ${nid}["**${escapedName}**"]`);
      }
      sectionNodeIds.push(nid);
    }

    // Connect turns within the same phase sequentially
    for (let i = 1; i < sectionNodeIds.length; i++) {
      lines.push(`    ${sectionNodeIds[i - 1]} --> ${sectionNodeIds[i]}`);
    }

    lines.push('  end');

    // Connect phases: last node of prev phase → first node of this phase
    if (phaseLastNodes.length > 0 && sectionNodeIds.length > 0) {
      const prevLast = phaseLastNodes[phaseLastNodes.length - 1];
      lines.push(`  ${prevLast} --> ${sectionNodeIds[0]}`);
    }

    if (sectionNodeIds.length > 0) {
      phaseLastNodes.push(sectionNodeIds[sectionNodeIds.length - 1]);
    }
  }

  // Show upcoming phases as empty nodes (if known from activePhases)
  if (activePhases && activePhases.status === 'running') {
    const currentIdx = SWARM_PHASES.indexOf(activePhases.currentPhase);
    const lastShownPhaseIdx =
      sections.length > 0 ? SWARM_PHASES.indexOf(sections[sections.length - 1].phase) : -1;
    for (let i = lastShownPhaseIdx + 1; i <= currentIdx; i++) {
      const upcomingPhase = SWARM_PHASES[i];
      if (upcomingPhase) {
        const nid = `upcoming_${upcomingPhase}`;
        const upcomingLabel = getSwarmPhaseLabel(upcomingPhase);
        lines.push(`  ${nid}(["⏳ ${upcomingLabel}"]):::upcoming`);
        if (phaseLastNodes.length > 0) {
          lines.push(`  ${phaseLastNodes[phaseLastNodes.length - 1]} -.-> ${nid}`);
          phaseLastNodes.push(nid);
        }
      }
    }
    lines.push(
      '  classDef upcoming fill:#1a1a2e,stroke:#4a4a6a,stroke-dasharray: 5 5,color:#6a6a8a',
    );
  }

  // Show ✅ Result terminal node when the swarm has completed
  if (
    activePhases &&
    (activePhases.status === 'completed' || activePhases.currentPhase === 'result')
  ) {
    const resultNid = 'result_done';
    lines.push(`  ${resultNid}(["✅ Result"]):::resultNode`);
    if (phaseLastNodes.length > 0) {
      lines.push(`  ${phaseLastNodes[phaseLastNodes.length - 1]} ==> ${resultNid}`);
    }
    lines.push('  classDef resultNode fill:#064e3b,stroke:#10b981,stroke-width:2px,color:#a7f3d0');
  }

  return lines.join('\n');
}

export function buildAutoLogicGraphSource(
  artifact: string,
  activePhases?: { phase: SwarmPhase; currentPhase: SwarmPhase; status: string },
): string | null {
  return buildAutoFlowchart(artifact, activePhases);
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
