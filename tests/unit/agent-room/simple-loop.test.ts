import { describe, expect, it } from 'vitest';
import {
  chooseNextSpeakerPersonaId,
  computeNextPhaseAfterTurn,
  countStructuredTurns,
  countTurnsInCurrentPhase,
  getPhaseRounds,
  getSimpleSwarmMaxTurns,
  getTurnsRequiredForPhase,
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
    expect(chooseNextSpeakerPersonaId({ turnCount: 1, leadPersonaId: 'lead', units })).toBe(
      'spec-a',
    );
    expect(chooseNextSpeakerPersonaId({ turnCount: 2, leadPersonaId: 'lead', units })).toBe('lead');
    expect(chooseNextSpeakerPersonaId({ turnCount: 3, leadPersonaId: 'lead', units })).toBe(
      'spec-a',
    );
  });

  it('falls back to lead when no specialist exists', () => {
    const units = [{ personaId: 'lead', role: 'lead' }];
    expect(chooseNextSpeakerPersonaId({ turnCount: 8, leadPersonaId: 'lead', units })).toBe('lead');
  });

  it('parses vote tags and strips CHANGE_PHASE without acting on it', () => {
    const parsed = parseTurnDirectives({
      rawText: 'We are aligned. [VOTE:UP] [CHANGE_PHASE:ideation]',
      speakerPersonaId: 'lead',
      leadPersonaId: 'lead',
      currentPhase: 'analysis',
    });

    expect(parsed.cleanText).toBe('We are aligned.');
    expect(parsed.consensusDelta).toBe(8);
    // Phase transitions are server-controlled — CHANGE_PHASE is ignored
    expect(parsed.nextPhase).toBe('analysis');
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

  it('uses maxTurns safety cap only (not phase-based result check)', () => {
    // shouldCompleteSwarmAfterTurn no longer completes on 'result' — phase completion is automatic
    expect(shouldCompleteSwarmAfterTurn('result')).toBe(false);
    expect(shouldCompleteSwarmAfterTurn('analysis')).toBe(false);
    expect(shouldCompleteSwarmAfterTurnWithTurnCount('analysis', 7, 8)).toBe(false);
    expect(shouldCompleteSwarmAfterTurnWithTurnCount('analysis', 8, 8)).toBe(true);
  });

  describe('phase rounds configuration', () => {
    it('critique has 3 rounds, ideation 2 rounds, others have 1', () => {
      expect(getPhaseRounds('analysis')).toBe(1);
      expect(getPhaseRounds('ideation')).toBe(2);
      expect(getPhaseRounds('critique')).toBe(3);
      expect(getPhaseRounds('best_case')).toBe(1);
      expect(getPhaseRounds('result')).toBe(1);
    });

    it('calculates turns required as rounds × agents', () => {
      expect(getTurnsRequiredForPhase('analysis', 2)).toBe(2);
      expect(getTurnsRequiredForPhase('ideation', 2)).toBe(4);
      expect(getTurnsRequiredForPhase('critique', 2)).toBe(6);
      expect(getTurnsRequiredForPhase('critique', 3)).toBe(9);
      expect(getTurnsRequiredForPhase('result', 3)).toBe(3);
    });
  });

  describe('countTurnsInCurrentPhase', () => {
    it('counts turns after the last phase marker', () => {
      const artifact = [
        '--- Analysis ---',
        '',
        '**[A]:** first',
        '',
        '**[B]:** second',
        '',
        '--- Ideation ---',
        '',
        '**[A]:** third',
      ].join('\n');
      expect(countTurnsInCurrentPhase(artifact)).toBe(1);
    });

    it('counts all turns when no markers exist', () => {
      const artifact = '**[A]:** first\n\n**[B]:** second';
      expect(countTurnsInCurrentPhase(artifact)).toBe(2);
    });

    it('returns 0 for empty artifact', () => {
      expect(countTurnsInCurrentPhase('')).toBe(0);
    });
  });

  describe('computeNextPhaseAfterTurn', () => {
    it('stays in analysis when turns < required', () => {
      const artifact = '--- Analysis ---\n\n**[A]:** first';
      const result = computeNextPhaseAfterTurn({
        currentPhase: 'analysis',
        artifactAfterTurn: artifact,
        numAgents: 2,
      });
      expect(result.nextPhase).toBe('analysis');
      expect(result.phaseComplete).toBe(false);
      expect(result.swarmComplete).toBe(false);
    });

    it('advances from analysis to ideation when all agents spoke', () => {
      const artifact = '--- Analysis ---\n\n**[A]:** first\n\n**[B]:** second';
      const result = computeNextPhaseAfterTurn({
        currentPhase: 'analysis',
        artifactAfterTurn: artifact,
        numAgents: 2,
      });
      expect(result.nextPhase).toBe('ideation');
      expect(result.phaseComplete).toBe(true);
      expect(result.swarmComplete).toBe(false);
    });

    it('keeps critique going for 3 rounds', () => {
      // 2 agents × 3 rounds = 6 turns needed. After 4 turns (2 rounds), still in critique.
      const turns = Array.from(
        { length: 4 },
        (_, i) => `**[${i % 2 === 0 ? 'A' : 'B'}]:** round ${Math.floor(i / 2) + 1}`,
      ).join('\n\n');
      const artifact = `--- Critique ---\n\n${turns}`;
      const result = computeNextPhaseAfterTurn({
        currentPhase: 'critique',
        artifactAfterTurn: artifact,
        numAgents: 2,
      });
      expect(result.nextPhase).toBe('critique');
      expect(result.phaseComplete).toBe(false);
    });

    it('advances from critique to best_case after 3 full rounds', () => {
      const turns = Array.from(
        { length: 6 },
        (_, i) => `**[${i % 2 === 0 ? 'A' : 'B'}]:** round ${Math.floor(i / 2) + 1}`,
      ).join('\n\n');
      const artifact = `--- Critique ---\n\n${turns}`;
      const result = computeNextPhaseAfterTurn({
        currentPhase: 'critique',
        artifactAfterTurn: artifact,
        numAgents: 2,
      });
      expect(result.nextPhase).toBe('best_case');
      expect(result.phaseComplete).toBe(true);
    });

    it('completes swarm when result phase is done', () => {
      const artifact = '--- Result ---\n\n**[A]:** final\n\n**[B]:** agreed';
      const result = computeNextPhaseAfterTurn({
        currentPhase: 'result',
        artifactAfterTurn: artifact,
        numAgents: 2,
      });
      expect(result.swarmComplete).toBe(true);
      expect(result.phaseComplete).toBe(true);
    });
  });

  describe('getSimpleSwarmMaxTurns', () => {
    it('returns DEFAULT_SIMPLE_SWARM_MAX_TURNS (40) when no env var is set', () => {
      const prev1 = process.env.AGENT_ROOM_SIMPLE_MAX_TURNS;
      const prev2 = process.env.AGENT_ROOM_MAX_TURNS;
      delete process.env.AGENT_ROOM_SIMPLE_MAX_TURNS;
      delete process.env.AGENT_ROOM_MAX_TURNS;
      try {
        expect(getSimpleSwarmMaxTurns()).toBe(40);
      } finally {
        if (prev1 !== undefined) process.env.AGENT_ROOM_SIMPLE_MAX_TURNS = prev1;
        if (prev2 !== undefined) process.env.AGENT_ROOM_MAX_TURNS = prev2;
      }
    });

    it('respects AGENT_ROOM_SIMPLE_MAX_TURNS env var', () => {
      const prev = process.env.AGENT_ROOM_SIMPLE_MAX_TURNS;
      process.env.AGENT_ROOM_SIMPLE_MAX_TURNS = '20';
      try {
        expect(getSimpleSwarmMaxTurns()).toBe(20);
      } finally {
        if (prev !== undefined) process.env.AGENT_ROOM_SIMPLE_MAX_TURNS = prev;
        else delete process.env.AGENT_ROOM_SIMPLE_MAX_TURNS;
      }
    });

    it('clamps to minimum of 4', () => {
      const prev = process.env.AGENT_ROOM_SIMPLE_MAX_TURNS;
      process.env.AGENT_ROOM_SIMPLE_MAX_TURNS = '1';
      try {
        expect(getSimpleSwarmMaxTurns()).toBe(4);
      } finally {
        if (prev !== undefined) process.env.AGENT_ROOM_SIMPLE_MAX_TURNS = prev;
        else delete process.env.AGENT_ROOM_SIMPLE_MAX_TURNS;
      }
    });
  });
});
