#!/usr/bin/env node
/**
 * World Model Failure Drill Script
 *
 * Phase 15: Fuehrt kontrollierte Fehlerszenarien durch und validiert, dass
 * das System korrekt degradiert oder recovered.
 *
 * Usage:
 *   pnpm run world-model:drill -- --scenario postgres-outage
 *   pnpm run world-model:drill -- --scenario scheduler-restart
 *   pnpm run world-model:drill -- --scenario duplicate-webhook
 *   pnpm run world-model:drill -- --scenario all
 */

import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

type DrillScenario =
  | 'postgres-outage'
  | 'scheduler-restart'
  | 'graphiti-outage'
  | 'embedder-outage'
  | 'duplicate-webhook'
  | 'all';

interface DrillResult {
  scenario: string;
  passed: boolean;
  details: string;
  durationMs: number;
}

async function withDrillTimeout<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`drill timeout after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseArgs(): { scenario: DrillScenario } {
  const args = process.argv.slice(2);
  let scenario: DrillScenario = 'all';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scenario' && args[i + 1]) {
      scenario = args[++i] as DrillScenario;
    }
  }

  return { scenario };
}

async function drillPostgresOutage(): Promise<DrillResult> {
  const startedAt = Date.now();
  console.log('--- Drill: PostgreSQL Outage ---');

  try {
    const { getWorldModelConfig } = await import('@/server/world-model/config');
    const config = getWorldModelConfig();

    if (!config.enabled && !config.e2eEnabled) {
      return {
        scenario: 'postgres-outage',
        passed: false,
        details: 'Blocked: World Model is disabled; this outage drill is not active.',
        durationMs: Date.now() - startedAt,
      };
    }

    // Inject a connection-level outage against a dedicated unused endpoint;
    // the shared development PostgreSQL container is never stopped.
    const { deriveWriteHealth } = await import('@/server/world-model/services/observationService');
    const { Client } = await import('pg');
    let outageDetected = false;
    try {
      const client = new Client({
        connectionString: 'postgresql://drill:drill@127.0.0.1:59999/drill',
        connectionTimeoutMillis: 500,
      });
      await client.connect();
      await client.end();
    } catch {
      outageDetected = true;
    }

    // Test 2: Write health derivation
    const healthOk = deriveWriteHealth(true, config.mode);
    const healthFail = deriveWriteHealth(false, config.mode);
    console.log(`  [INFO] Write health: ok=${healthOk}, fail=${healthFail}`);
    console.log(`  [INFO] Mode: ${config.mode}`);

    if (!outageDetected || (config.mode === 'canonical' && healthFail !== 'blocked')) {
      return {
        scenario: 'postgres-outage',
        passed: false,
        details: `OutageDetected=${outageDetected}; write health on failure=${healthFail}`,
        durationMs: Date.now() - startedAt,
      };
    }

    return {
      scenario: 'postgres-outage',
      passed: true,
      details: `Injected connection outage detected; write health: ok=${healthOk}, fail=${healthFail} (mode=${config.mode})`,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      scenario: 'postgres-outage',
      passed: false,
      details: `Error: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: Date.now() - startedAt,
    };
  }
}

