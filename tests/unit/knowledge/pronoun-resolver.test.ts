import {
  resolvePronouns,
  type PronounContext,
} from '../../../src/server/knowledge/pronounResolver';

describe('pronounResolver', () => {
  const baseContext: PronounContext = {
    lastMentionedPerson: null,
    lastMentionedProject: null,
    speakerPersonaName: 'Nata',
    speakerUserId: 'user-1',
  };

  describe('resolvePronouns', () => {
    it('replaces masculine reference pronoun when lastMentionedPerson is known', () => {
      const ctx: PronounContext = { ...baseContext, lastMentionedPerson: 'Max' };
      expect(resolvePronouns('Er hat Pizza gebracht', ctx)).toBe('Max hat Pizza gebracht');
    });

    it('replaces "ihm" with lastMentionedPerson', () => {
      const ctx: PronounContext = { ...baseContext, lastMentionedPerson: 'Max' };
      expect(resolvePronouns('Ich habe ihm Bescheid gesagt', ctx)).toBe(
        'Ich habe Max Bescheid gesagt',
      );
    });

    it('replaces "sein" and "seinen" with lastMentionedPerson', () => {
      const ctx: PronounContext = { ...baseContext, lastMentionedPerson: 'Max' };
      expect(resolvePronouns('Sein Laptop ist kaputt', ctx)).toBe('Max Laptop ist kaputt');
      expect(resolvePronouns('Ich habe seinen Hund gesehen', ctx)).toBe(
        'Ich habe Max Hund gesehen',
      );
    });

    it('leaves perspective pronouns (ich/mein/du/dein) untouched', () => {
      const ctx: PronounContext = { ...baseContext, lastMentionedPerson: 'Max' };
      const input = 'Ich habe mit Max geschlafen';
      expect(resolvePronouns(input, ctx)).toBe(input);
    });

    it('leaves "du" and "dein" untouched', () => {
      const ctx: PronounContext = { ...baseContext, lastMentionedPerson: 'Max' };
      const input = 'Du hast dein Buch vergessen';
      expect(resolvePronouns(input, ctx)).toBe(input);
    });

    it('returns fact unchanged when lastMentionedPerson is null', () => {
      const input = 'Er hat Pizza gebracht';
      expect(resolvePronouns(input, baseContext)).toBe(input);
    });

    it('returns fact unchanged when no reference pronouns present', () => {
      const ctx: PronounContext = { ...baseContext, lastMentionedPerson: 'Max' };
      const input = 'Pizza ist lecker';
      expect(resolvePronouns(input, ctx)).toBe(input);
    });

    it('handles mixed pronouns — replaces reference but keeps perspective', () => {
      const ctx: PronounContext = { ...baseContext, lastMentionedPerson: 'Max' };
      const input = 'Ich habe ihm das Buch gegeben';
      expect(resolvePronouns(input, ctx)).toBe('Ich habe Max das Buch gegeben');
    });

    it('is case-insensitive for pronoun detection', () => {
      const ctx: PronounContext = { ...baseContext, lastMentionedPerson: 'Max' };
      expect(resolvePronouns('er hat Pizza gebracht', ctx)).toBe('Max hat Pizza gebracht');
      expect(resolvePronouns('ER hat Pizza gebracht', ctx)).toBe('Max hat Pizza gebracht');
    });
  });
});
