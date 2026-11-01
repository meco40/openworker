/**
 * `/api/skills/**`, `clawhub/**` and `files/**` parity (13 routes).
 *
 * The reference is `golden/skills.json`, recorded from the TypeScript route handlers
 * before their removal. The Rust side goes over HTTP.
 *
 * Only state-neutral probes run:
 *   - reads of lists and status,
 *   - requests that fail validation, the external-skill policy (403) or a
 *     missing id before any install, execution, registry lookup or file access,
 *     and
 *   - anonymous requests in the auth lane.
 * Not probed for their success path: skill install and execution, ClawHub
 * search/install/update/uninstall (registry network), `files/reveal` (opens the
 * OS file manager). Those are listed as SKIP.
 *
 * Accepted write: `clawhub/installed` (GET) and `clawhub/prompt` sync the
 * ClawHub lockfile into the store (idempotent upsert). Both sides read their
 * own workdir, so a lockfile present only on the gateway shows up as a list
 * difference, which the shape check does not flag.
 *
 * Lanes: by default (`REQUIRE_AUTH` unset on the gateway and in this process)
 * the main probes run and the anonymous auth probes are reported as SKIP. With
 * `REQUIRE_AUTH=true` on both sides only the auth probes run, because every
 * other probe is answered with 401 there.
 */
import { check, checkTrue, goldenReference, rustRequest } from '../harness.mjs';

export const name = 'skills';

const AUTH_LANE = process.env.REQUIRE_AUTH === 'true';
// Auth-lane reference values differ from the default lane (e.g. REQUIRE_AUTH gates first), so they get their own keys.
const caseKey = (label) => (AUTH_LANE ? `auth lane: ${label}` : label);

const MISSING = 'parity-missing';
// A slug the ClawHub validator refuses, so the route answers 400 before any registry call.
const INVALID_SLUG = 'Bad%20Slug';
const INVALID_SLUG_DECODED = 'Bad Slug';

/** Route probes. Dynamic params are passed as a Promise, like Next does. */
const CASES = [
  // skills: list, install (refused unless the external-skill policy allows it)
  {
    kind: 'read',
    label: 'GET /api/skills',
    method: 'GET',
    path: '/api/skills',
  },
  {
    kind: 'guard',
    label: 'POST /api/skills ohne source',
    method: 'POST',
    path: '/api/skills',
    body: {},
  },
  {
    kind: 'guard',
    label: 'PATCH /api/skills/[id] (fehlend)',
    method: 'PATCH',
    path: `/api/skills/${MISSING}`,
    params: { id: MISSING },
    body: { installed: true },
  },
  {
    kind: 'guard',
    label: 'DELETE /api/skills/[id] (fehlend)',
    method: 'DELETE',
    path: `/api/skills/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/skills/execute (unbekannter Skill)',
    method: 'POST',
    path: '/api/skills/execute',
    body: { name: MISSING },
  },
  {
    kind: 'read',
    label: 'GET /api/skills/external-host',
    method: 'GET',
    path: '/api/skills/external-host',
  },
  {
    kind: 'guard',
    label: 'POST /api/skills/external-host ohne action',
    method: 'POST',
    path: '/api/skills/external-host',
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/skills/runtime-config',
    method: 'GET',
    path: '/api/skills/runtime-config',
  },
  {
    kind: 'guard',
    label: 'PUT /api/skills/runtime-config ohne id',
    method: 'PUT',
    path: '/api/skills/runtime-config',
    body: {},
  },
  {
    kind: 'guard',
    label: 'DELETE /api/skills/runtime-config ohne id',
    method: 'DELETE',
    path: '/api/skills/runtime-config',
    body: {},
  },

  // clawhub: search and install talk to the registry, so only their refusals are probed
  {
    kind: 'guard',
    label: 'GET /api/clawhub/search ohne q',
    method: 'GET',
    path: '/api/clawhub/search',
  },
  {
    kind: 'guard',
    label: 'PATCH /api/clawhub/[slug] (ungültiger Slug)',
    method: 'PATCH',
    path: `/api/clawhub/${INVALID_SLUG}`,
    params: { slug: INVALID_SLUG_DECODED },
    body: { enabled: true },
  },
  {
    kind: 'guard',
    label: 'DELETE /api/clawhub/[slug] (ungültiger Slug)',
    method: 'DELETE',
    path: `/api/clawhub/${INVALID_SLUG}`,
    params: { slug: INVALID_SLUG_DECODED },
  },
  {
    kind: 'guard',
    label: 'POST /api/clawhub/install ohne slug',
    method: 'POST',
    path: '/api/clawhub/install',
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/clawhub/prompt',
    method: 'GET',
    path: '/api/clawhub/prompt',
  },
  {
    kind: 'read',
    label: 'GET /api/clawhub/installed',
    method: 'GET',
    path: '/api/clawhub/installed',
  },
  {
    kind: 'guard',
    label: 'POST /api/clawhub/update ohne slug/all',
    method: 'POST',
    path: '/api/clawhub/update',
    body: {},
  },

  // files: preview refuses non-HTML and missing paths before touching the file system
  {
    kind: 'read',
    label: 'GET /api/files/preview ohne path',
    method: 'GET',
    path: '/api/files/preview',
  },
  {
    kind: 'read',
    label: 'GET /api/files/preview (kein HTML)',
    method: 'GET',
    path: `/api/files/preview?path=${MISSING}.txt`,
  },
  {
    kind: 'guard',
    label: 'POST /api/files/reveal ohne filePath',
    method: 'POST',
    path: '/api/files/reveal',
    body: {},
  },
  {
    kind: 'skip',
    label: 'POST /api/files/reveal (Erfolgspfad)',
    reason: 'öffnet den OS-Dateimanager',
  },
  {
    kind: 'skip',
    label: 'ClawHub search/install/update/uninstall (Erfolgspfad)',
    reason: 'Registry-Netzwerkaufruf',
  },
];

/** One anonymous request per route file. Checked only in the auth lane. */
const AUTH_CASES = [
  { label: 'skills', method: 'GET', path: '/api/skills' },
  { label: 'skills/[id]', method: 'PATCH', path: `/api/skills/${MISSING}` },
  { label: 'skills/execute', method: 'POST', path: '/api/skills/execute' },
  { label: 'skills/external-host', method: 'GET', path: '/api/skills/external-host' },
  { label: 'skills/runtime-config', method: 'GET', path: '/api/skills/runtime-config' },
  { label: 'clawhub/search', method: 'GET', path: '/api/clawhub/search' },
  { label: 'clawhub/[slug]', method: 'PATCH', path: `/api/clawhub/${INVALID_SLUG}` },
  { label: 'clawhub/install', method: 'POST', path: '/api/clawhub/install' },
  { label: 'clawhub/installed', method: 'GET', path: '/api/clawhub/installed' },
  { label: 'clawhub/prompt', method: 'GET', path: '/api/clawhub/prompt' },
  { label: 'clawhub/update', method: 'POST', path: '/api/clawhub/update' },
  { label: 'files/preview', method: 'GET', path: '/api/files/preview' },
  { label: 'files/reveal', method: 'POST', path: '/api/files/reveal' },
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
