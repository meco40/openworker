import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export async function shellExecuteHandler(args: Record<string, unknown>) {
  const command = String(args.command || '').trim();
  if (!command) throw new Error('shell_execute requires command.');

  const blocked =
    /(rm\s+-rf|del\s+\/f|shutdown|reboot|mkfs|format\s+[a-z]:|:\(\)\s*\{\s*:\|:&\s*\};:|dd\s+if=|cipher\s+\/w)/i;
  if (blocked.test(command)) {
    throw new Error('Command blocked by security policy.');
  }

  try {
    const { stdout, stderr } = await execFile('powershell', ['-NoProfile', '-Command', command], {
      cwd: process.cwd(),
      timeout: 15_000,
      maxBuffer: 1_000_000,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const typed = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      stdout: typed.stdout || '',
      stderr: typed.stderr || String(error),
      exitCode: typed.code ?? 1,
    };
  }
}
