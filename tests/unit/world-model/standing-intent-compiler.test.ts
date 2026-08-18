import { describe, expect, it } from 'vitest';

import { compileStandingIntent } from '@/server/world-model/services/standingIntentCompiler';

describe('compileStandingIntent', () => {
  it('compiles a "Wenn X antwortet" intent', () => {
    const compiled = compileStandingIntent({
      userId: 'u',
      personaId: 'p',
      workspaceId: 'w',
      statement: 'Wenn Mike antwortet, erinnere mich an das Angebot',
    });
    expect(compiled.matchedTemplate).toBe('if_when_subject');
    expect(compiled.input.triggerTerms).toContain('mike');
    expect(compiled.input.deduplicationKey).toContain('compiled:');
    expect(compiled.input.maxFires).toBe(1);
  });

  it('returns none for a non-trigger statement', () => {
    const compiled = compileStandingIntent({
      userId: 'u',
      personaId: 'p',
      statement: 'Bitte erinnere mich morgen',
    });
    expect(compiled.matchedTemplate).toBe('none');
    expect(compiled.input.triggerTerms).toEqual([]);
  });

  it('produces a stable idempotency key for the same statement', () => {
    const a = compileStandingIntent({
      userId: 'u',
      personaId: 'p',
      statement: 'Wenn Mike antwortet!',
    });
    const b = compileStandingIntent({
      userId: 'u',
      personaId: 'p',
      statement: 'Wenn Mike antwortet!',
    });
    expect(a.input.deduplicationKey).toBe(b.input.deduplicationKey);
  });
});
