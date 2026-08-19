#!/usr/bin/env node
/**
 * Evaluate Graphiti recall against canonical structured World-Model targets.
 *
 * The report is deliberately separate from the rebuild report: a successful
 * projection only proves transport/processing, not useful recall quality.
 * `--require-quality` turns an unmet recall/precision threshold into a
 * non-zero exit code for rollout automation.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { listRuntimeWorldModelScopes } from '@/server/world-model/runtime/scopeDiscovery';
import type { WorldModelScope } from '@/server/world-model/scope';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

interface Options {
  scope?: string;
  output?: string;
  requireQuality: boolean;
  recallThreshold: number;
  precisionThreshold: number;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const options: Options = {
    requireQuality: false,
    recallThreshold: 0.9,
    precisionThreshold: 0.9,
  };
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case '--scope':
        options.scope = args[++index];
        break;
      case '--output':
        options.output = args[++index];
        break;
      case '--require-quality':
        options.requireQuality = true;
        break;
      case '--recall-threshold':
        options.recallThreshold = parseThreshold(args[++index], '--recall-threshold');
        break;
      case '--precision-threshold':
        options.precisionThreshold = parseThreshold(args[++index], '--precision-threshold');
        break;
    }
  }
  return options;
}

function parseThreshold(value: string | undefined, flag: string): number {
  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`${flag} must be a number between 0 and 1.`);
  }
  return threshold;
}

function parseScope(value: string): WorldModelScope {
  const parts = value.split(':');
  if (parts.length < 3 || !parts[0] || !parts[1]) {
    throw new Error('--scope must be all or userId:personaId:workspaceId.');
  }
  return { userId: parts[0], personaId: parts[1], workspaceId: parts.slice(2).join(':') };
}

function scopeLabel(scope: WorldModelScope): string {
  return `${scope.userId}:${scope.personaId}:${scope.workspaceId ?? ''}`;
}

async function main(): Promise<void> {
  const options = parseArgs();
  const { evaluateGraphitiValue } = await import('@/server/world-model/graphiti/evaluator');
  const { closeWorldModelDb } = await import('@/server/world-model/db');
  const scopes =
    options.scope && options.scope !== 'all'
      ? [parseScope(options.scope)]
      : listRuntimeWorldModelScopes();
  if (scopes.length === 0) throw new Error('No runtime scopes were discovered.');

  const evaluations = [];
  try {
    for (const scope of scopes) {
      const result = await evaluateGraphitiValue({
        ...scope,
        workspaceId: scope.workspaceId ?? '',
      });
      evaluations.push({ scope: scopeLabel(scope), ...result });
    }
  } finally {
    await closeWorldModelDb().catch(() => {});
  }

  const qualityPassed = evaluations.every(
    (result) =>
      result.graphitiReachable &&
      result.recall >= options.recallThreshold &&
      result.precision >= options.precisionThreshold,
  );
  const report = {
    generatedAt: new Date().toISOString(),
    evidenceClass: 'graphiti-historical-recall-evaluation',
    scopeSelection: options.scope ?? 'all',
    thresholds: {
      recall: options.recallThreshold,
      precision: options.precisionThreshold,
    },
    qualityPassed,
    activationRecommendation: qualityPassed ? 'enable' : 'shadow',
    evaluations,
    limitations: [
      'Graphiti is a derived projection; PostgreSQL remains the system of record.',
      'A rebuild can be transport-complete while recall quality remains below the activation threshold.',
      'Provider-wide Mem0 and external channel/provider receipts are outside this local report.',
    ],
  };
  console.log(JSON.stringify(report, null, 2));
  if (options.output) {
    fs.writeFileSync(options.output, JSON.stringify(report, null, 2));
    console.log(`Report written to ${options.output}`);
  }
  if (options.requireQuality && !qualityPassed) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
