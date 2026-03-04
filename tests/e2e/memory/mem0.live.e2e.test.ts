import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMem0Client } from '@/server/memory/mem0';
import { MemoryService } from '@/server/memory/service';

const liveEnabled = String(process.env.MEM0_E2E || '').trim() === '1';
const baseUrl = String(process.env.MEM0_BASE_URL || '').trim();
const apiKey = String(process.env.MEM0_API_KEY || '').trim();
const apiPath = String(process.env.MEM0_API_PATH || '/v1').trim() || '/v1';
const canRun = liveEnabled && Boolean(baseUrl) && Boolean(apiKey);

const randomSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const personaId = `mem0-e2e-persona-${randomSuffix}`;
const userId = `mem0-e2e-user-${randomSuffix}`;
const seedContent = `mem0-live-seed-${randomSuffix}`;
const updatedContent = `mem0-live-updated-${randomSuffix}`;

const service = canRun
  ? new MemoryService(
      createMem0Client({
        baseUrl,
        apiKey,
        apiPath,
        timeoutMs: 15000,
      }),
    )
  : null;

describe.runIf(canRun)('mem0 live e2e', () => {
  beforeAll(async () => {
    await service?.deleteByPersona(personaId, userId).catch(() => {});
  });

  afterAll(async () => {
    await service?.deleteByPersona(personaId, userId).catch(() => {});
  });

  it('covers store, recall, optimistic update, history restore and delete', async () => {
    const stored = await service!.store(personaId, 'fact', seedContent, 4, userId);
    expect(stored.id.length).toBeGreaterThan(0);
    expect(stored.metadata?.version).toBe(1);

    const recalled = await service!.recallDetailed(personaId, seedContent, 3, userId);
    expect(recalled.matches.length).toBeGreaterThan(0);
    expect(recalled.context).toContain(seedContent);

    const updated = await service!.update(
      personaId,
      stored.id,
      { content: updatedContent, expectedVersion: 1 },
      userId,
    );
    expect(updated).not.toBeNull();
    expect(updated?.content).toBe(updatedContent);
    expect(updated?.metadata?.version).toBe(2);

    await expect(
      service!.update(
        personaId,
        stored.id,
        { content: `${updatedContent}-stale`, expectedVersion: 1 },
        userId,
      ),
    ).rejects.toThrow(/version|conflict/i);

    const history = await service!.history(personaId, stored.id, userId);
    expect(history).not.toBeNull();
    expect((history?.entries.length || 0) >= 2).toBe(true);
    const createEntry =
      history?.entries.find((entry) => String(entry.content || '') === seedContent) || null;
    expect(createEntry).not.toBeNull();

    const restored = await service!.restoreFromHistory(
      personaId,
      stored.id,
      {
        restoreIndex: Number(createEntry?.index || 0),
        expectedVersion: 2,
      },
      userId,
    );
    expect(restored).not.toBeNull();
    expect(restored?.content).toBe(seedContent);
    expect(restored?.metadata?.version).toBe(3);

    const deleted = await service!.delete(personaId, stored.id, userId);
    expect(deleted).toBe(true);
  }, 45000);
});
