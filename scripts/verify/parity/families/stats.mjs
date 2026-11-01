/**
 * `/api/stats/**`, `debug/**`, `knowledge/**` and `events/**` parity
 * (8 routes; the `events/stream` SSE route is checked separately).
 *
 * The reference is `golden/stats.json`, recorded from the TypeScript route handlers
 * before their removal. The Rust side goes over HTTP.
 *
 * Only state-neutral probes run:
 *   - reads of empty stores, missing ids and invalid filters, and
 *   - requests that fail validation before any write, and
 *   - anonymous requests in the auth lane.
 * `stats/prompt-logs` DELETE clears the prompt log and token usage and is only
 * probed for auth; its success path is not run here.
 *
 * Lanes: by default (`REQUIRE_AUTH` unset on the gateway and in this process)
 * the main probes run and the anonymous auth probes are reported as SKIP. With
 * `REQUIRE_AUTH=true` on both sides only the auth probes run, because every
 * other probe is answered with 401 there.
 */
import { check, checkTrue, goldenReference, rustRequest } from '../harness.mjs';

export const name = 'stats';

const AUTH_LANE = process.env.REQUIRE_AUTH === 'true';
// Auth-lane reference values differ from the default lane (e.g. REQUIRE_AUTH gates first), so they get their own keys.
const caseKey = (label) => (AUTH_LANE ? `auth lane: ${label}` : label);

const MISSING = 'parity-missing';

/** Route probes. Dynamic params are passed as a Promise, like Next does. */
const CASES = [
  // stats
  {
    kind: 'read',
    label: 'GET /api/stats',
    method: 'GET',
    path: '/api/stats',
  },
  {
    kind: 'read',
    label: 'GET /api/stats/engineering',
    method: 'GET',
    path: '/api/stats/engineering?windowDays=7',
  },
  {
    kind: 'guard',
    label: 'GET /api/stats/engineering (ungültiges windowDays)',
    method: 'GET',
    path: '/api/stats/engineering?windowDays=0',
  },
  {
    kind: 'read',
    label: 'GET /api/stats/prompt-logs',
    method: 'GET',
    path: '/api/stats/prompt-logs',
  },
  {
    kind: 'read',
    label: 'GET /api/stats/prompt-logs (preset, limit)',
    method: 'GET',
    path: '/api/stats/prompt-logs?preset=week&limit=5',
  },
  {
    kind: 'skip',
    label: 'DELETE /api/stats/prompt-logs',
    reason: 'löscht Prompt-Logs und Token-Nutzung; nur Auth-Probe',
  },

  // debug
  {
    kind: 'read',
    label: 'GET /api/debug/conversations',
    method: 'GET',
    path: '/api/debug/conversations',
  },
  {
    kind: 'read',
    label: 'GET /api/debug/conversations/[id]/turns (fehlend)',
    method: 'GET',
    path: `/api/debug/conversations/${MISSING}/turns`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/debug/conversations/[id]/replay ohne fromSeq',
    method: 'POST',
    path: `/api/debug/conversations/${MISSING}/replay`,
    params: { id: MISSING },
    body: {},
  },

  // knowledge
  {
    kind: 'guard',
    label: 'GET /api/knowledge/graph ohne personaId',
    method: 'GET',
    path: '/api/knowledge/graph',
  },
  {
    kind: 'read',
    label: 'GET /api/knowledge/graph (fehlende Persona)',
    method: 'GET',
    path: `/api/knowledge/graph?personaId=${MISSING}`,
  },

  // events: the list is a read, the create fails validation on an empty body
  {
    kind: 'read',
    label: 'GET /api/events',
    method: 'GET',
    path: '/api/events?limit=5',
  },
  {
    kind: 'guard',
    label: 'POST /api/events ohne type/message',
    method: 'POST',
    path: '/api/events',
    body: {},
  },
  { kind: 'skip', label: 'GET /api/events/stream', reason: 'SSE-Stream, wird gesondert geprüft' },
];

/** One anonymous request per route file. Checked only in the auth lane. */
const AUTH_CASES = [
  { label: 'stats', method: 'GET', path: '/api/stats' },
  { label: 'stats/engineering', method: 'GET', path: '/api/stats/engineering' },
  { label: 'stats/prompt-logs', method: 'GET', path: '/api/stats/prompt-logs' },
  { label: 'debug/conversations', method: 'GET', path: '/api/debug/conversations' },
  {
    label: 'debug/conversations/[id]/turns',
    method: 'GET',
    path: `/api/debug/conversations/${MISSING}/turns`,
  },
  {
    label: 'debug/conversations/[id]/replay',
    method: 'POST',
    path: `/api/debug/conversations/${MISSING}/replay`,
  },
  { label: 'knowledge/graph', method: 'GET', path: '/api/knowledge/graph' },
  { label: 'events', method: 'GET', path: '/api/events' },
  { label: 'events (POST)', method: 'POST', path: '/api/events' },
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
