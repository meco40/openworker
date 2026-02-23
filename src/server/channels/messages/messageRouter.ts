// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Message Router Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// Deterministic prefix-based routing for /cron, /persona and shell shortcuts.
// Pure function, zero dependencies, zero token cost.

export interface RouteResult {
  target:
    | 'chat'
    | 'shell-command'
    | 'session-command'
    | 'automation-command'
    | 'persona-command'
    | 'project-command'
    | 'subagent-command'
    | 'approval-command';
  payload: string;
  command?: string;
}

const SESSION_COMMANDS = ['/new', '/reset'] as const;
const SHELL_COMMANDS = ['/shell', '/bash'] as const;
const SUBAGENT_COMMANDS = ['/subagents', '/kill', '/steer'] as const;
const APPROVAL_COMMANDS = ['/approve', '/deny'] as const;

/**
 * Routes an incoming message to chat, automation, persona or shell-command.
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

  // Check /persona commands
  if (lower === '/persona' || lower.startsWith('/persona ')) {
    const payload = trimmed.slice('/persona'.length).trim();
    return { target: 'persona-command', payload, command: '/persona' };
  }

  if (lower === '/cron' || lower.startsWith('/cron ')) {
    const payload = trimmed.slice('/cron'.length).trim();
    return { target: 'automation-command', payload, command: '/cron' };
  }

  if (lower === '/project' || lower.startsWith('/project ')) {
    const payload = trimmed.slice('/project'.length).trim();
    return { target: 'project-command', payload, command: '/project' };
  }

  for (const cmd of APPROVAL_COMMANDS) {
    if (lower === cmd || lower.startsWith(`${cmd} `)) {
      const payload = trimmed.slice(cmd.length).trim();
      return { target: 'approval-command', payload, command: cmd };
    }
  }

  for (const cmd of SHELL_COMMANDS) {
    if (lower === cmd || lower.startsWith(`${cmd} `)) {
      const payload = trimmed.slice(cmd.length).trim();
      return { target: 'shell-command', payload, command: cmd };
    }
  }

  for (const cmd of SUBAGENT_COMMANDS) {
    if (lower === cmd || lower.startsWith(`${cmd} `)) {
      const payload = trimmed.slice(cmd.length).trim();
      return { target: 'subagent-command', payload, command: cmd };
    }
  }

  if (trimmed.startsWith('!')) {
    const payload = trimmed.slice(1).trim();
    return { target: 'shell-command', payload, command: '!' };
  }

  // Default: normal chat
  return { target: 'chat', payload: trimmed };
}
