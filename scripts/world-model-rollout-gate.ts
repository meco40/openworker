#!/usr/bin/env node
/**
 * Evaluates a scoped World-Model rollout without mutating the running app.
 * `--apply` is intentionally not provided: changing a live process requires
 * an explicit deployment/configuration action outside this evidence tool.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

type Mode = 'off' | 'shadow' | 'required' | 'canonical';

function parseArgs(): { scope?: string; mode: Mode; output?: string } {
  const args = process.argv.slice(2);
  let mode: Mode = 'shadow';
  let scope: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case '--scope':
        scope = args[++index];
        break;
      case '--mode':
        mode = args[++index] as Mode;
        break;
      case '--output':
        output = args[++index];
        break;
    }
  }
  if (!['off', 'shadow', 'required', 'canonical'].includes(mode)) {
    throw new Error('--mode must be off, shadow, required or canonical.');
  }
  return { scope, mode, output };
}

function main(): void {
  const options = parseArgs();
  if (!options.scope) throw new Error('--scope userId:personaId:workspaceId is required.');
  const parts = options.scope.split(':');
  if (parts.length < 3 || !parts[0] || !parts[1]) {
    throw new Error('--scope must be userId:personaId:workspaceId.');
  }
  const scopeKey = options.scope;
  const canaryScopes = String(process.env.WORLD_MODEL_CANARY_SCOPES || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const report = {
    generatedAt: new Date().toISOString(),
    scope: { userId: parts[0], personaId: parts[1], workspaceId: parts.slice(2).join(':') },
    requestedMode: options.mode,
    currentMode: process.env.WORLD_MODEL_MODE || 'off',
    canaryScopes,
    canaryScopeAllowed: canaryScopes.length === 0 || canaryScopes.includes(scopeKey),
    transitions: ['off', 'shadow', 'required', 'canonical'].slice(
      0,
      ['off', 'shadow', 'required', 'canonical'].indexOf(options.mode) + 1,
    ),
    rollbackMode: options.mode === 'canonical' ? 'shadow' : 'off',
    applyRequiredOutsideTool: true,
    ok:
      options.mode !== 'canonical' || canaryScopes.length === 0 || canaryScopes.includes(scopeKey),
  };
  console.log(JSON.stringify(report, null, 2));
  if (options.output) fs.writeFileSync(options.output, JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

try {
  main();
} catch (error) {
  console.error(
    `World Model rollout gate failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
