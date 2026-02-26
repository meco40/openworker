import { describe, expect, it } from 'vitest';
import { parseAgentTurns } from '@/modules/agent-room/agentTurnParser';
import {
  getSwarmPhaseLabel,
  SWARM_PHASES,
  type ResolvedSwarmUnit,
  type SwarmPhase,
} from '@/modules/agent-room/swarmPhases';

/**
 * Tests for the phase marker system in Agent Room artifacts.
 *
 * The orchestrator writes `--- Phase Label ---` markers into the artifact
 * when a swarm starts (first turn) and when phases change. The client's
 * hydrateFromArtifact() splits on these markers to correctly reconstruct
 * the chat feed with proper phase dividers.
 */

const UNITS: ResolvedSwarmUnit[] = [
  { personaId: 'lead-1', role: 'lead', name: 'Next.js Dev', emoji: '🧑‍💻' },
  { personaId: 'spec-1', role: 'Code Reviewer', name: 'Code Reviewer', emoji: '🔍' },
];

describe('artifact phase markers', () => {
  describe('phase marker format', () => {
    it('generates phase markers in the expected format', () => {
      for (const phase of SWARM_PHASES) {
        const label = getSwarmPhaseLabel(phase);
        const marker = `--- ${label} ---`;
        expect(marker).toMatch(/^--- .+ ---$/);
      }
    });

    it('all phase labels are unique', () => {
      const labels = SWARM_PHASES.map(getSwarmPhaseLabel);
      expect(new Set(labels).size).toBe(labels.length);
    });
  });

  describe('artifact with single phase', () => {
    it('parses turns from a single-phase artifact with marker', () => {
      const artifact = [
        '--- Analysis ---',
        '',
        '**[Next.js Dev]:** This is the first turn.',
        '',
        '**[Code Reviewer]:** This is the response.',
      ].join('\n');

      // Phase marker regex should find one marker
      const markerPattern = /^---\s*(.+?)\s*---$/gm;
      const markers: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = markerPattern.exec(artifact)) !== null) {
        markers.push(match[1].trim());
      }
      expect(markers).toEqual(['Analysis']);

      // Agent turns should parse correctly from the section after the marker
      const sectionAfterMarker = artifact
        .slice(artifact.indexOf('---') + '--- Analysis ---'.length)
        .trim();
      const turns = parseAgentTurns(sectionAfterMarker, UNITS, 'lead-1');
      expect(turns).toHaveLength(2);
      expect(turns[0].personaName).toBe('Next.js Dev');
      expect(turns[1].personaName).toBe('Code Reviewer');
    });
  });

  describe('artifact with multiple phases', () => {
    it('splits correctly on multiple phase markers', () => {
      const artifact = [
        '--- Analysis ---',
        '',
        '**[Next.js Dev]:** Analyze the problem.',
        '',
        '**[Code Reviewer]:** Looks like a state management issue.',
        '',
        '--- Ideation ---',
        '',
        '**[Next.js Dev]:** Proposal: use a context provider.',
        '',
        '**[Code Reviewer]:** Alternative: zustand store.',
      ].join('\n');

      const markerPattern = /^---\s*(.+?)\s*---$/gm;
      const markers: Array<{ label: string; index: number; end: number }> = [];
      let match: RegExpExecArray | null;
      while ((match = markerPattern.exec(artifact)) !== null) {
        markers.push({
          label: match[1].trim(),
          index: match.index,
          end: match.index + match[0].length,
        });
      }

      expect(markers).toHaveLength(2);
      expect(markers[0].label).toBe('Analysis');
      expect(markers[1].label).toBe('Ideation');

      // Parse section between first and second marker
      const section1 = artifact.slice(markers[0].end, markers[1].index).trim();
      const turns1 = parseAgentTurns(section1, UNITS, 'lead-1');
      expect(turns1).toHaveLength(2);
      expect(turns1[0].content).toContain('Analyze the problem');
      expect(turns1[1].content).toContain('state management issue');

      // Parse section after second marker
      const section2 = artifact.slice(markers[1].end).trim();
      const turns2 = parseAgentTurns(section2, UNITS, 'lead-1');
      expect(turns2).toHaveLength(2);
      expect(turns2[0].content).toContain('context provider');
      expect(turns2[1].content).toContain('zustand store');
    });
  });

  describe('phase label to phase mapping', () => {
    it('maps all phase labels back to their SwarmPhase key', () => {
      const labelToPhase = new Map<string, SwarmPhase>();
      for (const phase of SWARM_PHASES) {
        labelToPhase.set(getSwarmPhaseLabel(phase).toLowerCase(), phase);
      }

      expect(labelToPhase.get('analysis')).toBe('analysis');
      expect(labelToPhase.get('ideation')).toBe('ideation');
      expect(labelToPhase.get('critique')).toBe('critique');
      expect(labelToPhase.get('best case')).toBe('best_case');
      expect(labelToPhase.get('result')).toBe('result');
    });
  });

  describe('legacy artifact without markers', () => {
    it('treats the entire artifact as analysis when no markers are present', () => {
      const legacyArtifact = [
        '**[Next.js Dev]:** First turn analysis.',
        '',
        '**[Code Reviewer]:** Review of the analysis.',
      ].join('\n');

      // No markers present
      const markerPattern = /^---\s*(.+?)\s*---$/gm;
      expect(markerPattern.test(legacyArtifact)).toBe(false);

      // All turns should parse under the fallback phase
      const turns = parseAgentTurns(legacyArtifact, UNITS, 'lead-1');
      expect(turns).toHaveLength(2);
    });
  });

  describe('artifact construction simulation', () => {
    it('builds artifact correctly over multiple turns with phase transitions', () => {
      // Simulate what the orchestrator does
      let artifact = '';
      const currentPhase: SwarmPhase = 'analysis';

      // Turn 1: first turn, empty artifact
      const turn1Text = 'Initial analysis of the task.';
      const turn1Line = `**[Next.js Dev]:** ${turn1Text}`;
      // First turn — add phase marker
      artifact = `--- ${getSwarmPhaseLabel(currentPhase)} ---\n\n${turn1Line}`;

      expect(artifact).toBe('--- Analysis ---\n\n**[Next.js Dev]:** Initial analysis of the task.');

      // Turn 2: same phase, just append
      const turn2Text = 'I agree with the analysis. [VOTE:UP]';
      const turn2Line = `**[Code Reviewer]:** ${turn2Text}`;
      artifact = `${artifact}\n\n${turn2Line}`;

      // Phase complete (2 agents spoke 1 round) → insert NEXT phase marker at end
      const nextPhase: SwarmPhase = 'ideation';
      artifact = `${artifact}\n\n--- ${getSwarmPhaseLabel(nextPhase)} ---`;

      // Turn 3: first turn in new phase, just append
      const turn3Text = 'Proposal: use React Server Components.';
      const turn3Line = `**[Next.js Dev]:** ${turn3Text}`;
      artifact = `${artifact}\n\n${turn3Line}`;

      // Verify the full artifact
      const markerPattern = /^---\s*(.+?)\s*---$/gm;
      const markers: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = markerPattern.exec(artifact)) !== null) {
        markers.push(match[1].trim());
      }
      expect(markers).toEqual(['Analysis', 'Ideation']);

      // Verify all turns parse correctly
      const allTurns = parseAgentTurns(artifact, UNITS, 'lead-1');
      // parseAgentTurns processes the full text and ignores phase markers
      expect(allTurns.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('countStructuredTurns is not affected by phase markers', () => {
    it('does not count phase markers as turns', async () => {
      const { countStructuredTurns } = await import('@/server/agent-room/prompt');
      const artifact = [
        '--- Analysis ---',
        '',
        '**[Next.js Dev]:** First turn.',
        '',
        '**[Code Reviewer]:** Second turn.',
        '',
        '--- Ideation ---',
        '',
        '**[Next.js Dev]:** Third turn.',
      ].join('\n');

      expect(countStructuredTurns(artifact)).toBe(3);
    });
  });
});
