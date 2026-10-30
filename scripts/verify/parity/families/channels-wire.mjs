/**
 * Channel wire routes parity: `channels/messages` (POST, DELETE),
 * `channels/messages/attachments`, `channels/pair`, `channels/telegram/**`,
 * `channels/whatsapp/**`, `channels/slack/webhook` and `webhooks/agent-completion`
 * (11 route files). `channels/state`, `conversations`, `inbox` and the `GET` of
 * `channels/messages` are covered by their own families.
 *
 * The TypeScript reference is the route handler itself. Each route module is
 * imported in-process and called with a `NextRequest`, so status and body come
 * from the real code and are not transcribed. The Rust side goes over HTTP.
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
 *
 * Module-level singletons of earlier families can keep stale store paths; run
 * this family alone with `--family=channels-wire` if a TS-side error names a path.
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { check, checkTrue, rustRequest } from '../harness.mjs';

export const name = 'channels-wire';

const APP_API = '../../../../app/api/';
const AUTH_LANE = process.env.REQUIRE_AUTH === 'true';

const STORE_ROOT = join(tmpdir(), `betaclaw-parity-routes-${process.pid}`);
const STORE_FILES = {
  DATABASE_PATH: 'mission-control.db',
  GATEWAY_CONFIG_DB_PATH: 'gateway-config.db',
  MESSAGES_DB_PATH: 'messages.db',
  MASTER_DB_PATH: 'master.db',
  AUTOMATION_DB_PATH: 'automation.db',
  SKILLS_DB_PATH: 'skills.db',
  STATS_DB_PATH: 'stats.db',
  PERSONAS_DB_PATH: 'personas.db',
  KNOWLEDGE_DB_PATH: 'knowledge.db',
  MEMORY_DB_PATH: 'memory.db',
  CLAWHUB_DB_PATH: 'clawhub.db',
  PROACTIVE_DB_PATH: 'proactive.db',
  MODEL_HUB_DB_PATH: 'model-hub.db',
  AUTH_DB_PATH: 'auth.db',
  SUBAGENT_RUNS_STORE_PATH: 'subagent-runs.json',
  PROJECTS_PATH: 'projects',
  WORKSPACE_BASE_PATH: 'workspaces',
  PERSONAS_ROOT_PATH: 'personas',
  CHAT_ATTACHMENTS_DIR: 'attachments',
  BETACLAW_SKILLS_DIR: 'skills',
  CLAWHUB_WORKDIR: 'clawhub',
};

const MISSING = 'parity-missing';

/** Route probes. Dynamic params are passed as a Promise, like Next does. */
const CASES = [
  // messages: POST fails validation on an empty body; DELETE needs a messageId
  {
    kind: 'guard',
    label: 'POST /api/channels/messages ohne Inhalt',
    route: 'channels/messages/route.ts',
    method: 'POST',
    path: '/api/channels/messages',
    body: {},
  },
  {
    kind: 'guard',
    label: 'DELETE /api/channels/messages ohne messageId',
    route: 'channels/messages/route.ts',
    method: 'DELETE',
    path: '/api/channels/messages',
  },
  {
    kind: 'read',
    label: 'GET /api/channels/messages/attachments ohne messageId',
    route: 'channels/messages/attachments/route.ts',
    method: 'GET',
    path: '/api/channels/messages/attachments',
  },

  // pair: validation before any pairing or unpairing
  {
    kind: 'guard',
    label: 'POST /api/channels/pair ohne channel',
    route: 'channels/pair/route.ts',
    method: 'POST',
    path: '/api/channels/pair',
    body: {},
  },
  {
    kind: 'guard',
    label: 'DELETE /api/channels/pair ohne channel',
    route: 'channels/pair/route.ts',
    method: 'DELETE',
    path: '/api/channels/pair',
    body: {},
  },

  // telegram
  {
    kind: 'secret',
    label: 'POST /api/channels/telegram/webhook ohne Secret',
    route: 'channels/telegram/webhook/route.ts',
    method: 'POST',
    path: '/api/channels/telegram/webhook',
    body: {},
  },
  {
    kind: 'secret',
    label: 'POST /api/channels/telegram/bots/[botId]/webhook (unbekannter Bot)',
    route: 'channels/telegram/bots/[botId]/webhook/route.ts',
    method: 'POST',
    path: `/api/channels/telegram/bots/${MISSING}/webhook`,
    params: { botId: MISSING },
    body: {},
  },
  {
    kind: 'guard',
    label: 'POST /api/channels/telegram/pairing/confirm ohne code',
    route: 'channels/telegram/pairing/confirm/route.ts',
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
    route: 'channels/whatsapp/accounts/route.ts',
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
    route: 'channels/whatsapp/webhook/route.ts',
    method: 'POST',
    path: '/api/channels/whatsapp/webhook',
    body: {},
  },

  // slack and agent-completion: signature or secret gates
  {
    kind: 'secret',
    label: 'POST /api/channels/slack/webhook ohne Secret',
    route: 'channels/slack/webhook/route.ts',
    method: 'POST',
    path: '/api/channels/slack/webhook',
    body: {},
  },
  {
    kind: 'secret',
    label: 'POST /api/webhooks/agent-completion ohne Signatur',
    route: 'webhooks/agent-completion/route.ts',
    method: 'POST',
    path: '/api/webhooks/agent-completion',
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/webhooks/agent-completion',
    route: 'webhooks/agent-completion/route.ts',
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

function isolateStores() {
  mkdirSync(STORE_ROOT, { recursive: true });
  for (const [key, file] of Object.entries(STORE_FILES)) {
    process.env[key] = join(STORE_ROOT, file);
  }
}

const routeModules = new Map();
function loadRoute(route) {
  if (!routeModules.has(route)) {
    routeModules.set(route, import(`${APP_API}${route}`));
  }
  return routeModules.get(route);
}

/** Reads a TS response. SSE bodies are never drained: headers are kept, the stream is cancelled. */
async function readTsResponse(response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    await response.body?.cancel();
    return { status: response.status, contentType, json: null, text: '' };
  }
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON body stays raw; the comparison then sees null on both sides
  }
  return { status: response.status, contentType, json, text };
}

/** Calls the real route handler in-process. */
async function tsCall(route, method, path, { params, body } = {}) {
  const mod = await loadRoute(route);
  const handler = mod[method];
  if (typeof handler !== 'function') {
    throw new Error(`${route} exportiert kein ${method}`);
  }
  const headers = {};
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const request = new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers,
    body: payload,
  });
  const response =
    params === undefined
      ? await handler(request)
      : await handler(request, { params: Promise.resolve(params) });
  return readTsResponse(response);
}

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
  const ts = await tsCall(c.route, c.method, c.path, { params: c.params, body: c.body });
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
  isolateStores();

  if (AUTH_LANE) {
    console.log('--- Auth-Lauf (REQUIRE_AUTH=true) ---');
    // Without a session, resolveUserIdFromSession answers null; withUserContext and the
    // manual checks turn that into 401 `{ ok: false, error: 'Unauthorized' }`.
    const { resolveUserIdFromSession } = await import('../../../../src/server/auth/userContext.ts');
    checkTrue(
      'TS-Referenz: ohne Session liefert die Auth-Auflösung null',
      resolveUserIdFromSession(null, true) === null,
    );
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
