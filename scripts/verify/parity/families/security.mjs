/**
 * `/api/security` parity (S1): `status` and `policy-explain`.
 *
 * The TypeScript side calls the same snapshot builders the routes delegate to,
 * in-process against a temporary config database; the Rust side goes over HTTP.
 * Volatile and environment-specific details (absolute db paths, `generatedAt`,
 * `revision`, `source`, message texts) are normalised to their structural shape
 * or dropped; the checks' ids/labels/statuses, the summary counts, the channel
 * diagnostics and the effective-policy flags must match.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, rustRequest, bestEffortRemoveDir } from '../harness.mjs';

export const name = 'security';

function normCheck(check) {
  return { id: check.id, label: check.label, status: check.status };
}

function normChannel(channel) {
  return {
    channel: channel.channel,
    verification: channel.verification,
    secretConfigured: channel.secretConfigured,
    status: channel.status,
  };
}

async function typescriptSide() {
  const dir = mkdtempSync(join(tmpdir(), 'betaclaw-parity-security-'));
  process.env.GATEWAY_CONFIG_DB_PATH = join(dir, 'gateway-config.db');
  process.env.BETACLAW_CONFIG_BACKEND = 'db';
  process.env.MESSAGES_DB_PATH = join(dir, 'messages.db');

  const { buildSecurityStatusSnapshot } = await import('../../../../src/server/security/status.ts');
  const { buildEffectivePolicyExplainSnapshot } =
    await import('../../../../src/server/security/policyExplain.ts');

  const status = buildSecurityStatusSnapshot({ dbExists: true, secureCrypto: true });
  const policy = await buildEffectivePolicyExplainSnapshot();

  const result = {
    status: {
      ok: true,
      checks: status.checks.map(normCheck),
      summary: status.summary,
      channels: status.channels.map(normChannel),
      hasGeneratedAt: typeof status.generatedAt === 'string',
    },
    policy: {
      ok: true,
      runtime: policy.runtime,
      channels: {
        webchatEnabled: policy.channels.webchatEnabled,
        telegramEnabled: policy.channels.telegramEnabled,
        slackEnabled: policy.channels.slackEnabled,
      },
      tools: {
        browserManaged: policy.tools.browserManaged,
        browserHeadless: policy.tools.browserHeadless,
        sandboxEnabled: policy.tools.sandboxEnabled,
        sandboxType: policy.tools.sandboxType,
      },
    },
  };
  bestEffortRemoveDir(dir);
  return result;
}

async function rustCollect() {
  const statusResponse = await rustRequest('GET', '/api/security/status');
  const policyResponse = await rustRequest('GET', '/api/security/policy-explain');
  const status = statusResponse.json ?? {};
  const policy = policyResponse.json ?? {};

  return {
    status: {
      ok: status.ok,
      checks: (status.checks ?? []).map(normCheck),
      summary: status.summary,
      channels: (status.channels ?? []).map(normChannel),
      hasGeneratedAt: typeof status.generatedAt === 'string',
    },
    policy: {
      ok: policy.ok,
      runtime: policy.runtime,
      channels: {
        webchatEnabled: policy.channels?.webchatEnabled,
        telegramEnabled: policy.channels?.telegramEnabled,
        slackEnabled: policy.channels?.slackEnabled,
      },
      tools: {
        browserManaged: policy.tools?.browserManaged,
        browserHeadless: policy.tools?.browserHeadless,
        sandboxEnabled: policy.tools?.sandboxEnabled,
        sandboxType: policy.tools?.sandboxType,
      },
    },
  };
}

export async function run() {
  const ts = await typescriptSide();
  const rust = await rustCollect();

  console.log('--- /api/security/status ---');
  check('ok', rust.status.ok, ts.status.ok);
  check('checks', rust.status.checks, ts.status.checks);
  check('summary', rust.status.summary, ts.status.summary);
  check('channels', rust.status.channels, ts.status.channels);
  check('generatedAt vorhanden', rust.status.hasGeneratedAt, ts.status.hasGeneratedAt);

  console.log('\n--- /api/security/policy-explain ---');
  check('ok', rust.policy.ok, ts.policy.ok);
  check('runtime', rust.policy.runtime, ts.policy.runtime);
  check('channels', rust.policy.channels, ts.policy.channels);
  check('tools', rust.policy.tools, ts.policy.tools);
}
