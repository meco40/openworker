export interface PromptDispatchDiagnostics {
  loggerActive: boolean;
  attemptsSinceBoot: number;
  writesSinceBoot: number;
  lastAttemptAt: string | null;
  lastInsertAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

const INITIAL_DIAGNOSTICS: PromptDispatchDiagnostics = {
  loggerActive: true,
  attemptsSinceBoot: 0,
  writesSinceBoot: 0,
  lastAttemptAt: null,
  lastInsertAt: null,
  lastError: null,
  lastErrorAt: null,
};

declare global {
  var __promptDispatchDiagnostics: PromptDispatchDiagnostics | undefined;
}

function getMutableDiagnostics(): PromptDispatchDiagnostics {
  if (!globalThis.__promptDispatchDiagnostics) {
    globalThis.__promptDispatchDiagnostics = { ...INITIAL_DIAGNOSTICS };
  }
  return globalThis.__promptDispatchDiagnostics;
}

export function markPromptDispatchAttempt(at: string = new Date().toISOString()): void {
  const diagnostics = getMutableDiagnostics();
  diagnostics.attemptsSinceBoot += 1;
  diagnostics.lastAttemptAt = at;
}

export function markPromptDispatchInsert(at: string): void {
  const diagnostics = getMutableDiagnostics();
  diagnostics.writesSinceBoot += 1;
  diagnostics.lastInsertAt = at;
}

export function markPromptDispatchError(error: unknown, at: string = new Date().toISOString()): void {
  const diagnostics = getMutableDiagnostics();
  diagnostics.lastErrorAt = at;
  diagnostics.lastError = error instanceof Error ? error.message : String(error);
}

export function getPromptDispatchDiagnostics(): PromptDispatchDiagnostics {
  const diagnostics = getMutableDiagnostics();
  return { ...diagnostics };
}

export function resetPromptDispatchDiagnostics(): void {
  globalThis.__promptDispatchDiagnostics = { ...INITIAL_DIAGNOSTICS };
}
