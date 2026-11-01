/**
 * `/api/master/**` parity (18 routes: approvals, events, gmail, metrics,
 * notes, reminders, runs, settings, subagents, voice-session).
 *
 * The reference is `golden/master.json`, recorded from the TypeScript route handlers
 * before their removal. The Rust side goes over HTTP.
 *
 * Only state-neutral probes run:
 *   - reads of empty lists and of missing ids,
 *   - requests that fail validation before any write (empty body, invalid
 *     fields), and
 *   - anonymous requests in the auth lane.
 * `voice-session` calls xAI and is only probed for auth. Success paths that
 * write data are not run here and are listed as SKIP.
 *
 * Lanes: by default (`REQUIRE_AUTH` unset on the gateway and in this process)
 * the main probes run and the anonymous auth probes are reported as SKIP. With
 * `REQUIRE_AUTH=true` on both sides only the auth probes run, because every
 * other probe is answered with 401 there.
 */
import { check, checkTrue, goldenReference, rustRequest } from '../harness.mjs';
import { execFileSync } from 'node:child_process';

export const name = 'master';

const AUTH_LANE = process.env.REQUIRE_AUTH === 'true';
// Auth-lane reference values differ from the default lane (e.g. REQUIRE_AUTH gates first), so they get their own keys.
const caseKey = (label) => (AUTH_LANE ? `auth lane: ${label}` : label);
const RUST_ORIGIN = process.env.GATEWAY_BASE_URL || 'http://127.0.0.1:3000';
const CONTAINER = process.env.GATEWAY_CONTAINER || 'betaclaw-gateway-ws';

const MISSING = 'parity-missing';

/** Routes whose TS handler is invoked in-process. Dynamic params as Promise, like Next. */
const CASES = [
  // approvals (feature flag on by default)
  {
    kind: 'read',
    label: 'GET /api/master/approvals',
    method: 'GET',
    path: '/api/master/approvals',
  },
  {
    kind: 'guard',
    label: 'POST /api/master/approvals/[id]/decision ohne decision',
    method: 'POST',
    path: `/api/master/approvals/${MISSING}/decision`,
    params: { id: MISSING },
    body: {},
  },

  // events: SSE stream while the operator-events flag is on (default)
  {
    kind: 'head',
    label: 'GET /api/master/events (SSE)',
    method: 'GET',
    path: '/api/master/events?workspaceId=default',
  },

  // gmail: validation fails before any connector call
  {
    kind: 'guard',
    label: 'POST /api/master/gmail ohne action',
    method: 'POST',
    path: '/api/master/gmail',
    body: {},
  },

  {
    kind: 'read',
    label: 'GET /api/master/metrics',
    method: 'GET',
    path: '/api/master/metrics',
  },

  // notes
  {
    kind: 'read',
    label: 'GET /api/master/notes',
    method: 'GET',
    path: '/api/master/notes',
  },
  {
    kind: 'guard',
    label: 'POST /api/master/notes ohne title/content',
    method: 'POST',
    path: '/api/master/notes',
    body: {},
  },
  {
    kind: 'guard',
    label: 'PATCH /api/master/notes ohne noteId',
    method: 'PATCH',
    path: '/api/master/notes',
    body: {},
  },
  {
    kind: 'guard',
    label: 'DELETE /api/master/notes ohne noteId',
    method: 'DELETE',
    path: '/api/master/notes',
    body: {},
  },

  // reminders
  {
    kind: 'read',
    label: 'GET /api/master/reminders',
    method: 'GET',
    path: '/api/master/reminders',
  },
  {
    kind: 'guard',
    label: 'POST /api/master/reminders ohne Pflichtfelder',
    method: 'POST',
    path: '/api/master/reminders',
    body: {},
  },
  {
    kind: 'guard',
    label: 'PATCH /api/master/reminders ohne reminderId',
    method: 'PATCH',
    path: '/api/master/reminders',
    body: {},
  },
  {
    kind: 'guard',
    label: 'DELETE /api/master/reminders ohne reminderId',
    method: 'DELETE',
    path: '/api/master/reminders',
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/master/reminders/[id] (fehlend)',
    method: 'GET',
    path: `/api/master/reminders/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'PATCH /api/master/reminders/[id] (fehlend)',
    method: 'PATCH',
    path: `/api/master/reminders/${MISSING}`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'guard',
    label: 'DELETE /api/master/reminders/[id] (fehlend)',
    method: 'DELETE',
    path: `/api/master/reminders/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/master/reminders/[id]/fire (fehlend)',
    method: 'POST',
    path: `/api/master/reminders/${MISSING}/fire`,
    params: { id: MISSING },
    body: {},
  },

  // runs
  {
    kind: 'read',
    label: 'GET /api/master/runs',
    method: 'GET',
    path: '/api/master/runs',
  },
  {
    kind: 'guard',
    label: 'POST /api/master/runs ohne title/contract',
    method: 'POST',
    path: '/api/master/runs',
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/master/runs/[id] (fehlend)',
    method: 'GET',
    path: `/api/master/runs/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'PATCH /api/master/runs/[id] (fehlend)',
    method: 'PATCH',
    path: `/api/master/runs/${MISSING}`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'guard',
    label: 'POST /api/master/runs/[id]/actions ohne actionType',
    method: 'POST',
    path: `/api/master/runs/${MISSING}/actions`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/master/runs/[id]/delegations (fehlend)',
    method: 'GET',
    path: `/api/master/runs/${MISSING}/delegations`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/master/runs/[id]/delegations ohne capability',
    method: 'POST',
    path: `/api/master/runs/${MISSING}/delegations`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'guard',
    label: 'POST /api/master/runs/[id]/feedback ohne rating',
    method: 'POST',
    path: `/api/master/runs/${MISSING}/feedback`,
    params: { id: MISSING },
    body: {},
  },

  // settings: GET ensures the system persona (idempotent); PUT fails validation
  {
    kind: 'read',
    label: 'GET /api/master/settings',
    method: 'GET',
    path: '/api/master/settings',
  },
  {
    kind: 'guard',
    label: 'PUT /api/master/settings mit ungültigem maxToolCalls',
    method: 'PUT',
    path: '/api/master/settings',
    body: { maxToolCalls: 1 },
  },

  // subagents
  {
    kind: 'read',
    label: 'GET /api/master/subagents',
    method: 'GET',
    path: '/api/master/subagents',
  },
  {
    kind: 'read',
    label: 'GET /api/master/subagents/[id] (fehlend)',
    method: 'GET',
    path: `/api/master/subagents/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'PATCH /api/master/subagents/[id] ohne action',
    method: 'PATCH',
    path: `/api/master/subagents/${MISSING}`,
    params: { id: MISSING },
    body: {},
  },

  // voice-session: calls xAI on success, so only the auth probe runs (below)
  {
    kind: 'skip',
    label: 'GET /api/master/voice-session',
    reason: 'ruft xAI (Realtime-Token) auf; nur Auth-Probe',
  },
];

