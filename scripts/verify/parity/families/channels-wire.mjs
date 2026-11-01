/**
 * Channel wire routes parity: `channels/messages` (POST, DELETE),
 * `channels/messages/attachments`, `channels/pair`, `channels/telegram/**`,
 * `channels/whatsapp/**`, `channels/slack/webhook` and `webhooks/agent-completion`
 * (11 route files). `channels/state`, `conversations`, `inbox` and the `GET` of
 * `channels/messages` are covered by their own families.
 *
 * The reference is `golden/channels-wire.json`, recorded from the TypeScript route handlers
 * before their removal. The Rust side goes over HTTP.
 *
 * Probe kinds:
 *   - read / guard: run in the default lane only (see below),
 *   - secret: webhook signature or secret gates. They answer before the body is
 *     processed and do not depend on user auth, so they run in both lanes. With
 *     no secret configured the default gate refuses the request
 *     (`ALLOW_INSECURE_WEBHOOKS` is not set).
 *   - skip: routes whose success path sends messages, calls the Telegram API or
 *     writes a bridge account; only their auth probe is kept.
 *
 * One accepted side effect: `POST /api/channels/messages` ensures the default
 * WebChat conversation before it validates the body. That is idempotent and the
 * same as the GET the `messages` family already exercises.
 *
 * Lanes: by default (`REQUIRE_AUTH` unset on the gateway and in this process)
 * the main probes run and the anonymous auth probes are reported as SKIP. With
 * `REQUIRE_AUTH=true` on both sides the auth probes and the secret probes run.
 */
import { check, checkTrue, goldenReference, rustRequest } from '../harness.mjs';

export const name = 'channels-wire';

const AUTH_LANE = process.env.REQUIRE_AUTH === 'true';
// Auth-lane reference values differ from the default lane (e.g. REQUIRE_AUTH gates first), so they get their own keys.
const caseKey = (label) => (AUTH_LANE ? `auth lane: ${label}` : label);

const MISSING = 'parity-missing';

/** Route probes. Dynamic params are passed as a Promise, like Next does. */
const CASES = [
  // messages: POST fails validation on an empty body; DELETE needs a messageId
  {
    kind: 'guard',
    label: 'POST /api/channels/messages ohne Inhalt',
    method: 'POST',
    path: '/api/channels/messages',
    body: {},
  },
  {
    kind: 'guard',
    label: 'DELETE /api/channels/messages ohne messageId',
    method: 'DELETE',
    path: '/api/channels/messages',
  },
  {
    kind: 'read',
    label: 'GET /api/channels/messages/attachments ohne messageId',
    method: 'GET',
    path: '/api/channels/messages/attachments',
  },

  // pair: validation before any pairing or unpairing
  {
    kind: 'guard',
    label: 'POST /api/channels/pair ohne channel',
    method: 'POST',
    path: '/api/channels/pair',
    body: {},
  },
  {
    kind: 'guard',
    label: 'DELETE /api/channels/pair ohne channel',
    method: 'DELETE',
    path: '/api/channels/pair',
    body: {},
  },

  // telegram
  {
    kind: 'secret',
    label: 'POST /api/channels/telegram/webhook ohne Secret',
    method: 'POST',
    path: '/api/channels/telegram/webhook',
    body: {},
  },
  {
    kind: 'secret',
    label: 'POST /api/channels/telegram/bots/[botId]/webhook (unbekannter Bot)',
    method: 'POST',
    path: `/api/channels/telegram/bots/${MISSING}/webhook`,
    params: { botId: MISSING },
    body: {},
  },
  {
    kind: 'guard',
    label: 'POST /api/channels/telegram/pairing/confirm ohne code',
    method: 'POST',
    path: '/api/channels/telegram/pairing/confirm',
    body: {},
  },
  {
    kind: 'skip',
    label: 'POST /api/channels/telegram/pairing/poll',
    reason: 'ruft die Telegram-API (getUpdates) auf; nur Auth-Probe',
  },

  // whatsapp
  {
    kind: 'read',
    label: 'GET /api/channels/whatsapp/accounts',
    method: 'GET',
    path: '/api/channels/whatsapp/accounts',
  },
  {
    kind: 'skip',
    label: 'PUT /api/channels/whatsapp/accounts',
    reason: 'legt einen Bridge-Account an (Mutation); nur Auth-Probe',
  },
  {
    kind: 'secret',
    label: 'POST /api/channels/whatsapp/webhook ohne Secret',
    method: 'POST',
    path: '/api/channels/whatsapp/webhook',
    body: {},
  },

  // slack and agent-completion: signature or secret gates
  {
    kind: 'secret',
    label: 'POST /api/channels/slack/webhook ohne Secret',
    method: 'POST',
    path: '/api/channels/slack/webhook',
    body: {},
  },
  {
    kind: 'secret',
    label: 'POST /api/webhooks/agent-completion ohne Signatur',
    method: 'POST',
    path: '/api/webhooks/agent-completion',
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/webhooks/agent-completion',
    method: 'GET',
    path: '/api/webhooks/agent-completion',
  },
];

/**
 * One anonymous request per route file. Checked only in the auth lane.
 * `gate` marks routes without a 401 gate: they are reported, not compared.
 */
