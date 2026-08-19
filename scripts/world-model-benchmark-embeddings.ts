#!/usr/bin/env node
/**
 * World-Model live embedding benchmark.
 *
 * This script deliberately uses the configured provider and the current
 * embedding worker. It never creates deterministic stand-in vectors: a green
 * result is only possible when the real provider and the scoped PostgreSQL
 * embedding row are available.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

import {
  collectEmbeddingTargets,
  processEmbeddingBatch,
} from '@/server/world-model/embeddings/embeddingWorker';
import { getConfiguredEmbeddingProvider } from '@/server/world-model/embeddings/provider';
import { runWithWorldModelScope, closeWorldModelDb } from '@/server/world-model/db';
import type { WorldModelScope } from '@/server/world-model/scope';

interface BenchmarkResult {
  scenario: string;
  query: string;
  expectedEntity: string;
  latencyMs: number;
  tokensEstimated: number;
  topHit: string | null;
  similarity: number;
  passed: boolean;
}

interface BenchmarkSuiteResult {
  generatedAt: string;
  evidenceClass: 'live-provider';
  providerModel: string;
  providerModelVersion: string;
  vectorDimensions: number;
  scope: WorldModelScope;
  totalScenarios: number;
  passedScenarios: number;
  avgLatencyMs: number;
  totalTokensEstimated: number;
  results: BenchmarkResult[];
  reEmbeddingVerified: boolean;
}

const TEST_SCENARIOS = [
  {
    scenario: 'Cinema cancellation vs Dinner replacement',
    query: 'Was war der Plan für heute Abend?',
    expectedEntity: 'Abendessen',
    targets: [
      { text: 'Plan für heute Abend: Kinobesuch 17 Uhr (abgesagt)', active: false },
      {
        text: 'Aktiver Plan für heute Abend: Abendessen mit Freunden 19 Uhr (bestätigt)',
        active: true,
      },
    ],
  },
  {
    scenario: 'Doctor appointment follow-up',
    query: 'Arzttermin Dr. Weber',
    expectedEntity: 'Dr. Weber',
    targets: [
      { text: 'Termin bei Dr. Weber Kardiologie', active: true },
      { text: 'Zahnarzttermin Dr. Müller (abgeschlossen)', active: false },
    ],
  },
  {
    scenario: 'Standing Intent Mike response',
    query: 'Antwort von Mike zum Projektangebot',
    expectedEntity: 'Projektangebot',
    targets: [
      { text: 'Standing Intent: Erinnere an Projektangebot sobald Mike antwortet', active: true },
      { text: 'Allgemeine E-Mail von Lisa', active: true },
    ],
  },
];

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    left += a[i]! * a[i]!;
    right += b[i]! * b[i]!;
  }
  const denominator = Math.sqrt(left) * Math.sqrt(right);
  return denominator > 0 ? dot / denominator : 0;
}

function parseScope(): WorldModelScope {
  const value = process.env.WORLD_MODEL_BENCHMARK_SCOPE?.trim();
  if (!value) {
    throw new Error('WORLD_MODEL_BENCHMARK_SCOPE is required, e.g. legacy-local-user:persona-id:');
  }
  const parts = value.split(':');
  const userId = parts[0] ?? '';
  const personaId = parts[1] ?? '';
  const workspaceId = parts.slice(2).join(':');
  if (
    parts.length < 3 ||
    !/^[A-Za-z0-9._-]+$/.test(userId) ||
    !/^[A-Za-z0-9._-]+$/.test(personaId) ||
    !(workspaceId === '' || /^[A-Za-z0-9._:-]+$/.test(workspaceId))
  ) {
    throw new Error('WORLD_MODEL_BENCHMARK_SCOPE must be userId:personaId:workspaceId');
  }
  return { userId, personaId, workspaceId };
}

async function runBenchmark(): Promise<BenchmarkSuiteResult> {
  const jsonOutput = process.argv.includes('--json');
  const outputIndex = process.argv.indexOf('--output');
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  if (!jsonOutput) console.log('=== World Model Live Embedding Benchmark ===\n');

  const provider = getConfiguredEmbeddingProvider();
  if (!provider) throw new Error('No configured live embedding provider is available.');
  const scope = parseScope();
  const results: BenchmarkResult[] = [];
  let totalLatency = 0;
  let totalTokens = 0;
  let vectorDimensions = 0;

  for (const item of TEST_SCENARIOS) {
    const start = Date.now();
    const queryTokens = Math.ceil(item.query.length / 4);
    const queryVector = await provider.generateEmbedding(item.query);
    vectorDimensions = queryVector.length;
    let bestHit: string | null = null;
    let bestSimilarity = -1;

    for (const target of item.targets) {
      const targetTokens = Math.ceil(target.text.length / 4);
      totalTokens += queryTokens + targetTokens;
      const targetVector = await provider.generateEmbedding(target.text);
      const similarity = cosineSimilarity(queryVector, targetVector);
      const weightedSimilarity = target.active ? similarity : similarity * 0.5;
      if (weightedSimilarity > bestSimilarity) {
        bestSimilarity = weightedSimilarity;
        bestHit = target.text;
      }
    }

    const latencyMs = Date.now() - start;
    totalLatency += latencyMs;
    const passed = bestHit?.includes(item.expectedEntity) === true;
    results.push({
      scenario: item.scenario,
      query: item.query,
      expectedEntity: item.expectedEntity,
      latencyMs,
      tokensEstimated: queryTokens,
      topHit: bestHit,
      similarity: Number(bestSimilarity.toFixed(4)),
      passed,
    });
    if (!jsonOutput) {
      console.log(
        `${passed ? '✅' : '❌'} [${item.scenario}] top="${bestHit}" sim=${bestSimilarity.toFixed(4)} latency=${latencyMs}ms`,
      );
    }
  }

  const targets = await runWithWorldModelScope(scope, () => collectEmbeddingTargets(1, scope));
  const reEmbedding = targets.length
    ? await processEmbeddingBatch(targets, {
        model: provider.model,
        modelVersion: provider.modelVersion,
      })
    : [];
  const reEmbeddingVerified = reEmbedding.some(
    (entry) => entry.targetId === targets[0]?.targetId && entry.created === false,
  );
  const passedScenarios = results.filter((result) => result.passed).length;
  const suiteResult: BenchmarkSuiteResult = {
    generatedAt: new Date().toISOString(),
    evidenceClass: 'live-provider',
    providerModel: provider.model,
    providerModelVersion: provider.modelVersion,
    vectorDimensions,
    scope,
    totalScenarios: results.length,
    passedScenarios,
    avgLatencyMs: Number((totalLatency / results.length).toFixed(2)),
    totalTokensEstimated: totalTokens,
    results,
    reEmbeddingVerified,
  };

  if (jsonOutput) console.log(JSON.stringify(suiteResult, null, 2));
  else {
    console.log('\n--- Summary ---');
    console.log(`Passed: ${passedScenarios}/${results.length}`);
    console.log(`Avg latency: ${suiteResult.avgLatencyMs}ms`);
    console.log(
      `Provider: ${provider.model} (${provider.modelVersion}), dimensions=${vectorDimensions}`,
    );
    console.log(`Re-embedding idempotency: ${reEmbeddingVerified ? 'VERIFIED' : 'FAILED'}`);
  }
  if (outputPath) {
    fs.writeFileSync(outputPath, `${JSON.stringify(suiteResult, null, 2)}\n`, 'utf8');
    if (!jsonOutput) console.log(`Report written to ${outputPath}`);
  }
  return suiteResult;
}

void runBenchmark()
  .then((result) => {
    void closeWorldModelDb();
    process.exit(
      result.passedScenarios === result.totalScenarios && result.reEmbeddingVerified ? 0 : 1,
    );
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    void closeWorldModelDb();
    process.exit(1);
  });
