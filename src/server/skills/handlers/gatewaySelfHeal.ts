/**
 * Gateway Self-Heal — let an agent request a controlled process restart.
 *
 * Useful when the agent detects corrupted state, hung connections, or memory growth
 * that can only be resolved by restarting the server process.
 *
 * ⚠️  OWNER-ONLY: The caller's userId must match OPENCLAW_OWNER_USER_ID or
 *     PRINCIPAL_USER_ID (env). All other callers receive an authorisation error.
 *
 * Actions:
 *   status   — return current process uptime, pid, memory stats
 *   restart  — schedule a graceful SIGTERM (triggers existing shutdown handler)
 *
 * The restart is deliberately delayed (default 2s) so the AI tool result can be
 * streamed back to the user before the process terminates.
 */

import type { SkillDispatchContext } from '@/server/skills/types';

const DEFAULT_RESTART_DELAY_MS = 2_000;
const MAX_RESTART_DELAY_MS = 30_000;
const PROCESS_START_TIME = Date.now();

function isOwnerUser(userId: string): boolean {
  const ownerEnv =
    (process.env['OPENCLAW_OWNER_USER_ID'] || '').trim() ||
    (process.env['PRINCIPAL_USER_ID'] || '').trim();
  if (!ownerEnv) {
    // No owner configured — deny by default to avoid accidental open access
    return false;
  }
  return userId === ownerEnv;
}

function getMemoryStats(): Record<string, string> {
  const m = process.memoryUsage();
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return {
    rss: mb(m.rss),
    heapUsed: mb(m.heapUsed),
    heapTotal: mb(m.heapTotal),
    external: mb(m.external),
  };
}

let restartScheduled = false;

export async function gatewaySelfHealHandler(
  args: Record<string, unknown>,
  context?: SkillDispatchContext,
): Promise<Record<string, unknown>> {
  const userId = (context?.userId || '').trim();
  if (!isOwnerUser(userId)) {
    return {
      ok: false,
      error:
        'Unauthorised: gateway_self_heal requires owner-level access. ' +
        'Set OPENCLAW_OWNER_USER_ID or PRINCIPAL_USER_ID env variable.',
    };
  }

  const action = String(args['action'] || 'status')
    .trim()
    .toLowerCase();

  // ── status ──────────────────────────────────────────────────
  if (action === 'status') {
    const uptimeSec = Math.floor((Date.now() - PROCESS_START_TIME) / 1000);
    return {
      ok: true,
      pid: process.pid,
      platform: process.platform,
      nodeVersion: process.version,
      uptimeSeconds: uptimeSec,
      memory: getMemoryStats(),
      restartScheduled,
    };
  }

  // ── restart ─────────────────────────────────────────────────
  if (action === 'restart') {
    if (restartScheduled) {
      return { ok: true, message: 'Restart already scheduled.' };
    }

    const reason = String(args['reason'] || 'agent-requested self-heal').trim();
    const delayRaw = Number(args['delay_ms'] ?? DEFAULT_RESTART_DELAY_MS);
    const delayMs = Math.max(
      DEFAULT_RESTART_DELAY_MS,
      Math.min(
        MAX_RESTART_DELAY_MS,
        Number.isFinite(delayRaw) ? delayRaw : DEFAULT_RESTART_DELAY_MS,
      ),
    );
    const force = Boolean(args['force']);

    restartScheduled = true;
    console.log(`[gateway-self-heal] Restart scheduled in ${delayMs}ms. Reason: ${reason}`);

    setTimeout(() => {
      console.log(
        `[gateway-self-heal] Sending ${force ? 'SIGKILL' : 'SIGTERM'} (pid=${process.pid}). Reason: ${reason}`,
      );
      process.kill(process.pid, force ? 'SIGKILL' : 'SIGTERM');
    }, delayMs).unref();

    return {
      ok: true,
      message: `Gateway restart scheduled in ${delayMs}ms (${force ? 'forced kill' : 'graceful SIGTERM'}). Reason: ${reason}`,
      pid: process.pid,
      delayMs,
    };
  }

  return {
    ok: false,
    error: `Unknown action "${action}". Valid actions: status, restart.`,
  };
}
