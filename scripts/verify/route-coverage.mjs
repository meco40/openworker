#!/usr/bin/env node
/** Compare Next route exports with the methods actually declared in Rust routers. */
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
// The classic compiler API; TypeScript 7 (the project compiler) no longer exports it.
import ts from 'typescript-api';

const root = process.env.ROUTE_COVERAGE_ROOT || fileURLToPath(new URL('../../', import.meta.url));
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
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
function exportedMethods(file) {
  const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found = new Set();
  for (const node of ast.statements) {
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const spec of node.exportClause.elements)
        if (methods.has(spec.name.text)) found.add(spec.name.text);
    }
    if (!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(node) && node.name && methods.has(node.name.text))
      found.add(node.name.text);
    if (ts.isVariableStatement(node))
      for (const declaration of node.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && methods.has(declaration.name.text))
          found.add(declaration.name.text);
  }
  return found;
}
export function missingMethods(required, available) {
  return [...required].filter((method) => !available?.has(method));
}
if (process.argv.includes('--self-test')) {
  const routes = rustRoutes('Router::new().route("/api/items/{id}", get(read).post(write))');
  assert.deepEqual(
    missingMethods(new Set(['GET', 'DELETE']), routes.get(normalize('/api/items/[id]'))),
    ['DELETE'],
  );
  assert.deepEqual(
    missingMethods(new Set(['DELETE']), routes.get('/api/auth/definitely-missing')),
    ['DELETE'],
  );
  assert.equal(normalize('/api/items/[id]'), normalize('/api/items/{itemId}'));
  assert.equal(
    rustRoutes('#[cfg(test)] mod tests { router.route("/api/fake", get(fake)); }').size,
    0,
  );
  assert.equal(
    rustRoutes('// .route("/api/fake", get(fake))\n/* .route("/api/fake", get(fake)) */').size,
    0,
  );
  const scratch = mkdtempSync(join(tmpdir(), 'route-coverage-'));
  try {
    const api = join(scratch, 'app/api/auth/definitely-missing');
    mkdirSync(api, { recursive: true });
    mkdirSync(join(scratch, 'rust/crates/betaclaw-gateway/src'), { recursive: true });
    writeFileSync(join(api, 'route.ts'), 'export async function DELETE() {}');
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      encoding: 'utf8',
      env: { ...process.env, ROUTE_COVERAGE_ROOT: scratch },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /DELETE \/api\/auth\/definitely-missing/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log('Route-coverage negative/dynamic/method self-tests passed.');
} else {
  const declared = new Map();
  for (const file of files(
    join(root, 'rust/crates/betaclaw-gateway/src'),
    (name) => name.endsWith('.rs') && !name.includes('test_support'),
  )) {
    for (const [path, verbs] of rustRoutes(readFileSync(file, 'utf8'))) {
      const all = declared.get(path) || new Set();
      for (const verb of verbs) all.add(verb);
      declared.set(path, all);
    }
  }
  const missing = [];
  let checked = 0;
  for (const file of files(join(root, 'app/api'), (name) => /^route\.[tj]s$/.test(name))) {
    const path =
      '/' +
      relative(join(root, 'app'), file)
        .replaceAll('\\', '/')
        .replace(/\/route\.[tj]s$/, '');
    if (path === '/api/auth/[...nextauth]') {
      for (const [verb, action] of [
        ['GET', 'providers'],
        ['GET', 'csrf'],
        ['GET', 'session'],
        ['GET', 'signin'],
        ['GET', 'signin/credentials'],
        ['GET', 'error'],
        ['POST', 'callback/credentials'],
        ['POST', 'signout'],
      ]) {
        checked++;
        if (!declared.get('/api/auth/' + action)?.has(verb))
          missing.push(verb + ' /api/auth/' + action);
      }
    } else {
      for (const method of exportedMethods(file)) {
        checked++;
        if (!declared.get(normalize(path))?.has(method)) missing.push(method + ' ' + path);
      }
    }
  }
  console.log(checked + ' route/method contracts checked against Rust declarations.');
  if (missing.length) {
    console.error('Missing Rust handlers:\n' + missing.join('\n'));
    process.exitCode = 1;
  } else console.log('All required route/method pairs have a Rust declaration.');
}
