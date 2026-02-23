import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { SkillDispatchContext } from '@/server/skills/types';
import { resolveSkillExecutionCwd } from '@/server/skills/handlers/executionCwd';

const execFile = promisify(execFileCallback);

export async function pythonExecuteHandler(
  args: Record<string, unknown>,
  context?: SkillDispatchContext,
) {
  const code = String(args.code || '').trim();
  if (!code) throw new Error('python_execute requires code.');

  try {
    const cwd = resolveSkillExecutionCwd(context);
    const { stdout, stderr } = await execFile('python', ['-c', code], {
      cwd,
      timeout: 20_000,
      maxBuffer: 1_000_000,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const typed = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const numericExitCode =
      typeof typed.code === 'number'
        ? typed.code
        : Number.isFinite(Number(typed.code))
          ? Number(typed.code)
          : 1;
    return {
      stdout: typed.stdout || '',
      stderr: typed.stderr || 'Python execution failed.',
      exitCode: numericExitCode,
    };
  }
}