async function drillSchedulerRestart(): Promise<DrillResult> {
  const startedAt = Date.now();
  console.log('--- Drill: Scheduler Restart ---');

  try {
    const { getWorldModelConfig } = await import('@/server/world-model/config');
    const config = getWorldModelConfig();

    if (!config.enabled && !config.e2eEnabled) {
      return {
        scenario: 'scheduler-restart',
        passed: false,
        details: 'Blocked: World Model is disabled; scheduler recovery is not active.',
        durationMs: Date.now() - startedAt,
      };
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'world-model-scheduler-drill-'));
    const databasePath = path.join(root, 'automation.db');
    const childScript = path.resolve('scripts/world-model-scheduler-restart-child.ts');
    const ttlMs = 250;

    const startChild = async (owner: string) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', childScript, owner, String(ttlMs)],
        {
          cwd: process.cwd(),
          env: { ...process.env, AUTOMATION_DB_PATH: databasePath },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      const ready = new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('scheduler child readiness timeout')),
          5_000,
        );
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          const line = output.split(/\r?\n/).find((entry) => entry.trim().startsWith('{'));
          if (line) {
            clearTimeout(timer);
            try {
              resolve(Boolean((JSON.parse(line) as { claimed?: boolean }).claimed));
            } catch (error) {
              reject(error);
            }
          }
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (code) => {
          if (code !== 0 && !output.includes('"claimed":true')) {
            clearTimeout(timer);
            reject(new Error(`scheduler child exited before claiming lease (code=${code})`));
          }
        });
      });
      return { child, claimed: await ready };
    };

    const firstOwner = `world-model-drill-child-${process.pid}-${Date.now()}`;
    const secondOwner = `${firstOwner}-restarted`;
    const first = await startChild(firstOwner);
    first.child.kill();
    await new Promise<void>((resolve) => {
      if (first.child.exitCode !== null) resolve();
      else first.child.once('exit', () => resolve());
    });
    await new Promise((resolve) => setTimeout(resolve, ttlMs + 150));
    const second = await startChild(secondOwner);
    second.child.kill();
    await new Promise<void>((resolve) => {
      if (second.child.exitCode !== null) resolve();
      else second.child.once('exit', () => resolve());
    });
    fs.rmSync(root, { recursive: true, force: true });

    if (!first.claimed || !second.claimed) {
      return {
        scenario: 'scheduler-restart',
        passed: false,
        details: `Process-boundary lease recovery failed: first=${first.claimed}, restarted=${second.claimed}`,
        durationMs: Date.now() - startedAt,
      };
    }

    console.log('  [PASS] Independent scheduler process reclaimed the lease after termination');

    return {
      scenario: 'scheduler-restart',
      passed: true,
      details:
        'Independent scheduler child claimed the lease, was terminated, and a restarted child reclaimed it after TTL expiry',
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      scenario: 'scheduler-restart',
      passed: false,
      details: `Error: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: Date.now() - startedAt,
    };
  }
}

async function drillDuplicateWebhook(): Promise<DrillResult> {
  const startedAt = Date.now();
  console.log('--- Drill: Duplicate Webhook ---');

  try {
    const { getWorldModelConfig } = await import('@/server/world-model/config');
    const config = getWorldModelConfig();

    if (!config.enabled && !config.e2eEnabled) {
      return {
        scenario: 'duplicate-webhook',
        passed: false,
        details: 'Blocked: World Model is disabled; idempotency is not active.',
        durationMs: Date.now() - startedAt,
      };
    }

    const { recordObservation } = await import('@/server/world-model/services/observationService');
    const scope = { userId: 'drill-user', personaId: 'drill-persona', workspaceId: '' };
    const sourceId = `drill:duplicate-webhook:${crypto.randomUUID()}`;
    const input = {
      ...scope,
      sourceType: 'chat_message' as const,
      sourceId,
      occurredAt: new Date().toISOString(),
      payload: { drill: 'duplicate-webhook', sourceId },
      sourceAuthority: 'drill',
    };
    const first = await recordObservation(input, scope);
    const second = await recordObservation(input, scope);
    if (!first.created || second.created || first.observation.id !== second.observation.id) {
      return {
        scenario: 'duplicate-webhook',
        passed: false,
        details: `Replay was not idempotent: firstCreated=${first.created}, secondCreated=${second.created}`,
        durationMs: Date.now() - startedAt,
      };
    }

    const { deleteWorldModelScope } = await import('@/server/world-model/dataLifecycle');
    await deleteWorldModelScope(scope);

    console.log('  [PASS] Identical webhook replay returned the same observation');

    return {
      scenario: 'duplicate-webhook',
      passed: true,
      details: 'The observation writer deduplicates identical scoped source identities',
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      scenario: 'duplicate-webhook',
      passed: false,
      details: `Error: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: Date.now() - startedAt,
    };
  }
}

