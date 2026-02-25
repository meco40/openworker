import { describe, expect, it } from 'vitest';
import {
  chooseNextSpeakerPersonaId,
  countStructuredTurns,
  parseTurnDirectives,
  shouldCompleteSwarmAfterTurn,
  shouldCompleteSwarmAfterTurnWithTurnCount,
  stripLeadingSpeakerPrefix,
  stripTrailingOtherSpeakerTurns,
} from '@/server/agent-room/simpleLoop';
import type { SwarmPhase } from '@/modules/agent-room/swarmPhases';

describe('agent room simple loop', () => {
  it('alternates strictly between two selected personas', () => {
    const units = [
      { personaId: 'lead', role: 'lead' },
      { personaId: 'spec-a', role: 'specialist' },
    ];

    expect(chooseNextSpeakerPersonaId({ turnCount: 0, leadPersonaId: 'lead', units })).toBe('lead');
    expect(chooseNextSpeakerPersonaId({ turnCount: 1, leadPersonaId: 'lead', units })).toBe('spec-a');
    expect(chooseNextSpeakerPersonaId({ turnCount: 2, leadPersonaId: 'lead', units })).toBe('lead');
    expect(chooseNextSpeakerPersonaId({ turnCount: 3, leadPersonaId: 'lead', units })).toBe('spec-a');
  });

  it('falls back to lead when no specialist exists', () => {
    const units = [{ personaId: 'lead', role: 'lead' }];
    expect(chooseNextSpeakerPersonaId({ turnCount: 8, leadPersonaId: 'lead', units })).toBe('lead');
  });

  it('parses vote and phase tags for lead turns', () => {
    const parsed = parseTurnDirectives({
      rawText: 'We are aligned. [VOTE:UP] [CHANGE_PHASE:ideation]',
      speakerPersonaId: 'lead',
      leadPersonaId: 'lead',
      currentPhase: 'analysis',
    });

    expect(parsed.cleanText).toBe('We are aligned.');
    expect(parsed.consensusDelta).toBe(8);
    expect(parsed.nextPhase).toBe('ideation');
  });

  it('ignores phase-change tags from non-lead turns', () => {
    const parsed = parseTurnDirectives({
      rawText: 'Need more work. [VOTE:DOWN] [CHANGE_PHASE:result]',
      speakerPersonaId: 'spec-a',
      leadPersonaId: 'lead',
      currentPhase: 'analysis',
    });

    expect(parsed.cleanText).toBe('Need more work.');
    expect(parsed.consensusDelta).toBe(-12);
    expect(parsed.nextPhase).toBe('analysis' as SwarmPhase);
  });

  it('counts one structured turn even when the speaker prefix is duplicated in the same line', () => {
    const artifact = [
      '**[Next.js Dev]:** **[Next.js Dev]:** First answer',
      '',
      '**[Code Reviewer]:** Second answer',
    ].join('\n');

    expect(countStructuredTurns(artifact)).toBe(2);
  });

  it('strips a duplicated leading speaker prefix from model output', () => {
    expect(stripLeadingSpeakerPrefix('**[Next.js Dev]:** Final answer', 'Next.js Dev')).toBe(
      'Final answer',
    );
    expect(stripLeadingSpeakerPrefix('[Next.js Dev]: Final answer', 'Next.js Dev')).toBe(
      'Final answer',
    );
    expect(stripLeadingSpeakerPrefix('Final answer', 'Next.js Dev')).toBe('Final answer');
  });

  it('cuts trailing text that starts with another participant speaker marker', () => {
    const text =
      'Primary analysis from active speaker.\n\n**[Code Reviewer]:** A second speaker block should be removed.';
    expect(
      stripTrailingOtherSpeakerTurns(text, 'Next.js Dev', ['Next.js Dev', 'Code Reviewer']),
    ).toBe('Primary analysis from active speaker.');
  });

  it('completes the swarm once next phase is result', () => {
    expect(shouldCompleteSwarmAfterTurn('result')).toBe(true);
    expect(shouldCompleteSwarmAfterTurn('analysis')).toBe(false);
    expect(shouldCompleteSwarmAfterTurn('ideation')).toBe(false);
    expect(shouldCompleteSwarmAfterTurnWithTurnCount('analysis', 7, 8)).toBe(false);
    expect(shouldCompleteSwarmAfterTurnWithTurnCount('analysis', 8, 8)).toBe(true);
  });
});
