import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentV2Repository } from '@/server/agent-v2/repository';
import { AgentV2Error } from '@/server/agent-v2/errors';
import type {
  AgentV2SigningKeyRecord,
  ExtensionManifestV1,
  LifecycleHookContext,
  LifecycleHookStage,
} from '@/server/agent-v2/types';

type MockWorker = {
  manifest: ExtensionManifestV1;
  stop: () => void;
  runHook: (
    stage: LifecycleHookStage,
    context: LifecycleHookContext,
    timeoutMs: number,
  ) => Promise<{
    ok: boolean;
    error?: string;
  }>;
};

const workerHarness = vi.hoisted(() => ({ instances: [] as MockWorker[] }));

vi.mock('@/server/agent-v2/extensions/workerHost', () => ({
  ExtensionWorkerHost: class {
    readonly stop = vi.fn<MockProcedure>();
    readonly runHook = vi.fn<() => Promise<{ ok: boolean }>>(async () => ({ ok: true }));

    constructor(readonly manifest: ExtensionManifestV1) {
      workerHarness.instances.push(this as unknown as MockWorker);
    }
  },
}));

import { AgentV2ExtensionHost } from '@/server/agent-v2/extensions/host';
import type { MockProcedure } from '../../helpers/mockProcedure';

const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
const signingKey: AgentV2SigningKeyRecord = {
  keyId: 'test-key',
  algorithm: 'rsa-sha256',
  publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  status: 'active',
  createdAt: '2026-10-08T00:00:00.000Z',
  rotatedAt: null,
  revokedAt: null,
};

function signedManifest(overrides: Partial<ExtensionManifestV1> = {}): ExtensionManifestV1 {
  const manifest: ExtensionManifestV1 = {
    schemaVersion: '1',
    id: 'test-extension',
    version: '1.0.0',
    name: 'Test extension',
    description: 'Host test fixture',
    author: 'tests',
    digest: '',
    keyId: signingKey.keyId,
    signature: '',
    modulePath: '/tmp/test-extension.mjs',
    hookStages: ['session.before_start'],
    ...overrides,
  };
  const canonical = JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    version: manifest.version,
    keyId: manifest.keyId,
    modulePath: manifest.modulePath,
    hookStages: [...manifest.hookStages].sort(),
    failClosedStages: [...(manifest.failClosedStages || [])].sort(),
    timeoutMs: manifest.timeoutMs ?? null,
  });
  manifest.digest = crypto.createHash('sha256').update(canonical).digest('hex');
  manifest.signature = crypto
    .sign('sha256', Buffer.from(canonical), keyPair.privateKey)
    .toString('base64');
  return manifest;
}

function createRepository(manifests: ExtensionManifestV1[] = []) {
  return {
    manifests,
    signingKeys: [signingKey],
    revoked: new Set<string>(),
    listSigningKeys: vi.fn<MockProcedure>(function (this: ReturnType<typeof createRepository>) {
      return this.signingKeys;
    }),
    listRevokedSignatureDigests: vi.fn<MockProcedure>(function (
      this: ReturnType<typeof createRepository>,
    ) {
      return this.revoked;
    }),
    listEnabledExtensionManifests: vi.fn<MockProcedure>(function (
      this: ReturnType<typeof createRepository>,
    ) {
      return this.manifests;
    }),
  };
}

function allowlist(...manifests: ExtensionManifestV1[]) {
  process.env.AGENT_V2_EXTENSION_ALLOWLIST = manifests
    .map((manifest) => `${manifest.id}@${manifest.version}@${manifest.digest}`)
    .join(',');
}

function workerFor(id: string): MockWorker {
  const worker = workerHarness.instances.find((instance) => instance.manifest.id === id);
  if (!worker) throw new Error(`Missing worker for ${id}`);
  return worker;
}

const hookContext = { stage: 'session.before_start' } as LifecycleHookContext;