async function drillEmbedderOutage(): Promise<DrillResult> {
  const startedAt = Date.now();
  console.log('--- Drill: Embedder Outage ---');

  try {
    const { getWorldModelConfig } = await import('@/server/world-model/config');
    const config = getWorldModelConfig();

    if (!config.enabled && !config.e2eEnabled) {
      return {
        scenario: 'embedder-outage',
        passed: false,
        details: 'Blocked: World Model is disabled; retrieval degradation is not active.',
        durationMs: Date.now() - startedAt,
      };
    }

    // Verify that structured retrieval works when the embedder is down.
    const embeddingKeys = [
      'EMBEDDING_API_URL',
      'EMBEDDING_API_KEY',
      'EMBEDDING_MODEL',
      'EMBEDDING_TIMEOUT_MS',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
    ] as const;
    const previousEmbeddingEnv = Object.fromEntries(
      embeddingKeys.map((key) => [key, process.env[key]]),
    );
    for (const key of embeddingKeys) delete process.env[key];
    // Force a failing endpoint with low timeout to test outage degradation
    process.env.EMBEDDING_API_URL = 'http://127.0.0.1:9999/outage-embeddings';
    process.env.EMBEDDING_API_KEY = 'drill-key';
    process.env.EMBEDDING_TIMEOUT_MS = '500';

    let result: Awaited<
      ReturnType<typeof import('@/server/world-model/retrieval').retrieveContext>
    >;
    try {
      const { retrieveContext } = await import('@/server/world-model/retrieval');
      result = await withDrillTimeout(
        retrieveContext({
          userId: 'drill-test',
          personaId: 'drill-test',
          workspaceId: '',
          query: 'test query',
          limit: 5,
        }),
      );
    } finally {
      for (const key of embeddingKeys) {
        const value = previousEmbeddingEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    console.log(`  [INFO] Retrieval source: ${result.source}`);
    console.log(`  [INFO] Structured hits: ${result.structured.length}`);
    console.log(`  [INFO] Fulltext hits: ${result.fullText.length}`);
    console.log(`  [INFO] Vector hits: ${result.vector.length}`);

    // Structured/Fulltext retrieval should work even without embeddings.
    if (!result.enabled) {
      return {
        scenario: 'embedder-outage',
        passed: false,
        details: 'World Model became disabled during the embedder outage drill.',
        durationMs: Date.now() - startedAt,
      };
    }

    return {
      scenario: 'embedder-outage',
      passed: true,
      details: `Retrieval works without embeddings (source=${result.source})`,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      scenario: 'embedder-outage',
      passed: false,
      details: `Error: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: Date.now() - startedAt,
    };
  }
}

async function drillGraphitiOutage(): Promise<DrillResult> {
  const startedAt = Date.now();
  console.log('--- Drill: Graphiti Outage ---');
  try {
    const { getWorldModelConfig } = await import('@/server/world-model/config');
    const config = getWorldModelConfig();
    if (!config.graphitiShadowEnabled && !config.graphitiBackendEnabled) {
      return {
        scenario: 'graphiti-outage',
        passed: false,
        details: 'Blocked: Graphiti is disabled; no provider outage boundary is active.',
        durationMs: Date.now() - startedAt,
      };
    }
    const previousBaseUrl = process.env.GRAPHITI_BASE_URL;
    process.env.GRAPHITI_BASE_URL = 'http://127.0.0.1:59998/graphiti-outage';
    let health: Awaited<
      ReturnType<typeof import('@/server/world-model/graphiti/client').checkGraphitiHealth>
    >;
    let fallback: Awaited<
      ReturnType<typeof import('@/server/world-model/retrieval').retrieveContext>
    >;
    try {
      const { checkGraphitiHealth } = await import('@/server/world-model/graphiti/client');
      health = await checkGraphitiHealth();
      const { retrieveContext } = await import('@/server/world-model/retrieval');
      fallback = await retrieveContext({
        userId: 'drill-user',
        personaId: 'drill-persona',
        workspaceId: '',
        query: 'graphiti outage fallback',
        limit: 5,
      });
    } finally {
      if (previousBaseUrl === undefined) delete process.env.GRAPHITI_BASE_URL;
      else process.env.GRAPHITI_BASE_URL = previousBaseUrl;
    }
    const passed = !health.reachable && fallback.enabled;
    return {
      scenario: 'graphiti-outage',
      passed,
      details: `Graphiti reachable=${health.reachable}; PostgreSQL fallback enabled=${fallback.enabled}, source=${fallback.source}`,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      scenario: 'graphiti-outage',
      passed: false,
      details: `Error: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: Date.now() - startedAt,
    };
  }
}

async function runDrills(scenario: DrillScenario): Promise<DrillResult[]> {
  const results: DrillResult[] = [];
  const scenarios: DrillScenario[] =
    scenario === 'all'
      ? [
          'postgres-outage',
          'scheduler-restart',
          'graphiti-outage',
          'embedder-outage',
          'duplicate-webhook',
        ]
      : [scenario];

  console.log('=== World Model Failure Drills ===');
  console.log(`Scenarios: ${scenarios.join(', ')}`);
  console.log('');

  for (const s of scenarios) {
    switch (s) {
      case 'postgres-outage':
        results.push(await drillPostgresOutage());
        break;
      case 'scheduler-restart':
        results.push(await drillSchedulerRestart());
        break;
      case 'duplicate-webhook':
        results.push(await drillDuplicateWebhook());
        break;
      case 'embedder-outage':
        results.push(await drillEmbedderOutage());
        break;
      case 'graphiti-outage':
        results.push(await drillGraphitiOutage());
        break;
    }
  }

  return results;
}

const { scenario } = parseArgs();
void runDrills(scenario).then((results) => {
  console.log('');
  console.log('=== Drill Results ===');
  let passed = 0;
  let failed = 0;
  for (const result of results) {
    const icon = result.passed ? '✅' : '❌';
    console.log(`${icon} ${result.scenario}: ${result.details} (${result.durationMs}ms)`);
    if (result.passed) passed++;
    else failed++;
  }
  console.log('');
  console.log(`Total: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
});
