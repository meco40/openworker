import type { MemoryNode } from '@/core/memory/types';
import type { MemorySubject } from '../types';

// Self-reference patterns that indicate the persona is talking about themselves
const PERSONA_SELF_PATTERNS = [
  /\bich\s+(habe|bin|war|hatte|kann|will|muss|soll|werde|wurde)\b/i, // ich habe, ich bin, etc.
  /\bmein\b/i, // mein
  /\bmeine\b/i, // meine
  /\bmeinem\b/i, // meinem
  /\bmeinen\b/i, // meinen
  /\bmeiner\b/i, // meiner
  /\bmeines\b/i, // meines
  /\bmir\b/i, // mir
  /\bmich\b/i, // mich
  /\bi\s+(am|have|had|was|will|can|must|should)\b/i, // I am, I have, etc.
  /\bmy\b/i, // my
  /\bmine\b/i, // mine
  /\bmyself\b/i, // myself
];

// Patterns that indicate the user is being referenced
const USER_REFERENCE_PATTERNS = [
  /\bdu\s+(hast|bist|warst|hattest|kannst|willst|musst|sollst|wirst)\b/i, // du hast, du bist, etc.
  /\bdein\b/i, // dein
  /\bdeine\b/i, // deine
  /\bdeinem\b/i, // deinem
  /\bdeinen\b/i, // deinen
  /\bdeiner\b/i, // deiner
  /\bdeines\b/i, // deines
  /\bdir\b/i, // dir
  /\bdich\b/i, // dich
  /\byou\s+(are|have|had|were|will|can|must|should)\b/i, // you are, you have, etc.
  /\byour\b/i, // your
  /\byours\b/i, // yours
];

/**
 * Detects if content represents a persona self-reference.
 * This is used both at storage time and retrieval time.
 */
export function isPersonaSelfReference(content: string): boolean {
  const normalized = content.toLowerCase().trim();
  return PERSONA_SELF_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Detects if content represents a user reference.
 */
export function isUserReference(content: string): boolean {
  const normalized = content.toLowerCase().trim();
  return USER_REFERENCE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function detectMemorySubject(node: MemoryNode): MemorySubject {
  // First check explicit metadata (set during ingestion)
  const explicitSubject = String(node.metadata?.subject || '')
    .trim()
    .toLowerCase();
  if (explicitSubject === 'user') return 'user';
  if (explicitSubject === 'assistant' || explicitSubject === 'persona') return 'assistant';
  if (explicitSubject === 'conversation') return 'conversation';

  // Check for self-reference marker from ingestion
  if (node.metadata?.selfReference === true) return 'assistant';

  const sourceRole = String(node.metadata?.sourceRole || '')
    .trim()
    .toLowerCase();
  if (sourceRole === 'user') return 'user';
  if (sourceRole === 'assistant' || sourceRole === 'agent' || sourceRole === 'persona') {
    return 'assistant';
  }

  // Analyze content for self-references
  const content = String(node.content || '').trim();

  // If content has persona self-reference patterns, it's about the assistant
  if (isPersonaSelfReference(content)) return 'assistant';

  // If content has user reference patterns, it's about the user
  if (isUserReference(content)) return 'user';

  // Legacy fallback: check starting patterns (less reliable)
  const lowered = content.toLowerCase();
  if (/^(ich|i)\b/.test(lowered)) return 'assistant'; // Changed: 'ich' from persona is about assistant
  if (/^(mein|meine|my)\b/.test(lowered)) return 'assistant';

  return null;
}
