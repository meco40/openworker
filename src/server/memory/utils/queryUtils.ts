import type { MemoryNode, MemoryType } from '@/core/memory/types';

export function matchesQuery(node: MemoryNode, query?: string): boolean {
  const needle = String(query || '')
    .trim()
    .toLowerCase();
  if (!needle) return true;
  return node.content.toLowerCase().includes(needle) || node.type.toLowerCase().includes(needle);
}

export function matchesType(node: MemoryNode, type?: MemoryType): boolean {
  if (!type) return true;
  return node.type === type;
}

export function isRulesLikeQuery(query: string): boolean {
  return /\b(regel|regeln|rule|rules|richtlinie|richtlinien|policy|policies|vorgabe|vorgaben)\b/i.test(
    String(query || '')
      .trim()
      .toLowerCase(),
  );
}

export function containsRulesWord(text: string): boolean {
  return /\b(regel|regeln|rule|rules|richtlinie|richtlinien|policy|policies|vorgabe|vorgaben)\b/i.test(
    String(text || '')
      .trim()
      .toLowerCase(),
  );
}
