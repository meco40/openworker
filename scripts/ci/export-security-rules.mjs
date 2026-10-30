#!/usr/bin/env node
/**
 * Exports SECURITY_RULES from src/shared/domain/constants.ts into the Rust
 * fixture used by /api/security/status.
 *
 * The security status contract counts enabled/blocked High-risk command rules.
 * Hand-maintaining that list in two languages would silently drift, so the Rust
 * side reads a generated JSON snapshot. Regenerate with:
 *
 *   node scripts/ci/export-security-rules.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const sourcePath = resolve(repoRoot, 'src', 'shared', 'domain', 'constants.ts');
const targetPath = resolve(
  repoRoot,
  'rust',
  'crates',
  'betaclaw-gateway',
  'src',
  'fixtures',
  'security-rules.json',
);

const source = readFileSync(sourcePath, 'utf8');
const declarationIndex = source.indexOf('export const SECURITY_RULES');
if (declarationIndex === -1) {
  throw new Error('SECURITY_RULES not found in src/shared/domain/constants.ts');
}

const arrayStart = source.indexOf('= [', declarationIndex) + 2;
let depth = 0;
let arrayEnd = -1;
for (let index = arrayStart; index < source.length; index += 1) {
  const char = source[index];
  if (char === '[') depth += 1;
  else if (char === ']') {
    depth -= 1;
    if (depth === 0) {
      arrayEnd = index + 1;
      break;
    }
  }
}
if (arrayEnd === -1) {
  throw new Error('SECURITY_RULES array literal is not terminated');
}

// The TS literal uses single quotes and bare object keys. Normalise both so the
// standard JSON parser can read it.
const literal = source
  .slice(arrayStart, arrayEnd)
  .split("'")
  .join('"')
  .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
  .replace(/,(\s*[}\]])/g, '$1');

const rules = JSON.parse(literal);
if (!Array.isArray(rules) || rules.length === 0) {
  throw new Error('SECURITY_RULES did not parse into a non-empty array');
}

mkdirSync(dirname(targetPath), { recursive: true });
writeFileSync(targetPath, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');

const enabledHigh = rules.filter((rule) => rule.risk === 'High' && rule.enabled).length;
const blockedHigh = rules.filter((rule) => rule.risk === 'High' && !rule.enabled).length;
const blocked = rules.filter((rule) => !rule.enabled).length;

process.stdout.write(
  `[export-security-rules] ${rules.length} rules -> ${targetPath} ` +
    `(enabledHigh=${enabledHigh} blocked=${blocked} blockedHigh=${blockedHigh})\n`,
);
