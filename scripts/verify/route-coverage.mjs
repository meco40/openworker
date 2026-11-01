#!/usr/bin/env node
/**
 * Checks the Rust route table against the reviewed reference in
 * `scripts/verify/route-table.json` (one "METHOD /api/path" entry per route, with
 * dynamic segments written as `:id`).
 *
 * The Rust routers are the only source of declared routes. The TypeScript route
 * files that used to be the other side of this comparison were removed with the
 * TypeScript backend, so the reference list is what guards against a route being
 * dropped or added by accident. Changing a route means changing the reference in the
 * same reviewed edit.
 *
 *   node scripts/verify/route-coverage.mjs                # check against the reference
 *   node scripts/verify/route-coverage.mjs --print-table  # print the declared table (for a deliberate update)
 *   node scripts/verify/route-coverage.mjs --self-test
 */
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = process.env.ROUTE_COVERAGE_ROOT || fileURLToPath(new URL('../../', import.meta.url));
const normalize = (path) =>
  path.replace(/\[(?:\.\.\.)?[^/\]]+\]|\{[^/}]+\}/g, ':id').replace(/\/$/, '');
function files(dir, predicate) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(dir, entry.name), predicate)
      : predicate(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
}
function closingParen(source, start) {
  let depth = 1,
    quote = null;
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"') {
      quote = ch;
      continue;
    }
    if (source.slice(i, i + 2) === '//') {
      i = source.indexOf('\n', i);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}
export function rustRoutes(source) {
  source = source.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (part) =>
    part.startsWith('"') ? part : ' ',
  );
  source = source
    .replace(/#\[cfg\(test\)\]\s*mod\s+\w+\s*;/g, '')
    .split(/#\[cfg\(test\)\]\s*mod\s+\w+\s*\{/)[0];
  const routes = new Map();
  for (const match of source.matchAll(/\.route\(\s*"([^"]+)"\s*,/g)) {
    const start = source.indexOf('(', match.index);
    const end = closingParen(source, start);
    if (end < 0) throw new Error('Unbalanced Rust route declaration: ' + match[1]);
    const expression = source.slice(match.index + match[0].length, end);
    const routeMethods = [
      ...expression.matchAll(/\b(get|post|put|patch|delete|head|options)\s*\(/g),
    ].map((m) => m[1].toUpperCase());
    const key = normalize(match[1]);
    const existing = routes.get(key) || new Set();
    for (const method of routeMethods) existing.add(method);
    routes.set(key, existing);
  }
  return routes;
}

/** Declared "METHOD path" entries, sorted, from every Rust router under the gateway crate. */
export function declaredTable(rootDir) {
  const declared = new Map();
  for (const file of files(
    join(rootDir, 'rust/crates/betaclaw-gateway/src'),
    (name) => name.endsWith('.rs') && !name.includes('test_support'),
  )) {
    for (const [path, verbs] of rustRoutes(readFileSync(file, 'utf8'))) {
      const all = declared.get(path) || new Set();
      for (const verb of verbs) all.add(verb);
      declared.set(path, all);
    }
  }
  return [...declared]
    .flatMap(([path, verbs]) => [...verbs].map((verb) => `${verb} ${path}`))
    .sort();
}

/** Entries in the reference that the Rust table lacks, and entries the table has beyond it. */
export function diffTable(reference, declared) {
  const expected = new Set(reference);
  const actual = new Set(declared);
  return {
    missing: [...expected].filter((entry) => !actual.has(entry)).sort(),
    unreviewed: [...actual].filter((entry) => !expected.has(entry)).sort(),
  };
}

function readReference(rootDir) {
  return JSON.parse(readFileSync(join(rootDir, 'scripts/verify/route-table.json'), 'utf8'));
}

if (process.argv.includes('--self-test')) {
  const routes = rustRoutes('Router::new().route("/api/items/{id}", get(read).post(write))');
  assert.deepEqual([...routes.get(normalize('/api/items/[id]'))].sort(), ['GET', 'POST']);
  assert.equal(normalize('/api/items/[id]'), normalize('/api/items/{itemId}'));
  assert.equal(
    rustRoutes('#[cfg(test)] mod tests { router.route("/api/fake", get(fake)); }').size,
    0,
  );
  assert.equal(
    rustRoutes('// .route("/api/fake", get(fake))\n/* .route("/api/fake", get(fake)) */').size,
    0,
  );
  assert.deepEqual(diffTable(['GET /a', 'DELETE /a'], ['GET /a', 'POST /b']), {
    missing: ['DELETE /a'],
    unreviewed: ['POST /b'],
  });
  const scratch = mkdtempSync(join(tmpdir(), 'route-coverage-'));
  try {
    mkdirSync(join(scratch, 'rust/crates/betaclaw-gateway/src'), { recursive: true });
    mkdirSync(join(scratch, 'scripts/verify'), { recursive: true });
    writeFileSync(
      join(scratch, 'rust/crates/betaclaw-gateway/src/routes.rs'),
      'Router::new().route("/api/items/{id}", get(read))',
    );
    const run = () =>
      spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        encoding: 'utf8',
        env: { ...process.env, ROUTE_COVERAGE_ROOT: scratch },
      });
    writeFileSync(
      join(scratch, 'scripts/verify/route-table.json'),
      JSON.stringify(['GET /api/items/:id']),
    );
    const passing = run();
    assert.equal(passing.status, 0, passing.stdout + passing.stderr);
    writeFileSync(
      join(scratch, 'scripts/verify/route-table.json'),
      JSON.stringify(['GET /api/items/:id', 'DELETE /api/items/:id']),
    );
    const failing = run();
    assert.equal(failing.status, 1, failing.stdout + failing.stderr);
    assert.match(failing.stderr, /DELETE \/api\/items\/:id/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log('Route-coverage self-tests passed.');
} else if (process.argv.includes('--print-table')) {
  console.log(JSON.stringify(declaredTable(root), null, 2));
} else {
  const declared = declaredTable(root);
  const reference = readReference(root);
  const { missing, unreviewed } = diffTable(reference, declared);
  console.log(
    `${declared.length} route/method pairs declared in Rust, ${reference.length} in the reference.`,
  );
  if (missing.length || unreviewed.length) {
    if (missing.length) console.error('Missing Rust handlers:\n' + missing.join('\n'));
    if (unreviewed.length)
      console.error(
        'Routes not in scripts/verify/route-table.json (review, then add them):\n' +
          unreviewed.join('\n'),
      );
    process.exitCode = 1;
  } else console.log('The Rust route table matches the reviewed reference.');
}