const AUTH_CASES = [
  { label: 'channels/messages (POST)', method: 'POST', path: '/api/channels/messages' },
  {
    label: 'channels/messages/attachments',
    method: 'GET',
    path: '/api/channels/messages/attachments',
  },
  {
    label: 'channels/pair',
    gate: 'resolved',
    note: 'withResolvedUserContext: kein 401; Befund, siehe Bericht',
  },
  {
    label: 'channels/telegram/pairing/confirm',
    gate: 'resolved',
    note: 'withResolvedUserContext: kein 401; Befund, siehe Bericht',
  },
  {
    label: 'channels/telegram/pairing/poll',
    method: 'POST',
    path: '/api/channels/telegram/pairing/poll',
  },
  { label: 'channels/whatsapp/accounts', method: 'GET', path: '/api/channels/whatsapp/accounts' },
  {
    label: 'channels/telegram/webhook',
    gate: 'secret',
    note: 'Secret-Token über den Secret-Probe geprüft',
  },
  {
    label: 'channels/telegram/bots/[botId]/webhook',
    gate: 'secret',
    note: 'Secret-Token über den Secret-Probe geprüft',
  },
  {
    label: 'channels/whatsapp/webhook',
    gate: 'secret',
    note: 'Shared-Secret über den Secret-Probe geprüft',
  },
  {
    label: 'channels/slack/webhook',
    gate: 'secret',
    note: 'Shared-Secret über den Secret-Probe geprüft',
  },
  {
    label: 'webhooks/agent-completion',
    gate: 'secret',
    note: 'HMAC-Signatur über den Secret-Probe geprüft',
  },
];

/** Returns the paths where the two JSON values differ in keys or value types. */
function shapeMismatches(rust, ts, path = '$') {
  const rustKind = kindOf(rust);
  const tsKind = kindOf(ts);
  if (rustKind !== tsKind) {
    return [`${path}: ${rustKind} != ${tsKind}`];
  }
  if (rustKind === 'array') {
    // Lists are compared by element shape only when both sides have elements.
    if (rust.length === 0 || ts.length === 0) return [];
    return shapeMismatches(rust[0], ts[0], `${path}[]`);
  }
  if (rustKind === 'object') {
    const mismatches = [];
    for (const key of new Set([...Object.keys(rust), ...Object.keys(ts)])) {
      if (!(key in rust)) mismatches.push(`${path}.${key}: fehlt in Rust`);
      else if (!(key in ts)) mismatches.push(`${path}.${key}: fehlt in TS`);
      else mismatches.push(...shapeMismatches(rust[key], ts[key], `${path}.${key}`));
    }
    return mismatches;
  }
  return [];
}

function kindOf(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function compareJson(label, rust, ts) {
  check(`${label}: Status`, rust.status, ts.status);
  if (ts.status >= 400 && ts.status < 500) {
    check(`${label}: error`, rust.json?.error, ts.json?.error);
  }
  const mismatches = shapeMismatches(rust.json, ts.json);
  checkTrue(
    `${label}: Body-Form (Schlüssel und Typen)`,
    mismatches.length === 0,
    mismatches.join(' | '),
  );
}

async function runJsonCase(c) {
  const rust = await rustRequest(c.method, c.path, { body: c.body });
  const ts = await goldenReference(name, caseKey(c.label));
  compareJson(c.label, rust, ts);
}

async function runCase(c) {
  try {
    return await runJsonCase(c);
  } catch (error) {
    checkTrue(c.label, false, error instanceof Error ? error.message : String(error));
  }
}

async function runAuthCase(c) {
  try {
    const rust = await rustRequest(c.method, c.path);
    check(`${c.label} (anonym): Status`, rust.status, 401);
    checkTrue(
      `${c.label} (anonym): error = Unauthorized`,
      rust.json?.error === 'Unauthorized',
      JSON.stringify(rust.json ?? rust.text).slice(0, 200),
    );
  } catch (error) {
    checkTrue(`${c.label} (anonym)`, false, error instanceof Error ? error.message : String(error));
  }
}

export async function run() {
  if (AUTH_LANE) {
    console.log('--- Auth-Lauf (REQUIRE_AUTH=true) ---');
    // Without a session, resolveUserIdFromSession answers null; withUserContext and the
    // manual checks turn that into 401 `{ ok: false, error: 'Unauthorized' }`.
    const authNull = await goldenReference(name, 'resolveUserIdFromSession(null, true)');
    checkTrue('TS-Referenz: ohne Session liefert die Auth-Auflösung null', authNull === null);
    for (const c of AUTH_CASES) {
      if (c.gate) {
        console.log(`SKIP ${c.label} (anonym) — ${c.note}`);
        continue;
      }
      await runAuthCase(c);
    }
    // Secret gates are independent of REQUIRE_AUTH and run in this lane too.
    for (const c of CASES.filter((item) => item.kind === 'secret')) {
      await runCase(c);
    }
    return;
  }

  console.log('--- Standardlauf (REQUIRE_AUTH nicht gesetzt) ---');
  for (const c of CASES) {
    if (c.kind === 'skip') {
      console.log(`SKIP ${c.label} — ${c.reason}`);
      continue;
    }
    await runCase(c);
  }
  console.log(
    `SKIP Auth-Fall für ${AUTH_CASES.filter((c) => !c.gate).length} Routen — nur im Auth-Lauf (REQUIRE_AUTH=true auf Gateway und Harness)`,
  );
  for (const c of AUTH_CASES.filter((item) => item.gate)) {
    console.log(`SKIP ${c.label} (anonym) — ${c.note}`);
  }
}
