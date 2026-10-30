/**
 * `app/api/skills/**`, `clawhub/**` and `files/**` parity (13 routes).
 *
 * The TypeScript reference is the route handler itself. Each route module is
 * imported in-process and called with a `NextRequest`, so status and body come
 * from the real code and are not transcribed. The Rust side goes over HTTP.
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
 *
 * Module-level singletons of earlier families can keep stale store paths; run
 * this family alone with `--family=skills` if a TS-side error names a path.
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { check, checkTrue, rustRequest } from '../harness.mjs';

export const name = 'skills';

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
// A slug the ClawHub validator refuses, so the route answers 400 before any registry call.
const INVALID_SLUG = 'Bad%20Slug';
const INVALID_SLUG_DECODED = 'Bad Slug';

/** Route probes. Dynamic params are passed as a Promise, like Next does. */
const CASES = [
  // skills: list, install (refused unless the external-skill policy allows it)
  {
    kind: 'read',
    label: 'GET /api/skills',
    route: 'skills/route.ts',
    method: 'GET',
    path: '/api/skills',
  },
  {
    kind: 'guard',
    label: 'POST /api/skills ohne source',
    route: 'skills/route.ts',
    method: 'POST',
    path: '/api/skills',
    body: {},
  },
  {
    kind: 'guard',
    label: 'PATCH /api/skills/[id] (fehlend)',
    route: 'skills/[id]/route.ts',
    method: 'PATCH',
    path: `/api/skills/${MISSING}`,
    params: { id: MISSING },
    body: { installed: true },
  },
  {
    kind: 'guard',
    label: 'DELETE /api/skills/[id] (fehlend)',
    route: 'skills/[id]/route.ts',
    method: 'DELETE',
    path: `/api/skills/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/skills/execute (unbekannter Skill)',
    route: 'skills/execute/route.ts',
    method: 'POST',
    path: '/api/skills/execute',
    body: { name: MISSING },
  },
  {
    kind: 'read',
    label: 'GET /api/skills/external-host',
    route: 'skills/external-host/route.ts',
    method: 'GET',
    path: '/api/skills/external-host',
  },
  {
    kind: 'guard',
    label: 'POST /api/skills/external-host ohne action',
    route: 'skills/external-host/route.ts',
    method: 'POST',
    path: '/api/skills/external-host',
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/skills/runtime-config',
    route: 'skills/runtime-config/route.ts',
    method: 'GET',
    path: '/api/skills/runtime-config',
  },
  {
    kind: 'guard',
    label: 'PUT /api/skills/runtime-config ohne id',
    route: 'skills/runtime-config/route.ts',
    method: 'PUT',
    path: '/api/skills/runtime-config',
    body: {},
  },
  {
    kind: 'guard',
    label: 'DELETE /api/skills/runtime-config ohne id',
    route: 'skills/runtime-config/route.ts',
    method: 'DELETE',
    path: '/api/skills/runtime-config',
    body: {},
  },

  // clawhub: search and install talk to the registry, so only their refusals are probed
  {
    kind: 'guard',
    label: 'GET /api/clawhub/search ohne q',
    route: 'clawhub/search/route.ts',
    method: 'GET',
    path: '/api/clawhub/search',
  },
  {
    kind: 'guard',
    label: 'PATCH /api/clawhub/[slug] (ungültiger Slug)',
    route: 'clawhub/[slug]/route.ts',
    method: 'PATCH',
    path: `/api/clawhub/${INVALID_SLUG}`,
    params: { slug: INVALID_SLUG_DECODED },
    body: { enabled: true },
  },
  {
    kind: 'guard',
    label: 'DELETE /api/clawhub/[slug] (ungültiger Slug)',
    route: 'clawhub/[slug]/route.ts',
    method: 'DELETE',
    path: `/api/clawhub/${INVALID_SLUG}`,
    params: { slug: INVALID_SLUG_DECODED },
  },
  {
    kind: 'guard',
    label: 'POST /api/clawhub/install ohne slug',
    route: 'clawhub/install/route.ts',
    method: 'POST',
    path: '/api/clawhub/install',
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/clawhub/prompt',
    route: 'clawhub/prompt/route.ts',
    method: 'GET',
    path: '/api/clawhub/prompt',
  },
  {
    kind: 'read',
    label: 'GET /api/clawhub/installed',
    route: 'clawhub/installed/route.ts',
    method: 'GET',
    path: '/api/clawhub/installed',
  },
  {
    kind: 'guard',
    label: 'POST /api/clawhub/update ohne slug/all',
    route: 'clawhub/update/route.ts',
    method: 'POST',
    path: '/api/clawhub/update',
    body: {},
  },

  // files: preview refuses non-HTML and missing paths before touching the file system
  {
    kind: 'read',
    label: 'GET /api/files/preview ohne path',
    route: 'files/preview/route.ts',
    method: 'GET',
    path: '/api/files/preview',
  },
  {
    kind: 'read',
    label: 'GET /api/files/preview (kein HTML)',
    route: 'files/preview/route.ts',
    method: 'GET',
    path: `/api/files/preview?path=${MISSING}.txt`,
  },
  {
    kind: 'guard',
    label: 'POST /api/files/reveal ohne filePath',
    route: 'files/reveal/route.ts',
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
