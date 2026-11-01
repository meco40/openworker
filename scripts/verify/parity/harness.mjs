/**
 * Shared machinery for cross-implementation parity checks.
 *
 * A parity family compares one migrated route family with the reference values
 * recorded from the TypeScript backend before its removal. The Rust side is reached
 * over HTTP, either through the documented local container flow (`GATEWAY_CONTAINER`,
 * addressed with `docker exec curl`) or directly against a started gateway binary
 * (`GATEWAY_BASE_URL`, how CI runs it).
 *
 * The expected values are the fixed references in `golden/<family>.json`. They are
 * reviewed data: changing one is an ordinary edit that shows up in the diff. Nothing
 * here runs TypeScript or writes the golden files.
 *
 * Families live in `families/` and export `{ name, run }`. `run.mjs` executes
 * them and exits non-zero on any mismatch.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTAINER = process.env.GATEWAY_CONTAINER || 'betaclaw-gateway-ws';
const RUST_ORIGIN = process.env.GATEWAY_BASE_URL || 'http://127.0.0.1:3000';
const GOLDEN_DIR = fileURLToPath(new URL('./golden/', import.meta.url));

let failures = 0;
const goldenStores = new Map();

export function failureCount() {
  return failures;
}

/** Returns the reference value stored under `key` for `family` in `golden/<family>.json`. */
export async function goldenReference(family, key) {
  const store = goldenStore(family);
  if (!Object.hasOwn(store.values, key)) {
    throw new Error(
      `${family}: keine Referenz '${key}' in golden/${family}.json. Die Datei ist eine geprüfte Vorgabe; Änderungen als reviewte Änderung einchecken.`,
    );
  }
  return structuredClone(store.values[key]);
}

function goldenStore(family) {
  if (!goldenStores.has(family)) {
    const file = join(GOLDEN_DIR, `${family}.json`);
    if (!existsSync(file)) {
      throw new Error(`Referenzdaten fehlen: ${file}.`);
    }
    const { values } = JSON.parse(readFileSync(file, 'utf8'));
    goldenStores.set(family, { file, values });
  }
  return goldenStores.get(family);
}

export function check(label, actual, expected) {
  const ok = structuralEqual(actual, expected);
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${label}`);
    console.log(`     Rust: ${JSON.stringify(actual)}`);
    console.log(`     Golden: ${JSON.stringify(expected)}`);
  } else {
    console.log(`OK   ${label}`);
  }
  return ok;
}

export function checkTrue(label, condition, detail = '') {
  if (!condition) {
    failures += 1;
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`OK   ${label}`);
  }
  return condition;
}

/**
 * One HTTP round trip against the Rust gateway. Returns `{ status, json, text }`;
 * `json` is null for non-JSON bodies. `raw` sends the body string as-is
 * (invalid-JSON probes) instead of JSON-encoding `body`.
 */
export async function rustRequest(method, path, { body, raw, headers = {} } = {}) {
  const hasBody = body !== undefined || raw !== undefined;
  let status;
  let text;
  let setCookies = [];
  if (process.env.GATEWAY_BASE_URL) {
    const options = {
      method,
      headers,
      signal: AbortSignal.timeout(20000),
    };
    if (method !== 'GET' && hasBody) {
      options.headers = { 'Content-Type': 'application/json', ...headers };
      options.body = raw ?? JSON.stringify(body);
    }
    const response = await fetch(`${RUST_ORIGIN}${path}`, options);
    status = response.status;
    setCookies = response.headers.getSetCookie();
    text = await response.text();
  } else {
    const args = ['-s', '-i', '-w', '\n%{http_code}'];
    for (const [name, value] of Object.entries(headers)) args.push('-H', name + ': ' + value);
    if (method !== 'GET') args.push('-X', method);
    if (hasBody) {
      args.push('-H', 'Content-Type: application/json', '-d', raw ?? JSON.stringify(body));
    }
    const output = execFileSync(
      'docker',
      ['exec', CONTAINER, 'curl', ...args, `${RUST_ORIGIN}${path}`],
      { encoding: 'utf8', timeout: 20000 },
    );
    const separator = output.lastIndexOf('\n');
    status = Number(output.slice(separator + 1).trim());
    const rawResponse = output.slice(0, separator);
    const boundary = rawResponse.indexOf('\r\n\r\n');
    const responseHeaders = rawResponse.slice(0, boundary);
    setCookies = responseHeaders
      .split('\r\n')
      .filter((line) => /^set-cookie:/i.test(line))
      .map((line) => line.slice(line.indexOf(':') + 1).trim());
    text = rawResponse.slice(boundary + 4);
  }

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON bodies stay raw; families decide whether that is valid.
  }
  return { status, json, text, setCookies };
}

/** Best-effort temp-directory removal; Windows may keep file handles open. */
export function bestEffortRemoveDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore — leftover temp directories are cleaned by the OS
  }
}

/** Key-order-insensitive JSON equality; JSON object key order is not contract. */
function structuralEqual(actual, expected) {
  return JSON.stringify(sortValue(actual)) === JSON.stringify(sortValue(expected));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortValue(value[key]);
    }
    return sorted;
  }
  return value;
}
