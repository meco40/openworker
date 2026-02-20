import { describe, it, expect } from 'vitest';
import { detectPersonaType } from '@/server/knowledge/personaTypeDetector';

describe('detectPersonaType', () => {
  it('detects builder from code/framework keywords', () => {
    const files = {
      'SOUL.md':
        'Du bist ein erfahrener Next.js Entwickler. Du hilfst beim Programmieren, Deployment, und Debugging von React-TypeScript-Apps. Du kennst Docker und API-Design.',
    };
    expect(detectPersonaType(files)).toBe('builder');
  });

  it('detects roleplay from emotional/relationship keywords', () => {
    const files = {
      'SOUL.md':
        'Du bist warmherzig und empathisch. Du hoerst zu, zeigst Gefuehle und baust eine enge Beziehung auf. Du bist eine Freundin mit Humor und Persoenlichkeit.',
    };
    expect(detectPersonaType(files)).toBe('roleplay');
  });

  it('detects assistant from task/planning keywords', () => {
    const files = {
      'SOUL.md':
        'Du bist ein persoenlicher Assistent. Du hilfst bei Aufgaben, Terminen und Zeitmanagement. Du organisierst den Alltag und erinnerst an Deadlines und Prioritaeten.',
    };
    expect(detectPersonaType(files)).toBe('assistant');
  });

  it('returns general for ambiguous content', () => {
    const files = {
      'SOUL.md': 'Hallo, ich bin eine Persona.',
    };
    expect(detectPersonaType(files)).toBe('general');
  });

  it('returns general for empty files', () => {
    expect(detectPersonaType({})).toBe('general');
  });

  it('combines signals from multiple files', () => {
    const files = {
      'SOUL.md': 'Du bist ein React-Entwickler.',
      'IDENTITY.md':
        'Du programmierst Next.js Apps und nutzt TypeScript. Du kennst Docker und Git.',
    };
    expect(detectPersonaType(files)).toBe('builder');
  });

  it('picks highest-scoring type when multiple signals present', () => {
    const files = {
      'SOUL.md':
        'Du bist warmherzig, empathisch, zeigst Gefuehle, hast Persoenlichkeit. Du magst Beziehungen, Humor und Erinnerungen. Du hoerst zu und erzaehlst Geschichten.',
      'IDENTITY.md': 'Du kennst etwas Code.',
    };
    // roleplay signals dominate
    expect(detectPersonaType(files)).toBe('roleplay');
  });
});
