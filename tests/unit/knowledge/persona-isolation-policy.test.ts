import { describe, it, expect } from 'vitest';
import {
  createPersonaIsolationPolicy,
  type PersonaMessage,
} from '../../../src/server/knowledge/personaIsolationPolicy';

function makeMessage(overrides: Partial<PersonaMessage> = {}): PersonaMessage {
  return {
    id: 'msg-1',
    content: 'Hello',
    personaAtMessage: 'persona-nata',
    ...overrides,
  };
}

describe('PersonaIsolationPolicy', () => {
  const policy = createPersonaIsolationPolicy();

  describe('checkPersonaSwitch', () => {
    it('detects switch when persona changes', () => {
      const result = policy.checkPersonaSwitch('persona-nextjs-dev', 'persona-nata');
      expect(result.switched).toBe(true);
      expect(result.requireNewConversation).toBe(true);
    });

    it('reports no switch when persona is same', () => {
      const result = policy.checkPersonaSwitch('persona-nata', 'persona-nata');
      expect(result.switched).toBe(false);
      expect(result.requireNewConversation).toBe(false);
    });

    it('reports no switch when lastMessagePersonaId is null', () => {
      const result = policy.checkPersonaSwitch('persona-nata', null);
      expect(result.switched).toBe(false);
      expect(result.requireNewConversation).toBe(false);
    });
  });

  describe('filterByPersona', () => {
    it('keeps only messages matching the persona', () => {
      const messages = [
        makeMessage({ id: '1', personaAtMessage: 'persona-nata' }),
        makeMessage({ id: '2', personaAtMessage: 'persona-nextjs-dev' }),
        makeMessage({ id: '3', personaAtMessage: 'persona-nata' }),
        makeMessage({ id: '4', personaAtMessage: 'persona-nextjs-dev' }),
        makeMessage({ id: '5', personaAtMessage: 'persona-nata' }),
      ];
      const filtered = policy.filterByPersona(messages, 'persona-nata');
      expect(filtered).toHaveLength(3);
      expect(filtered.map((m) => m.id)).toEqual(['1', '3', '5']);
    });

    it('includes messages without personaAtMessage', () => {
      const messages = [
        makeMessage({ id: '1', personaAtMessage: 'persona-nata' }),
        makeMessage({ id: '2', personaAtMessage: null }),
        makeMessage({ id: '3', personaAtMessage: undefined }),
      ];
      const filtered = policy.filterByPersona(messages, 'persona-nata');
      expect(filtered).toHaveLength(3);
    });

    it('returns empty array when no messages match', () => {
      const messages = [
        makeMessage({ id: '1', personaAtMessage: 'persona-builder' }),
        makeMessage({ id: '2', personaAtMessage: 'persona-builder' }),
      ];
      const filtered = policy.filterByPersona(messages, 'persona-nata');
      expect(filtered).toHaveLength(0);
    });

    it('handles empty input', () => {
      const filtered = policy.filterByPersona([], 'persona-nata');
      expect(filtered).toEqual([]);
    });
  });
});
