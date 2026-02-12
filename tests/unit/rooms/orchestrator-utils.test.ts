import { describe, expect, it } from 'vitest';

import {
  selectNextSpeaker,
  stripSpeakerPrefix,
  buildGatewayHistoryMessages,
  type RoutableMember,
} from '../../../src/server/rooms/orchestratorUtils';

describe('orchestrator utils', () => {
  it('selects next speaker in round-robin order', () => {
    const valid: RoutableMember[] = [
      { personaId: 'a', model: 'm1', profileId: 'p1' },
      { personaId: 'b', model: 'm2', profileId: 'p1' },
      { personaId: 'c', model: 'm3', profileId: 'p1' },
    ];

    expect(selectNextSpeaker(valid, null)?.personaId).toBe('a');
    expect(selectNextSpeaker(valid, 'a')?.personaId).toBe('b');
    expect(selectNextSpeaker(valid, 'c')?.personaId).toBe('a');
  });

  it('strips prefixed speaker labels', () => {
    expect(stripSpeakerPrefix('[Alpha]: hello')).toBe('hello');
    expect(stripSpeakerPrefix('plain text')).toBe('plain text');
  });

  it('builds history messages with user and peer prefixes', () => {
    const result = buildGatewayHistoryMessages(
      [
        { speakerType: 'user', content: 'U', speakerPersonaId: null },
        { speakerType: 'persona', content: 'B says', speakerPersonaId: 'b' },
        { speakerType: 'persona', content: 'A says', speakerPersonaId: 'a' },
      ],
      'a',
      new Map([
        ['a', 'Alpha'],
        ['b', 'Beta'],
      ]),
    );

    expect(result[0]).toEqual({ role: 'user', content: '[User]: U' });
    expect(result[1]).toEqual({ role: 'user', content: '[Beta]: B says' });
    expect(result[2]).toEqual({ role: 'assistant', content: 'A says' });
  });
});
