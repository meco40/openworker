/**
 * Tool Loop Detector — detects and breaks agentic polling/repetition loops.
 *
 * Operates on a sliding window of the last 30 tool calls per dispatch session.
 * Detection happens in two phases:
 *   1. Pre-call (argsHash only) — circuit breaker can abort before even calling the tool
 *   2. Post-call (argsHash + resultHash) — warning injected into the tool result message
 *
 * Warnings are injected as prefixes to the tool result content, so the model
 * sees them in its own context and self-corrects without external interruption.
 *
 * Poll backoff hints (5s → 10s → 30s → 60s) are embedded in warning messages
 * for shell/file polling patterns.
 */

const HISTORY_SIZE = 30;
const WARN_THRESHOLD = 10;
const CRITICAL_THRESHOLD = 20;
const CIRCUIT_BREAKER_THRESHOLD = 30;

const POLL_BACKOFF_MS = [5_000, 10_000, 30_000, 60_000];

// Tools that are commonly polled in loops (partial name match)
const POLL_TOOL_NAMES = ['shell_execute', 'file_read', 'web_fetch', 'http_request'];

export interface ToolCallEntry {
  toolName: string;
  argsHash: string;
  resultHash?: string;
  ts: number;
}

export interface LoopDetectorState {
  history: ToolCallEntry[];
  noProgressStreak: number;
}

export type LoopLevel = 'none' | 'warning' | 'critical';

export interface LoopDetectionResult {
  level: LoopLevel;
  message: string;
}

export function createLoopDetectorState(): LoopDetectorState {
  return { history: [], noProgressStreak: 0 };
}

/**
 * Build a hash key from tool name + args. Identical to the existing
 * buildToolSignature in aiDispatcher — uses JSON.stringify for determinism.
 */
export function buildArgsHash(toolName: string, args: unknown): string {
  let serialized = '{}';
  try {
    serialized = JSON.stringify(args || {});
  } catch {
    serialized = '[unserializable]';
  }
  return `${toolName}:${serialized}`;
}

/**
 * Build a result fingerprint from tool output.
 * Uses first 2000 chars of the (already-truncated) output for O(1) comparison.
 */
export function buildResultHash(output: string): string {
  return output.slice(0, 2000);
}

/**
 * Record a tool call BEFORE execution (pre-call phase).
 * Does NOT update noProgressStreak — that happens in recordOutcome.
 */
export function recordCall(state: LoopDetectorState, toolName: string, argsHash: string): void {
  state.history.push({ toolName, argsHash, ts: Date.now() });
  if (state.history.length > HISTORY_SIZE) {
    state.history = state.history.slice(-HISTORY_SIZE);
  }
}

/**
 * Record a tool result AFTER execution (post-call phase).
 * Back-fills the resultHash on the most recent matching entry, then
 * updates noProgressStreak based on whether the result differs from the
 * previous call with the same args.
 */
export function recordOutcome(
  state: LoopDetectorState,
  toolName: string,
  argsHash: string,
  resultHash: string,
): void {
  // Back-fill the most recent entry with matching toolName+argsHash
  for (let i = state.history.length - 1; i >= 0; i--) {
    const entry = state.history[i];
    if (entry && entry.toolName === toolName && entry.argsHash === argsHash && !entry.resultHash) {
      entry.resultHash = resultHash;
      break;
    }
  }

  // Find the previous call with same argsHash (second-to-last)
  let previousResultHash: string | undefined;
  let foundCurrent = false;
  for (let i = state.history.length - 1; i >= 0; i--) {
    const entry = state.history[i];
    if (!entry) continue;
    if (
      !foundCurrent &&
      entry.toolName === toolName &&
      entry.argsHash === argsHash &&
      entry.resultHash === resultHash
    ) {
      foundCurrent = true;
      continue;
    }
    if (
      foundCurrent &&
      entry.toolName === toolName &&
      entry.argsHash === argsHash &&
      entry.resultHash
    ) {
      previousResultHash = entry.resultHash;
      break;
    }
  }

  if (previousResultHash !== undefined) {
    if (previousResultHash === resultHash) {
      state.noProgressStreak += 1;
    } else {
      state.noProgressStreak = 0;
    }
  }
}

function getPollBackoffMs(streak: number): number {
  if (streak < WARN_THRESHOLD) return 0;
  const idx = Math.min(Math.floor((streak - WARN_THRESHOLD) / 5), POLL_BACKOFF_MS.length - 1);
  return POLL_BACKOFF_MS[idx] ?? 60_000;
}

