import type { MemoryNode } from '@/core/memory/types';
import { detectMemorySubject, isPersonaSelfReference } from '../subject/detector';

export function formatRecallContextLine(node: MemoryNode): string {
  const subject = detectMemorySubject(node);
  const base = `[Type: ${node.type}] ${node.content}`;

  // For assistant self-references, add special marker to help AI understand
  if (subject === 'assistant') {
    // Check if content already has self-reference markers
    const hasSelfRef = isPersonaSelfReference(node.content);
    if (hasSelfRef) {
      return `${base} [Subject: assistant, Self-Reference]`;
    }
    return `${base} [Subject: assistant]`;
  }
  if (subject === 'user') return `${base} [Subject: user]`;
  if (subject === 'conversation') return `${base} [Subject: conversation]`;
  return base;
}
