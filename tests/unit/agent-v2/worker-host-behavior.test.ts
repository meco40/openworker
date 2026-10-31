import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ExtensionManifestV1,
  LifecycleHookContext,
  LifecycleHookStage,
} from '@/server/agent-v2/types';
import { ExtensionWorkerHost } from '@/server/agent-v2/extensions/workerHost';
import { testArtifactsPath, removeTestArtifactPath } from '../../helpers/testArtifacts';

const originalOldGen = process.env.AGENT_V2_HOOK_WORKER_OLDGEN_MB;
const hosts: ExtensionWorkerHost[] = [];
const fixturePaths: string[] = [];
const context = { userId: 'worker-test' } as unknown as LifecycleHookContext;

function createHost(source: string): ExtensionWorkerHost {
  const modulePath = testArtifactsPath(
    `extension-worker.${Date.now()}.${Math.random().toString(36).slice(2)}.mjs`,
  );
  fs.writeFileSync(modulePath, source, 'utf8');
  fixturePaths.push(modulePath);
  const host = new ExtensionWorkerHost({ modulePath } as ExtensionManifestV1);
  hosts.push(host);
  return host;
}

function getWorker(host: ExtensionWorkerHost): Worker | null {
  return (host as unknown as { worker: Worker | null }).worker;
}

function getPendingIds(host: ExtensionWorkerHost): string[] {
  return [...(host as unknown as { pending: Map<string, unknown> }).pending.keys()];
}

async function stopHost(host: ExtensionWorkerHost): Promise<void> {
  const worker = getWorker(host);
  host.stop();
  if (worker) await worker.terminate();
}

describe('ExtensionWorkerHost behavior', () => {
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map(stopHost));
    for (const modulePath of fixturePaths.splice(0)) removeTestArtifactPath(modulePath);
    if (originalOldGen === undefined) delete process.env.AGENT_V2_HOOK_WORKER_OLDGEN_MB;
    else process.env.AGENT_V2_HOOK_WORKER_OLDGEN_MB = originalOldGen;
  });

  it('starts once and returns structured hook output', async () => {
    const host = createHost(
      `export async function runHook(stage, context) { return { stage, userId: context.userId }; }`,
    );
    host.start();
    host.start();

    await expect(
      host.runHook('session.before_start' as LifecycleHookStage, context, 2_000),
    ).resolves.toMatchObject({
      ok: true,
      output: { stage: 'session.before_start', userId: 'worker-test' },
    });
  });

  it('uses a default export and wraps primitive hook output', async () => {
    const host = createHost(`export default async function runHook() { return 'plain result'; }`);

    await expect(
      host.runHook('session.before_start' as LifecycleHookStage, context, 2_000),
    ).resolves.toEqual({ ok: true, output: { value: 'plain result' } });
  });

  it('preserves null hook output as a value', async () => {
    const host = createHost(`export function runHook() { return null; }`);

    await expect(
      host.runHook('session.before_start' as LifecycleHookStage, context, 2_000),
    ).resolves.toEqual({ ok: true, output: { value: null } });
  });

  it('starts with a configured worker memory limit', async () => {
    process.env.AGENT_V2_HOOK_WORKER_OLDGEN_MB = '256';
    const host = createHost(`export function runHook() { return { ready: true }; }`);

    await expect(
      host.runHook('session.before_start' as LifecycleHookStage, context, 2_000),
    ).resolves.toEqual({ ok: true, output: { ready: true } });
  });

  it('returns hook exceptions as failed execution results', async () => {
    const host = createHost(`export function runHook() { throw new Error('hook exploded'); }`);

    await expect(
      host.runHook('session.before_start' as LifecycleHookStage, context, 2_000),
    ).resolves.toEqual({ ok: false, error: 'hook exploded' });
  });

  it('reports modules that do not export a hook function', async () => {
    const host = createHost(`export const notAHook = true;`);

    await expect(
      host.runHook('session.before_start' as LifecycleHookStage, context, 2_000),
    ).resolves.toMatchObject({
      ok: false,
      error: 'Extension module must export runHook(stage, context).',
    });
  });

  it('reports missing module imports as hook failures', async () => {
    const modulePath = testArtifactsPath(`missing-extension.${Date.now()}.mjs`);
    const host = new ExtensionWorkerHost({ modulePath } as ExtensionManifestV1);
    hosts.push(host);

    await expect(
      host.runHook('session.before_start' as LifecycleHookStage, context, 2_000),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('Cannot find module') });
  });

  it('times out slow hooks and ignores their late response', async () => {
    const host = createHost(
      `export async function runHook() { await new Promise(resolve => setTimeout(resolve, 80)); return 'late'; }`,
    );

    await expect(
      host.runHook('session.before_start' as LifecycleHookStage, context, 5),
    ).resolves.toEqual({ ok: false, error: 'Extension hook timeout after 5ms.' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(getPendingIds(host)).toEqual([]);
  });

  it('rejects pending hooks when stopped and tolerates repeated stops', async () => {
    const host = createHost(
      `export async function runHook() { return await new Promise(() => {}); }`,
    );
    const pending = host.runHook('session.before_start' as LifecycleHookStage, context, 5_000);

    host.stop();
    host.stop();

    await expect(pending).rejects.toThrow('Extension worker terminated.');
    expect(getPendingIds(host)).toEqual([]);
  });

  it('fails pending hooks and rejects future calls after a worker error', async () => {
    const host = createHost(
      `export async function runHook() { return await new Promise(() => {}); }`,
    );
    const pending = host.runHook('session.before_start' as LifecycleHookStage, context, 5_000);
    const worker = getWorker(host);
    expect(worker).not.toBeNull();
    worker?.emit('error', new Error('worker crashed'));

    await expect(pending).rejects.toThrow('worker crashed');
    await expect(
      host.runHook('session.before_start' as LifecycleHookStage, context, 5_000),
    ).resolves.toEqual({ ok: false, error: 'Extension worker unavailable: worker crashed' });
    expect(getPendingIds(host)).toEqual([]);
  });

  it('ignores malformed and unknown worker messages and uses the fallback error text', async () => {
    const host = createHost(
      `export async function runHook() { return await new Promise(() => {}); }`,
    );
    const pending = host.runHook('session.before_start' as LifecycleHookStage, context, 5_000);
    const worker = getWorker(host);
    const [id] = getPendingIds(host);
    expect(worker).not.toBeNull();
    worker?.emit('message', {});
    worker?.emit('message', { id: 'unknown-hook', ok: false });
    worker?.emit('message', { id, ok: false, error: '' });

    await expect(pending).resolves.toEqual({ ok: false, error: 'Extension hook failed.' });
    const pendingWithoutOutput = host.runHook(
      'session.before_start' as LifecycleHookStage,
      context,
      5_000,
    );
    const [outputId] = getPendingIds(host);
    worker?.emit('message', { id: outputId, ok: true });
    await expect(pendingWithoutOutput).resolves.toEqual({ ok: true, output: undefined });
    expect(getPendingIds(host)).toEqual([]);
  });
});
