import { describe, expect, it } from 'vitest';
import {
  parseArtifactToStructured,
  renderStructuredToMarkdown,
  appendTurnToStructured,
  type StructuredArtifact,
  type ArtifactTurn,
} from '@/shared/domain/structuredArtifact';

describe('structuredArtifact', () => {
  describe('parseArtifactToStructured', () => {
    it('returns empty structure for null input', () => {
      const result = parseArtifactToStructured(null);
      expect(result.turns).toEqual([]);
      expect(result.phaseTransitions).toEqual([]);
    });

    it('returns empty structure for undefined input', () => {
      const result = parseArtifactToStructured([].at(0));
      expect(result.turns).toEqual([]);
      expect(result.phaseTransitions).toEqual([]);
    });

    it('returns empty structure for empty string', () => {
      const result = parseArtifactToStructured('');
      expect(result.turns).toEqual([]);
      expect(result.phaseTransitions).toEqual([]);
    });

    it('parses a single turn', () => {
      const artifact = '**[Alice]:** Hello, this is my analysis.';
      const result = parseArtifactToStructured(artifact);
      expect(result.turns).toHaveLength(1);
      expect(result.turns[0].speakerName).toBe('Alice');
      expect(result.turns[0].content).toBe('Hello, this is my analysis.');
      expect(result.turns[0].id).toBe('turn-0');
      expect(result.turns[0].phase).toBe('analysis');
    });

    it('parses multiple turns in one phase', () => {
      const artifact = ['**[Alice]:** First point.', '', '**[Bob]:** Second point.'].join('\n');
      const result = parseArtifactToStructured(artifact);
      expect(result.turns).toHaveLength(2);
      expect(result.turns[0].speakerName).toBe('Alice');
      expect(result.turns[0].content).toBe('First point.');
      expect(result.turns[1].speakerName).toBe('Bob');
      expect(result.turns[1].content).toBe('Second point.');
    });

    it('uses fallbackPhase when provided', () => {
      const artifact = '**[Alice]:** Some content.';
      const result = parseArtifactToStructured(artifact, 'critique');
      expect(result.turns[0].phase).toBe('critique');
    });

    it('parses phase transition markers and records transitions', () => {
      const artifact = [
        '**[Alice]:** Analysis done.',
        '',
        '--- Ideation ---',
        '',
        '**[Bob]:** Here is my idea.',
      ].join('\n');
      const result = parseArtifactToStructured(artifact);

      expect(result.turns).toHaveLength(2);
      expect(result.turns[0].phase).toBe('analysis');
      expect(result.turns[1].phase).toBe('ideation');

      expect(result.phaseTransitions).toHaveLength(1);
      expect(result.phaseTransitions[0].from).toBe('analysis');
      expect(result.phaseTransitions[0].to).toBe('ideation');
      expect(result.phaseTransitions[0].afterTurnId).toBe('turn-0');
    });

    it('handles multiple phase transitions', () => {
      const artifact = [
        '**[Alice]:** Analysis.',
        '',
        '--- Ideation ---',
        '',
        '**[Bob]:** Idea.',
        '',
        '--- Critique ---',
        '',
        '**[Carol]:** Critique.',
      ].join('\n');
      const result = parseArtifactToStructured(artifact);

      expect(result.turns).toHaveLength(3);
      expect(result.phaseTransitions).toHaveLength(2);
      expect(result.phaseTransitions[0].to).toBe('ideation');
      expect(result.phaseTransitions[1].to).toBe('critique');
    });

    it('handles multi-line turn content', () => {
      const artifact = ['**[Alice]:** Line one.', 'Line two continues.', 'Line three.'].join('\n');
      const result = parseArtifactToStructured(artifact);
      expect(result.turns).toHaveLength(1);
      expect(result.turns[0].content).toContain('Line one.');
      expect(result.turns[0].content).toContain('Line two continues.');
      expect(result.turns[0].content).toContain('Line three.');
    });

    it('maps known phase labels back to phase keys', () => {
      const artifact = [
        '**[Alice]:** Start.',
        '',
        '--- Best Case ---',
        '',
        '**[Bob]:** Optimal approach.',
      ].join('\n');
      const result = parseArtifactToStructured(artifact);
      expect(result.turns[1].phase).toBe('best_case');
    });
  });

  describe('renderStructuredToMarkdown', () => {
    it('returns empty string for empty structure', () => {
      const structured: StructuredArtifact = { turns: [], phaseTransitions: [] };
      expect(renderStructuredToMarkdown(structured)).toBe('');
    });

    it('renders a single turn', () => {
      const structured: StructuredArtifact = {
        turns: [
          {
            id: 'turn-0',
            phase: 'analysis',
            speakerPersonaId: 'p1',
            speakerName: 'Alice',
            content: 'Hello world.',
            timestamp: '2026-01-01T00:00:00Z',
          },
        ],
        phaseTransitions: [],
      };
      const md = renderStructuredToMarkdown(structured);
      expect(md).toBe('**[Alice]:** Hello world.');
    });

    it('renders phase transitions between turns', () => {
      const structured: StructuredArtifact = {
        turns: [
          {
            id: 'turn-0',
            phase: 'analysis',
            speakerPersonaId: 'p1',
            speakerName: 'Alice',
            content: 'Analysis.',
            timestamp: '2026-01-01T00:00:00Z',
          },
          {
            id: 'turn-1',
            phase: 'ideation',
            speakerPersonaId: 'p2',
            speakerName: 'Bob',
            content: 'Idea.',
            timestamp: '2026-01-01T00:01:00Z',
          },
        ],
        phaseTransitions: [{ from: 'analysis', to: 'ideation', afterTurnId: 'turn-0' }],
      };
      const md = renderStructuredToMarkdown(structured);
      expect(md).toContain('--- Ideation ---');
      expect(md).toContain('**[Alice]:** Analysis.');
      expect(md).toContain('**[Bob]:** Idea.');
    });
  });

  describe('appendTurnToStructured', () => {
    const baseTurn: Omit<ArtifactTurn, 'id'> = {
      phase: 'analysis',
      speakerPersonaId: 'p1',
      speakerName: 'Alice',
      content: 'New turn.',
      timestamp: '2026-01-01T00:00:00Z',
    };

    it('appends a turn to an empty structure', () => {
      const empty: StructuredArtifact = { turns: [], phaseTransitions: [] };
      const result = appendTurnToStructured(empty, baseTurn);
      expect(result.turns).toHaveLength(1);
      expect(result.turns[0].id).toBe('turn-0');
      expect(result.turns[0].speakerName).toBe('Alice');
    });

    it('appends a turn and auto-increments id', () => {
      const existing: StructuredArtifact = {
        turns: [{ ...baseTurn, id: 'turn-0' }],
        phaseTransitions: [],
      };
      const result = appendTurnToStructured(existing, {
        ...baseTurn,
        speakerName: 'Bob',
        speakerPersonaId: 'p2',
      });
      expect(result.turns).toHaveLength(2);
      expect(result.turns[1].id).toBe('turn-1');
    });

    it('records phase transition when phaseComplete and nextPhase differ', () => {
      const existing: StructuredArtifact = {
        turns: [{ ...baseTurn, id: 'turn-0' }],
        phaseTransitions: [],
      };
      const result = appendTurnToStructured(existing, baseTurn, true, 'ideation');
      expect(result.phaseTransitions).toHaveLength(1);
      expect(result.phaseTransitions[0].from).toBe('analysis');
      expect(result.phaseTransitions[0].to).toBe('ideation');
      expect(result.phaseTransitions[0].afterTurnId).toBe('turn-1');
    });

    it('does not record phase transition when not phase-complete', () => {
      const empty: StructuredArtifact = { turns: [], phaseTransitions: [] };
      const result = appendTurnToStructured(empty, baseTurn, false, 'ideation');
      expect(result.phaseTransitions).toHaveLength(0);
    });

    it('does not record phase transition when nextPhase equals current phase', () => {
      const empty: StructuredArtifact = { turns: [], phaseTransitions: [] };
      const result = appendTurnToStructured(empty, baseTurn, true, 'analysis');
      expect(result.phaseTransitions).toHaveLength(0);
    });
  });
});
