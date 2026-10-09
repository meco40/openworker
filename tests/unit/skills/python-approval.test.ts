import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPythonCommand, pythonExecuteHandler } from '@/server/skills/handlers/pythonExecute';
import { multiToolUseParallelHandler } from '@/server/skills/handlers/multiToolUseParallel';

afterEach(() => vi.unstubAllEnvs());

describe('Python execution approval', () => {
  it('blocks direct and nested Python before execution when approval is required', async () => {
    vi.stubEnv('BETACLAW_EXEC_APPROVALS_REQUIRED', 'true');
    await expect(pythonExecuteHandler({ code: 'print("unapproved")' })).rejects.toThrow(
      'Command requires approval',
    );
    const batch = await multiToolUseParallelHandler({
      tool_uses: [{ name: 'python_execute', args: { code: 'print("unapproved-nested")' } }],
    });
    expect(batch.results[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining('Command requires approval'),
    });
  });

  it('keeps whitespace differences in Python code distinct for approval', () => {
    expect(buildPythonCommand('print("a b")')).not.toBe(buildPythonCommand('print("a  b")'));
  });
});
