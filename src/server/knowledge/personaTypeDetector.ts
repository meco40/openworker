/**
 * Persona Type Detector — auto-detects persona archetype from SOUL.md / IDENTITY.md content.
 *
 * Archetypes:
 * - roleplay: Emotional, relationship-focused (e.g. "Nata")
 * - builder: Code/project-focused (e.g. "Next.js Dev")
 * - assistant: Task/planning-focused (e.g. personal assistant)
 * - general: No clear signals
 */

import type { PersonaType } from '@/server/personas/personaTypes';
export type { PersonaType };

const BUILDER_KEYWORDS = [
  'entwickl',
  'code',
  'programm',
  'next.js',
  'react',
  'typescript',
  'framework',
  'deploy',
  'api',
  'database',
  'prisma',
  'bug',
  'feature',
  'build',
  'test',
  'commit',
  'git',
  'docker',
  'app router',
];

const ROLEPLAY_KEYWORDS = [
  'gefuehl',
  'empathie',
  'freund',
  'liebe',
  'beziehung',
  'emotion',
  'rollenspi',
  'charakter',
  'persoenlichkeit',
  'locker',
  'warmherzig',
  'zuhoer',
  'humor',
  'erinner',
  'story',
  'erzaehl',
  'erlebnis',
];

const ASSISTANT_KEYWORDS = [
  'aufgabe',
  'termin',
  'deadline',
  'erinnerung',
  'kalender',
  'plan',
  'organis',
  'todo',
  'priorit',
  'zeitmanagement',
  'assistent',
  'hilfe',
  'alltag',
  'buero',
  'produktiv',
  'workflow',
];

const MIN_SCORE_THRESHOLD = 3;

function countMatches(text: string, keywords: string[]): number {
  let count = 0;
  for (const keyword of keywords) {
    if (text.includes(keyword)) {
      count++;
    }
  }
  return count;
}

/**
 * Detects persona type from SOUL.md / IDENTITY.md file contents.
 * Returns the archetype with the highest keyword match count,
 * or 'general' if no type reaches the minimum threshold.
 */
export function detectPersonaType(files: Record<string, string | undefined>): PersonaType {
  const allContent = Object.values(files)
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase();

  if (!allContent.trim()) return 'general';

  const builderScore = countMatches(allContent, BUILDER_KEYWORDS);
  const roleplayScore = countMatches(allContent, ROLEPLAY_KEYWORDS);
  const assistantScore = countMatches(allContent, ASSISTANT_KEYWORDS);

  const scores: [PersonaType, number][] = [
    ['builder', builderScore],
    ['roleplay', roleplayScore],
    ['assistant', assistantScore],
  ];

  scores.sort((a, b) => b[1] - a[1]);
  const best = scores[0];

  if (best[1] < MIN_SCORE_THRESHOLD) return 'general';

  return best[0];
}
