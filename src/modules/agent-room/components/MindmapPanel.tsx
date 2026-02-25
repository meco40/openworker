'use client';

/**
 * MindmapPanel — Pure SVG radial mindmap derived from the swarm artifact.
 *
 * No external libs. Each phase section (split by ---) becomes one branch node.
 * Phase names are used as clear headings; markdown is stripped from summaries.
 */

import React, { useMemo, useCallback, useState } from 'react';
import {
  SWARM_PHASES,
  getSwarmPhaseLabel,
  type SwarmPhase,
} from '@/modules/agent-room/swarmPhases';

interface MindmapPanelProps {
  artifact: string;
  swarmTitle: string;
}

interface MindmapNode {
  id: string;
  heading: string; // Phase name, e.g. "Analysis"
  summary: string; // First clean sentence from the section
  angle: number; // radians
  x: number;
  y: number;
}

/** Strip markdown bold, italic, code, bullets, headers, speaker labels */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*\[[^\]]+\]:\*\*\s*/g, '') // remove **[Name]:** speaker labels (colon inside bold)
    .replace(/\*\*\[[^\]]+\]\*\*:?\s*/g, '') // remove **[Name]**: or **[Name]** speaker labels
    .replace(/\[[^\]]+\]:\s*/g, '') // remove [Name]: speaker labels without bold
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/\*([^*]+)\*/g, '$1') // italic
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/^[-*+]\s+/gm, '') // bullets
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/[[\]{}|#]/g, '') // stray brackets
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract first meaningful sentence, capped at maxLen chars */
function firstSentence(text: string, maxLen = 50): string {
  const clean = stripMarkdown(text).replace(/\n+/g, ' ');
  const first = clean.split(/[.!?]/)[0].trim();
  const s = first || clean;
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

/** Word-wrap a string into lines of at most maxChars each */
function wrapLabel(label: string, maxChars = 20): string[] {
  const words = label.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
    if (lines.length >= 2) break; // max 2 lines for heading
  }
  if (current && lines.length < 2) lines.push(current);
  return lines;
}

const CX = 300;
const CY = 300;
const BRANCH_RADIUS = 195;
const NODE_W = 120;
const NODE_H = 58;
const CENTRE_R = 68;

export function MindmapPanel({ artifact, swarmTitle }: MindmapPanelProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const nodes: MindmapNode[] = useMemo(() => {
    if (!artifact.trim()) return [];

    // Split by phase dividers that the orchestrator inserts between phases
    const sections = artifact
      .split(/\n\n---\n\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    const count = Math.min(sections.length, SWARM_PHASES.length);
    if (count === 0) return [];

    return sections.slice(0, count).map((section, i) => {
      const phase = SWARM_PHASES[i] as SwarmPhase;
      const heading = getSwarmPhaseLabel(phase);
      const summary = firstSentence(section);
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
      return {
        id: `node-${i}`,
        heading,
        summary,
        angle,
        x: CX + BRANCH_RADIUS * Math.cos(angle),
        y: CY + BRANCH_RADIUS * Math.sin(angle),
      };
    });
  }, [artifact]);

  const titleLines = useMemo(() => wrapLabel(swarmTitle, 18), [swarmTitle]);

  const handleHover = useCallback((id: string | null) => setHoveredId(id), []);

  if (nodes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-(--muted) select-none">
        <span className="text-3xl">🗺️</span>
        <span className="text-sm">Mindmap appears once the swarm builds an artifact.</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <svg
        viewBox="0 0 600 600"
        className="h-full w-full flex-1"
        aria-label={`Mindmap for ${swarmTitle}`}
      >
        {/* Branch lines */}
        {nodes.map((node) => (
          <line
            key={`line-${node.id}`}
            x1={CX}
            y1={CY}
            x2={node.x}
            y2={node.y}
            stroke={hoveredId === node.id ? '#818cf8' : '#334155'}
            strokeWidth={hoveredId === node.id ? 2 : 1.5}
            strokeDasharray={hoveredId === node.id ? undefined : '5 4'}
            className="transition-all duration-200"
          />
        ))}

        {/* Branch nodes */}
        {nodes.map((node) => {
          const isHovered = hoveredId === node.id;
          const headingLines = wrapLabel(node.heading, 18);
          const summaryLines = wrapLabel(node.summary, 22);
          return (
            <g
              key={node.id}
              transform={`translate(${node.x - NODE_W / 2}, ${node.y - NODE_H / 2})`}
              onMouseEnter={() => handleHover(node.id)}
              onMouseLeave={() => handleHover(null)}
              className="cursor-pointer"
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={9}
                ry={9}
                fill={isHovered ? '#312e81' : '#0f172a'}
                stroke={isHovered ? '#818cf8' : '#1e293b'}
                strokeWidth={isHovered ? 1.5 : 1}
                className="transition-all duration-200"
              />
              {/* Heading (phase name) */}
              {headingLines.map((line, li) => (
                <text
                  key={`h-${li}`}
                  x={NODE_W / 2}
                  y={12 + li * 13}
                  textAnchor="middle"
                  dominantBaseline="hanging"
                  fontSize="10"
                  fontWeight="700"
                  fill={isHovered ? '#c7d2fe' : '#94a3b8'}
                  className="tracking-wide uppercase transition-colors duration-200 select-none"
                >
                  {line}
                </text>
              ))}
              {/* Divider */}
              <line
                x1={8}
                y1={headingLines.length * 13 + 14}
                x2={NODE_W - 8}
                y2={headingLines.length * 13 + 14}
                stroke={isHovered ? '#4f46e5' : '#1e293b'}
                strokeWidth={1}
              />
              {/* Summary text */}
              {summaryLines.map((line, li) => (
                <text
                  key={`s-${li}`}
                  x={NODE_W / 2}
                  y={headingLines.length * 13 + 20 + li * 13}
                  textAnchor="middle"
                  dominantBaseline="hanging"
                  fontSize="9"
                  fill={isHovered ? '#e0e7ff' : '#64748b'}
                  className="transition-colors duration-200 select-none"
                >
                  {line}
                </text>
              ))}
            </g>
          );
        })}

        {/* Centre circle */}
        <circle cx={CX} cy={CY} r={CENTRE_R} fill="#0f172a" stroke="#4f46e5" strokeWidth={2} />
        {titleLines.map((line, i) => (
          <text
            key={i}
            x={CX}
            y={CY - (titleLines.length - 1) * 10 + i * 20}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize="11"
            fontWeight="700"
            fill="#e2e8f0"
            className="select-none"
          >
            {line}
          </text>
        ))}
      </svg>
    </div>
  );
}
