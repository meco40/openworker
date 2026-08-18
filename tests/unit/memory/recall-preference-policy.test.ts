import { describe, expect, it, vi } from 'vitest';

import type { Mem0Client } from '@/server/memory/mem0';
import { MemoryService } from '@/server/memory/service';

function record(id: string, type: string, content: string, score: number | null = 0.95) {
  return {
    id,
    content,
    score,
    metadata: { type, lifecycleStatus: 'confirmed' },
  };
}

describe('Mem0 preference-only recall policy', () => {
  it('filters semantic results after fetching enough candidates', async () => {
    const searchMemories = vi.fn(async () => [
      record('fact-1', 'fact', 'Das Kino ist am Freitag.'),
      record('preference-1', 'preference', 'Ich mag kleine Kinos.'),
    ]);
    const client = { searchMemories } as unknown as Mem0Client;

    const result = await new MemoryService(client).recallDetailed(
      'persona-a',
      'Kino',
      1,
      'user-a',
      { memoryTypes: ['preference'] },
    );

    expect(result.matches.map((match) => match.node.id)).toEqual(['preference-1']);
    expect(searchMemories).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
  });

  it('uses Mem0 type filters for lexical fallback/list recall', async () => {
    const listMemories = vi.fn(async (input: { type?: string }) => ({
      memories:
        input.type === 'preference'
          ? [record('preference-1', 'preference', 'Ich mag kleine Kinos.', null)]
          : [record('fact-1', 'fact', 'Das Kino ist am Freitag.', null)],
      total: 1,
      page: 1,
      pageSize: 25,
    }));
    const client = { listMemories } as unknown as Mem0Client;

    const result = await new MemoryService(client).recallDetailed(
      'persona-a',
      'Kino',
      3,
      'user-a',
      { mode: 'lexical', memoryTypes: ['preference'] },
    );

    expect(result.matches.map((match) => match.node.id)).toEqual(['preference-1']);
    expect(listMemories).toHaveBeenCalledWith(expect.objectContaining({ type: 'preference' }));
  });
});
