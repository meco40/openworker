export type EmbeddingTargetType = 'assertion' | 'event' | 'task' | 'entity' | 'episode' | 'memory';

/**
 * Baut den Embedding-Text für ein Ziel. Versioniert über `projection_version`,
 * damit ein Modell-/Formatwechsel gezielt Re-Embedding auslösen kann.
 */
export function buildEmbeddingText(input: {
  targetType: EmbeddingTargetType;
  content: string[];
  projectionVersion?: string;
}): { text: string; textHash: string; projectionVersion: string } {
  const text = input.content
    .filter((part) => part && part.trim())
    .join(' ')
    .trim();
  const projectionVersion = input.projectionVersion ?? 'v1';
  return {
    text,
    textHash: hashText(text),
    projectionVersion,
  };
}

/**
 * Stabiler Text-Hash für idempotente Embedding-Verwaltung.
 */
export function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return (hash >>> 0).toString(36);
}
