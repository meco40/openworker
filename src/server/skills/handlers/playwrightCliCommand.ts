const TOKEN_PATTERN = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g;

const ALLOWED_SUBCOMMANDS = new Set([
  'test',
  'show-report',
  'show-trace',
  'merge-reports',
  'clear-cache',
  'codegen',
  'open',
  'screenshot',
  'pdf',
  'install',
  'install-deps',
  'help',
]);

function stripWrappingQuotes(token: string): string {
  const trimmed = token.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function tokenizeCommand(command: string): string[] {
  const tokens = command.match(TOKEN_PATTERN) || [];
  return tokens.map(stripWrappingQuotes).filter(Boolean);
}

export function resolvePlaywrightCliTokens(args: Record<string, unknown>): string[] {
  const arrayArgs = Array.isArray(args.args) ? args.args : null;
  if (arrayArgs && arrayArgs.length > 0) {
    const tokens = arrayArgs
      .map((entry) => String(entry || '').trim())
      .filter((entry) => entry.length > 0);
    if (tokens.length > 0) return tokens;
  }

  const command = String(args.command || '').trim();
  if (!command) {
    return ['--help'];
  }

  const commandTokens = tokenizeCommand(command);
  return commandTokens.length > 0 ? commandTokens : ['--help'];
}

export function assertPlaywrightSubcommandAllowed(tokens: string[]): void {
  const first = String(tokens[0] || '--help').trim();
  if (!first || first.startsWith('-')) {
    return;
  }
  if (!ALLOWED_SUBCOMMANDS.has(first)) {
    const allowed = [...ALLOWED_SUBCOMMANDS].sort().join(', ');
    throw new Error(`Unsupported Playwright CLI subcommand "${first}". Allowed: ${allowed}.`);
  }
}

export function buildPlaywrightCliCommand(tokens: string[]): string {
  return `npx playwright ${tokens.join(' ')}`.trim();
}