/** One anonymous request per route file. Checked only in the auth lane. */
const AUTH_CASES = [
  { label: 'master/approvals', method: 'GET', path: '/api/master/approvals' },
  {
    label: 'master/approvals/[id]/decision',
    method: 'POST',
    path: `/api/master/approvals/${MISSING}/decision`,
  },
  { label: 'master/events', method: 'GET', path: '/api/master/events' },
  { label: 'master/gmail', method: 'POST', path: '/api/master/gmail' },
  { label: 'master/metrics', method: 'GET', path: '/api/master/metrics' },
  { label: 'master/notes', method: 'GET', path: '/api/master/notes' },
  { label: 'master/reminders', method: 'GET', path: '/api/master/reminders' },
  { label: 'master/reminders/[id]', method: 'GET', path: `/api/master/reminders/${MISSING}` },
  {
    label: 'master/reminders/[id]/fire',
    method: 'POST',
    path: `/api/master/reminders/${MISSING}/fire`,
  },
  { label: 'master/runs', method: 'GET', path: '/api/master/runs' },
  { label: 'master/runs/[id]', method: 'GET', path: `/api/master/runs/${MISSING}` },
  {
    label: 'master/runs/[id]/actions',
    method: 'POST',
    path: `/api/master/runs/${MISSING}/actions`,
  },
  {
    label: 'master/runs/[id]/delegations',
    method: 'GET',
    path: `/api/master/runs/${MISSING}/delegations`,
  },
  {
    label: 'master/runs/[id]/feedback',
    method: 'POST',
    path: `/api/master/runs/${MISSING}/feedback`,
  },
  { label: 'master/settings', method: 'GET', path: '/api/master/settings' },
  { label: 'master/subagents', method: 'GET', path: '/api/master/subagents' },
  { label: 'master/subagents/[id]', method: 'GET', path: `/api/master/subagents/${MISSING}` },
  { label: 'master/voice-session', method: 'GET', path: '/api/master/voice-session' },
];

/** Status and content type of the Rust gateway for a streaming route, without draining the body. */
async function rustHead(path) {
  if (process.env.GATEWAY_BASE_URL) {
    const response = await fetch(`${RUST_ORIGIN}${path}`, { signal: AbortSignal.timeout(20000) });
    const contentType = response.headers.get('content-type') ?? '';
    await response.body?.cancel();
    return { status: response.status, contentType };
  }
  let output = '';
  try {
    output = execFileSync(
      'docker',
      [
        'exec',
        CONTAINER,
        'curl',
        '-s',
        '-m',
        '2',
        '-D',
        '-',
        '-o',
        '/dev/null',
        `${RUST_ORIGIN}${path}`,
      ],
      { encoding: 'utf8', timeout: 20000 },
    );
  } catch (error) {
    // curl exits 28 on the -m timeout; the dumped headers are still on stdout.
    output = String(error.stdout ?? '');
  }
  const status = Number(/^HTTP\/\S+\s+(\d{3})/m.exec(output)?.[1] ?? 0);
  const contentType = /^content-type:\s*(.*)$/im.exec(output)?.[1]?.trim() ?? '';
  return { status, contentType };
}

function mediaType(value) {
  return String(value ?? '')
    .split(';')[0]
    .trim();
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
  const ts = await goldenReference(name, caseKey(c.label));
  compareJson(c.label, rust, ts);
}

async function runHeadCase(c) {
  const rust = await rustHead(c.path);
  const ts = await goldenReference(name, caseKey(c.label));
  check(`${c.label}: Status`, rust.status, ts.status);
  check(`${c.label}: Content-Type`, mediaType(rust.contentType), mediaType(ts.contentType));
}

async function runCase(c) {
  try {
    if (c.kind === 'head') return await runHeadCase(c);
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
      await runAuthCase(c);
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
    `SKIP Auth-Fall für ${AUTH_CASES.length} Routen — nur im Auth-Lauf (REQUIRE_AUTH=true auf Gateway und Harness)`,
  );
}