function isPollTool(toolName: string): boolean {
  return POLL_TOOL_NAMES.some((n) => toolName.includes(n));
}

/**
 * Detect loops based on current state.
 * Called BEFORE (pre-check: only argsHash) and AFTER (post-check: argsHash + resultHash).
 * Should be called after recordOutcome for the most accurate results.
 */
export function detectLoop(
  state: LoopDetectorState,
  toolName: string,
  argsHash: string,
): LoopDetectionResult {
  const history = state.history;
  const totalCalls = history.length;

  // ── 1. Global circuit breaker ───────────────────────────────────────────
  if (state.noProgressStreak >= CIRCUIT_BREAKER_THRESHOLD) {
    return {
      level: 'critical',
      message:
        `⛔ AGENT STUCK [circuit breaker]: ${state.noProgressStreak} aufeinanderfolgende Tool-Calls ` +
        `ohne neues Ergebnis. Stoppe sofort. Erkläre was du versucht hast, warum es nicht ` +
        `funktioniert, und frage den User nach dem nächsten Schritt.`,
    };
  }

  // ── 2. Known poll / no-progress ────────────────────────────────────────
  if (isPollTool(toolName) && totalCalls >= WARN_THRESHOLD) {
    const recentWindow = history.slice(-WARN_THRESHOLD);
    const sameArgsCount = recentWindow.filter((e) => e.argsHash === argsHash).length;
    const allSameResult =
      sameArgsCount === recentWindow.length &&
      recentWindow.every(
        (e) => e.resultHash !== undefined && e.resultHash === recentWindow[0]?.resultHash,
      );

    if (allSameResult && sameArgsCount >= CRITICAL_THRESHOLD) {
      const backoffMs = getPollBackoffMs(state.noProgressStreak);
      return {
        level: 'critical',
        message:
          `⛔ POLL LOOP [critical]: Gleiches Tool "${toolName}" mit gleichem Ergebnis ` +
          `${sameArgsCount}+ mal aufgerufen. ` +
          (backoffMs > 0 ? `Warte mindestens ${backoffMs / 1000}s. ` : '') +
          `Versuche eine andere Strategie oder warte auf externen Trigger.`,
      };
    }

    if (allSameResult && sameArgsCount >= WARN_THRESHOLD) {
      const backoffMs = getPollBackoffMs(state.noProgressStreak);
      return {
        level: 'warning',
        message:
          `⚠️ POLL LOOP [warning]: "${toolName}" liefert ${sameArgsCount} mal das gleiche Ergebnis. ` +
          (backoffMs > 0 ? `Hint: Warte ${backoffMs / 1000}s vor dem nächsten Versuch. ` : '') +
          `Prüfe ob sich der Systemzustand wirklich ändert oder wähle andere Herangehensweise.`,
      };
    }
  }

  // ── 3. Ping-pong (alternating between 2 patterns, no progress) ─────────
  if (totalCalls >= WARN_THRESHOLD) {
    const recentWindow = history.slice(-WARN_THRESHOLD);
    const uniqueHashes = new Set(recentWindow.map((e) => e.argsHash));
    if (uniqueHashes.size === 2) {
      const allHaveResults = recentWindow.every((e) => e.resultHash !== undefined);
      if (allHaveResults) {
        const resultsMatch = recentWindow.every(
          (e) => e.resultHash === recentWindow[0]?.resultHash,
        );
        const level: LoopLevel =
          totalCalls >= CRITICAL_THRESHOLD && resultsMatch ? 'critical' : 'warning';
        return {
          level,
          message:
            `⚠️ PING-PONG LOOP [${level}]: Alterniere zwischen 2 Tool-Mustern ohne Fortschritt ` +
            `(${recentWindow.length} Calls). Wechsle die Strategie grundlegend.`,
        };
      }
    }
  }

  // ── 4. Generic repeat (non-poll tool, same args, high count) ───────────
  if (totalCalls >= WARN_THRESHOLD) {
    const sameArgsInWindow = history
      .slice(-WARN_THRESHOLD)
      .filter((e) => e.toolName === toolName && e.argsHash === argsHash).length;
    if (sameArgsInWindow >= WARN_THRESHOLD) {
      return {
        level: 'warning',
        message:
          `⚠️ TOOL REPEAT [warning]: "${toolName}" wurde ${sameArgsInWindow} mal mit gleichen ` +
          `Argumenten aufgerufen. Versuche andere Parameter oder eine völlig andere Methode.`,
      };
    }
  }

  return { level: 'none', message: '' };
}