describe('AgentV2ExtensionHost', () => {
  beforeEach(() => {
    workerHarness.instances.length = 0;
    delete process.env.AGENT_V2_EXTENSIONS_ENABLED;
    delete process.env.AGENT_V2_HOOK_TIMEOUT_MS;
    delete process.env.AGENT_V2_EXTENSION_ALLOWLIST;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AGENT_V2_EXTENSIONS_ENABLED;
    delete process.env.AGENT_V2_HOOK_TIMEOUT_MS;
    delete process.env.AGENT_V2_EXTENSION_ALLOWLIST;
  });

  it('loads each signed allowlisted extension once, runs matching hooks, and stops stale workers', async () => {
    const manifest = signedManifest({
      hookStages: ['session.before_start', 'session.after_start'],
    });
    allowlist(manifest);
    const repository = createRepository([manifest]);
    const host = new AgentV2ExtensionHost(repository as unknown as AgentV2Repository);

    host.refresh();
    host.refresh();

    expect(workerHarness.instances).toHaveLength(1);
    expect(repository.listSigningKeys).toHaveBeenCalledTimes(2);
    await expect(host.runHooks('session.before_start', hookContext)).resolves.toMatchObject([
      { ok: true, extensionId: manifest.id, policy: 'fail_open' },
    ]);
    expect(workerFor(manifest.id).runHook).toHaveBeenCalledWith(
      'session.before_start',
      hookContext,
      2_000,
    );
    await expect(host.runHooks('session.before_complete', hookContext)).resolves.toEqual([]);

    repository.manifests = [];
    host.refresh();
    expect(workerFor(manifest.id).stop).toHaveBeenCalledOnce();
    host.stopAll();
  });

  it('rejects invalid manifests and removes previously loaded extensions that fail validation', () => {
    const valid = signedManifest();
    allowlist(valid);
    const repository = createRepository([valid]);
    const host = new AgentV2ExtensionHost(repository as unknown as AgentV2Repository);
    host.refresh();
    const worker = workerFor(valid.id);

    const invalidDigest = { ...valid, id: 'invalid-digest', digest: 'bad-digest' };
    const inactiveKey = signedManifest({ id: 'inactive-key', keyId: 'inactive' });
    const revokedSignature = signedManifest({ id: 'revoked-signature' });
    const invalidSignature = { ...signedManifest({ id: 'invalid-signature' }), signature: 'bad' };
    allowlist(valid, invalidDigest, inactiveKey, revokedSignature, invalidSignature);
    repository.signingKeys.push({ ...signingKey, keyId: 'inactive', status: 'revoked' });
    repository.revoked.add(
      crypto.createHash('sha256').update(revokedSignature.signature).digest('hex'),
    );
    repository.manifests = [invalidDigest, inactiveKey, revokedSignature, invalidSignature];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    host.refresh();

    expect(warn).toHaveBeenCalledTimes(4);
    expect(worker.stop).toHaveBeenCalledOnce();
    expect(workerHarness.instances).toHaveLength(1);
  });

  it.each(['0', 'false', 'OFF'])('honors the disabled kill switch value %s', async (value) => {
    process.env.AGENT_V2_EXTENSIONS_ENABLED = value;
    const manifest = signedManifest();
    allowlist(manifest);
    const repository = createRepository([manifest]);
    const host = new AgentV2ExtensionHost(repository as unknown as AgentV2Repository);
    host.refresh();

    expect(workerHarness.instances).toHaveLength(0);
    await expect(host.runHooks('session.before_start', hookContext)).resolves.toEqual([]);
  });

  it.each([
    { timeoutMs: 10, expected: 50 },
    { timeoutMs: 5_000, expected: 5_000 },
    { timeoutMs: 80_000, expected: 60_000 },
  ])('clamps a manifest hook timeout to $expected ms', async ({ timeoutMs, expected }) => {
    const manifest = signedManifest({ timeoutMs });
    allowlist(manifest);
    const host = new AgentV2ExtensionHost(
      createRepository([manifest]) as unknown as AgentV2Repository,
    );
    host.refresh();

    await host.runHooks('session.before_start', hookContext);

    expect(workerFor(manifest.id).runHook).toHaveBeenCalledWith(
      'session.before_start',
      hookContext,
      expected,
    );
  });

  it.each([
    { timeout: 'n/a', expected: 2_000 },
    { timeout: '-1', expected: 2_000 },
    { timeout: '25', expected: 50 },
    { timeout: '90000', expected: 60_000 },
  ])('uses the clamped environment timeout for $timeout', async ({ timeout, expected }) => {
    process.env.AGENT_V2_HOOK_TIMEOUT_MS = timeout;
    const manifest = signedManifest();
    allowlist(manifest);
    const host = new AgentV2ExtensionHost(
      createRepository([manifest]) as unknown as AgentV2Repository,
    );
    host.refresh();

    await host.runHooks('session.before_start', hookContext);

    expect(workerFor(manifest.id).runHook).toHaveBeenCalledWith(
      'session.before_start',
      hookContext,
      expected,
    );
  });

  it('returns a fail-open outcome when the extension hook fails', async () => {
    const failOpen = signedManifest({ id: 'fail-open' });
    allowlist(failOpen);
    const host = new AgentV2ExtensionHost(
      createRepository([failOpen]) as unknown as AgentV2Repository,
    );
    host.refresh();
    workerFor(failOpen.id).runHook = vi.fn<() => Promise<{ ok: boolean; error: string }>>(
      async () => ({ ok: false, error: 'offline' }),
    );

    await expect(host.runHooks('session.before_start', hookContext)).resolves.toMatchObject([
      { ok: false, extensionId: 'fail-open', error: 'offline', policy: 'fail_open' },
    ]);
  });

  it('throws an unavailable error when a fail-closed hook fails without an error message', async () => {
    const failClosed = signedManifest({
      id: 'fail-closed',
      failClosedStages: ['session.before_start'],
    });
    allowlist(failClosed);
    const host = new AgentV2ExtensionHost(
      createRepository([failClosed]) as unknown as AgentV2Repository,
    );
    host.refresh();
    workerFor(failClosed.id).runHook = vi.fn<() => Promise<{ ok: boolean; error: string }>>(
      async () => ({ ok: false, error: '' }),
    );

    await expect(host.runHooks('session.before_start', hookContext)).rejects.toMatchObject({
      name: 'AgentV2Error',
      code: 'UNAVAILABLE',
      message: 'Lifecycle hook failed in fail-closed mode (fail-closed): unknown error',
    } satisfies Partial<AgentV2Error>);
    expect(workerFor(failClosed.id).runHook).toHaveBeenCalledOnce();
  });
});
