import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storeConnectorSecret } from '@/server/master/connectors/secretStore';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

type MasterGlobals = typeof globalThis & {
  __masterRepository?: unknown;
};

describe('master gmail route', () => {
  const cleanupPaths: string[] = [];
  let prevMasterDb: string | undefined;
  let prevPersonasDb: string | undefined;
  let prevPersonasRoot: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    prevMasterDb = process.env.MASTER_DB_PATH;
    prevPersonasDb = process.env.PERSONAS_DB_PATH;
    prevPersonasRoot = process.env.PERSONAS_ROOT_PATH;

    const masterDb = path.resolve(
      getTestArtifactsRoot(),
      `master.gmail.route.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    const personasDb = path.resolve(
      getTestArtifactsRoot(),
      `master.gmail.personas.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    const personasRoot = path.resolve(
      getTestArtifactsRoot(),
      `master.gmail.personas.root.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    );

    process.env.MASTER_DB_PATH = masterDb;
    process.env.PERSONAS_DB_PATH = personasDb;
    process.env.PERSONAS_ROOT_PATH = personasRoot;
    cleanupPaths.push(masterDb, personasDb, personasRoot);
    (globalThis as MasterGlobals).__masterRepository = undefined;
  });

  afterEach(async () => {
    if (prevMasterDb === undefined) delete process.env.MASTER_DB_PATH;
    else process.env.MASTER_DB_PATH = prevMasterDb;
    if (prevPersonasDb === undefined) delete process.env.PERSONAS_DB_PATH;
    else process.env.PERSONAS_DB_PATH = prevPersonasDb;
    if (prevPersonasRoot === undefined) delete process.env.PERSONAS_ROOT_PATH;
    else process.env.PERSONAS_ROOT_PATH = prevPersonasRoot;

    try {
      const runtime = await import('@/server/master/runtime');
      runtime.resetMasterRepositoryForTests();
    } catch {
      // ignore
    }
    (globalThis as MasterGlobals).__masterRepository = undefined;
    for (const target of cleanupPaths.splice(0, cleanupPaths.length)) {
      if (!fs.existsSync(target)) continue;
      try {
        const stat = fs.statSync(target);
        if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
        else fs.unlinkSync(target);
      } catch {
        // ignore sqlite lock
      }
    }
  });

  it('requires approval for send and succeeds with explicit decision', async () => {
    const { getPersonaRepository } = await import('@/server/personas/personaRepository');
    const { getMasterRepository } = await import('@/server/master/runtime');
    const route = await import('../../../app/api/master/gmail/route');
    const persona = getPersonaRepository().createPersona({
      userId: 'legacy-local-user',
      name: 'Mail Persona',
      emoji: 'M',
      vibe: 'precise',
    });
    const scope = {
      userId: 'legacy-local-user',
      workspaceId: `persona:${persona.id}:w1`,
    };
    storeConnectorSecret(getMasterRepository(), scope, {
      provider: 'gmail',
      keyRef: 'default',
      plainText: 'access-token',
    });

    const needsApproval = await route.POST(
      new Request('http://localhost/api/master/gmail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          personaId: persona.id,
          workspaceId: 'w1',
          runId: 'run-1',
          stepId: 'step-1',
          action: 'send',
          draft: { to: 'x@y.z', subject: 'A', body: 'B' },
        }),
      }),
    );
    expect(needsApproval.status).toBe(202);

    const approved = await route.POST(
      new Request('http://localhost/api/master/gmail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          personaId: persona.id,
          workspaceId: 'w1',
          runId: 'run-1',
          stepId: 'step-1',
          action: 'send',
          decision: 'approve_once',
          draft: { to: 'x@y.z', subject: 'A', body: 'B' },
        }),
      }),
    );
    expect(approved.status).toBe(200);
  });

  it('supports connector bootstrap and revoke flow', async () => {
    const { getPersonaRepository } = await import('@/server/personas/personaRepository');
    const { getMasterRepository } = await import('@/server/master/runtime');
    const { resolveMasterWorkspaceScope } = await import('@/server/master/workspaceScope');
    const route = await import('../../../app/api/master/gmail/route');
    const persona = getPersonaRepository().createPersona({
      userId: 'legacy-local-user',
      name: 'Mail Bootstrap Persona',
      emoji: 'B',
      vibe: 'precise',
    });

    const connect = await route.POST(
      new Request('http://localhost/api/master/gmail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          personaId: persona.id,
          workspaceId: 'w2',
          action: 'connect',
          accessToken: 'access-token',
          keyRef: 'default',
        }),
      }),
    );
    expect(connect.status).toBe(200);

    const scope = resolveMasterWorkspaceScope({
      userId: 'legacy-local-user',
      personaId: persona.id,
      workspaceId: 'w2',
    });
    const stored = getMasterRepository().getConnectorSecret(scope, 'gmail', 'default');
    expect(stored).not.toBeNull();

    const revoke = await route.POST(
      new Request('http://localhost/api/master/gmail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          personaId: persona.id,
          workspaceId: 'w2',
          action: 'revoke',
          keyRef: 'default',
        }),
      }),
    );
    expect(revoke.status).toBe(200);
    const revoked = getMasterRepository().getConnectorSecret(scope, 'gmail', 'default');
    expect(revoked?.revokedAt).not.toBeNull();
  });
});
