import { describe, expect, it, vi } from 'vitest';
import { multiToolUseParallelHandler } from '@/server/skills/handlers/multiToolUseParallel';

describe('multiToolUseParallelHandler', () => {
  it('runs supported tool calls in parallel and aggregates successful results', async () => {
    const result = await multiToolUseParallelHandler({
      tool_uses: [
        {
          recipient_name: 'functions.shell_execute',
          parameters: { command: 'echo multi-parallel' },
        },
        {
          name: 'file_read',
          args: { path: 'README.md' },
        },
      ],
    });

    const typed = result as {
      status: string;
      successCount: number;
      failureCount: number;
      results: Array<{ ok: boolean; name: string }>;
    };
    expect(typed.status).toBe('ok');
    expect(typed.successCount).toBe(2);
    expect(typed.failureCount).toBe(0);
    expect(typed.results.every((entry) => entry.ok)).toBe(true);
  });

  it('rejects nested parallel invocations', async () => {
    const result = await multiToolUseParallelHandler({
      tool_uses: [{ name: 'multi_tool_use.parallel', args: {} }],
    });

    const typed = result as {
      status: string;
      successCount: number;
      failureCount: number;
      results: Array<{ ok: boolean; error?: string }>;
    };
    expect(typed.status).toBe('error');
    expect(typed.successCount).toBe(0);
    expect(typed.failureCount).toBe(1);
    expect(String(typed.results[0]?.error || '')).toContain('Nested multi_tool_use.parallel');
  });

  it('requires a non-empty tool_uses array', async () => {
    await expect(multiToolUseParallelHandler({ tool_uses: [] })).rejects.toThrow(
      'multi_tool_use.parallel requires a non-empty tool_uses array.',
    );
  });

  it('forwards subagents calls using runtime context bridge', async () => {
    const invokeSubagentToolCall = vi.fn(async () => ({
      status: 'ok',
      text: 'Subagents',
    }));

    const result = await multiToolUseParallelHandler(
      {
        tool_uses: [{ name: 'subagents', args: { action: 'list' } }],
      },
      {
        conversationId: 'conv-1',
        userId: 'user-1',
        invokeSubagentToolCall,
      },
    );

    const typed = result as { successCount: number; failureCount: number };
    expect(typed.successCount).toBe(1);
    expect(typed.failureCount).toBe(0);
    expect(invokeSubagentToolCall).toHaveBeenCalledTimes(1);
  });
});
