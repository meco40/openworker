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
});
