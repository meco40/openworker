import { describe, expect, it } from 'vitest';

import {
  buildClarificationPrompt,
  isAmbiguous,
  resolveClarificationChoice,
} from '@/server/world-model/services/clarificationService';

describe('clarificationService', () => {
  it('returns null when there is only one candidate', () => {
    const prompt = buildClarificationPrompt([{ id: 'a', label: 'A' }]);
    expect(prompt).toBeNull();
    expect(isAmbiguous(prompt)).toBe(false);
  });

  it('builds a prompt for multiple ambiguous targets', () => {
    const prompt = buildClarificationPrompt(
      [
        { id: 'a', label: 'Termin Kino' },
        { id: 'b', label: 'Termin Essen' },
      ],
      'Deine Antwort könnte sich...',
    );
    expect(prompt).not.toBeNull();
    expect(prompt?.candidates).toHaveLength(2);
    expect(isAmbiguous(prompt)).toBe(true);
  });

  it('resolves a valid choice', () => {
    const prompt = buildClarificationPrompt([
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ]);
    expect(prompt).not.toBeNull();
    const choice = resolveClarificationChoice(prompt!, 'b');
    expect(choice.id).toBe('b');
  });

  it('throws on an invalid choice', () => {
    const prompt = buildClarificationPrompt([
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ]);
    expect(() => resolveClarificationChoice(prompt!, 'c')).toThrow(/not among/);
  });
});
