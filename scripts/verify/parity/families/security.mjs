/**
 * `/api/security` parity (S1): `status` and `policy-explain`.
 *
 * The reference is `golden/security.json`, recorded from the TypeScript snapshot builders
 * before their removal; the Rust side goes over HTTP.
 * Volatile and environment-specific details (absolute db paths, `generatedAt`,
 * `revision`, `source`, message texts) are normalised to their structural shape
 * or dropped; the checks' ids/labels/statuses, the summary counts, the channel
 * diagnostics and the effective-policy flags must match.
 */
import { check, goldenReference, rustRequest } from '../harness.mjs';

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
  const ts = await goldenReference(name, 'typescript');
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
