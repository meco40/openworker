// ─── Message Router ──────────────────────────────────────────
// Deterministic prefix-based routing for @worker / /worker commands.
// Pure function, zero dependencies, zero token cost.

export interface RouteResult {
  target: 'chat' | 'worker' | 'worker-command' | 'session-command';
  payload: string;
  command?: string;
}

const WORKER_PREFIXES = ['@worker ', '/worker '] as const;

const WORKER_COMMANDS = [
  '/worker-status',
  '/worker-cancel',
  '/worker-list',
  '/worker-retry',
  '/worker-resume',
  '/approve',
  '/deny',
  '/approve-always',
] as const;

const SESSION_COMMANDS = ['/new', '/reset'] as const;

/**
 * Routes an incoming message to either the chat agent or the worker system.
 *
 * - `@worker <objective>` or `/worker <objective>` → creates a worker task
 * - `/worker-status [id]`, `/worker-cancel <id>`, etc. → worker commands
 * - Everything else → normal chat agent
 *
 * Case-insensitive. Trims whitespace. Requires a space after the prefix.
 */
export function routeMessage(content: string): RouteResult {
  const trimmed = content.trim();
  const lower = trimmed.toLowerCase();

  // Check session commands first
  for (const cmd of SESSION_COMMANDS) {
    if (lower === cmd || lower.startsWith(`${cmd} `)) {
      const payload = trimmed.slice(cmd.length).trim();
      return { target: 'session-command', payload, command: cmd };
    }
  }

  // Check worker commands (more specific)
  for (const cmd of WORKER_COMMANDS) {
    if (lower === cmd || lower.startsWith(`${cmd} `)) {
      const payload = trimmed.slice(cmd.length).trim();
      return { target: 'worker-command', payload, command: cmd };
    }
  }

  // Check worker task prefixes (with or without payload)
  for (const prefix of WORKER_PREFIXES) {
    const prefixNoSpace = prefix.trimEnd();
    if (lower === prefixNoSpace || lower.startsWith(prefix)) {
      const payload = trimmed.slice(prefix.length).trim();
      return { target: 'worker', payload };
    }
  }

  // Default: normal chat
  return { target: 'chat', payload: trimmed };
}
