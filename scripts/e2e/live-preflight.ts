export interface LivePreflightResult {
  ok: boolean;
  enabled: boolean;
  missing: string[];
}

type EnvLike = Record<string, string | undefined>;

export function runLivePreflight(env: EnvLike = process.env as EnvLike): LivePreflightResult {
  const enabled = String(env.MEM0_E2E || '').trim() === '1';
  if (!enabled) {
    return { ok: true, enabled: false, missing: [] };
  }

  const required = ['MEM0_BASE_URL', 'MEM0_API_KEY'];
  const missing = required.filter((name) => !String(env[name] || '').trim());
  return {
    ok: missing.length === 0,
    enabled: true,
    missing,
  };
}

function main(): void {
  const result = runLivePreflight();

  if (!result.enabled) {
    console.log('[e2e-live] MEM0_E2E not enabled; skipping live preflight checks.');
    return;
  }

  if (!result.ok) {
    console.error(`[e2e-live] Missing env for live e2e: ${result.missing.join(', ')}`);
    process.exit(1);
  }

  console.log('[e2e-live] Preflight checks passed.');
}

if (
  String(process.argv[1] || '')
    .replace(/\\/g, '/')
    .endsWith('/live-preflight.ts')
) {
  main();
}
