import { describe, expect, it, vi } from 'vitest';

import { TimeoutError, executeAgentRunAction } from '@/server/automation/executor';

describe('automation executor', () => {
  it('executes the agent action and returns a summary', async () => {
    const runPrompt = vi.fn(async () => ({ summary: 'ok' }));

    const result = await executeAgentRunAction(
      {
        userId: 'user-a',
        prompt: 'Generate morning briefing',
        conversationId: 'conv-1',
      },
      { runPrompt },
    );

    expect(runPrompt).toHaveBeenCalledWith({
      userId: 'user-a',
      prompt: 'Generate morning briefing',
      conversationId: 'conv-1',
      signal: expect.any(AbortSignal),
    });
    expect(result.summary).toBe('ok');
  });

  it('fails with TimeoutError when action exceeds timeout', async () => {
    const runPrompt = vi.fn(
      async (): Promise<{ summary: string }> =>
        await new Promise((resolve) => setTimeout(() => resolve({ summary: 'late' }), 25)),
    );

    await expect(
      executeAgentRunAction(
        {
          userId: 'user-a',
          prompt: 'Long running',
          timeoutMs: 5,
        },
        { runPrompt },
      ),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it('aborts the underlying runPrompt signal on timeout', async () => {
    let observedSignal: AbortSignal | undefined;
    let sawAbort = false;
    const runPrompt = vi.fn(
      async (input: {
        userId: string;
        prompt: string;
        conversationId?: string | null;
        signal?: AbortSignal;
      }): Promise<{ summary: string }> => {
        observedSignal = input.signal;
        return await new Promise((_resolve, reject) => {
          input.signal?.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
            },
            { once: true },
          );
        });
      },
    );

    await expect(
      executeAgentRunAction(
        {
          userId: 'user-a',
          prompt: 'Long running',
          timeoutMs: 5,
        },
        { runPrompt },
      ),
    ).rejects.toBeInstanceOf(TimeoutError);

    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(sawAbort).toBe(true);
  });

  it('maps timeout-triggered abort errors to TimeoutError deterministically', async () => {
    const originalAbortController = globalThis.AbortController;

    class SyncAbortSignal extends EventTarget {
      aborted = false;
    }

    class SyncAbortController {
      signal = new SyncAbortSignal() as unknown as AbortSignal;

      abort(): void {
        (this.signal as unknown as SyncAbortSignal).aborted = true;
        (this.signal as unknown as SyncAbortSignal).dispatchEvent(new Event('abort'));
      }
    }

    globalThis.AbortController = SyncAbortController as unknown as typeof AbortController;

    try {
      const runPrompt = vi.fn(
        async (input: {
          userId: string;
          prompt: string;
          conversationId?: string | null;
          signal?: AbortSignal;
        }): Promise<{ summary: string }> =>
          await new Promise((_resolve, reject) => {
            input.signal?.addEventListener(
              'abort',
              () => {
                reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
              },
              { once: true },
            );
          }),
      );

      await expect(
        executeAgentRunAction(
          {
            userId: 'user-a',
            prompt: 'Long running',
            timeoutMs: 5,
          },
          { runPrompt },
        ),
      ).rejects.toBeInstanceOf(TimeoutError);
    } finally {
      globalThis.AbortController = originalAbortController;
    }
  });

  it('falls back to default timeout for non-finite timeout values', async () => {
    const runPrompt = vi.fn(
      async (): Promise<{ summary: string }> =>
        await new Promise((resolve) => setTimeout(() => resolve({ summary: 'ok' }), 10)),
    );

    await expect(
      executeAgentRunAction(
        {
          userId: 'user-a',
          prompt: 'Long running',
          timeoutMs: Number.NaN,
        },
        { runPrompt },
      ),
    ).resolves.toEqual({ summary: 'ok' });
  });
});
