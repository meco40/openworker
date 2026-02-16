import { describe, expect, it } from 'vitest';
import { isNoiseMemoryFact, sanitizeKnowledgeFacts } from '../../../src/server/knowledge/textQuality';

describe('knowledge text quality', () => {
  it('classifies command and greeting artifacts as noise', () => {
    expect(isNoiseMemoryFact('/new')).toBe(true);
    expect(isNoiseMemoryFact('Neue Konversation erstellt.')).toBe(true);
    expect(isNoiseMemoryFact('Hallo')).toBe(true);
  });

  it('keeps concrete statements and splits numbered rule lists', () => {
    expect(isNoiseMemoryFact('1. Niemals zu spät kommen.')).toBe(false);
    expect(
      sanitizeKnowledgeFacts([
        '/new',
        'Regeln: 1. Niemals zu spät kommen. 2. Bei Meetings bleibst du in meiner Nähe.',
        'Hallo',
      ]),
    ).toEqual(['1. Niemals zu spät kommen.', '2. Bei Meetings bleibst du in meiner Nähe.']);
  });
});

