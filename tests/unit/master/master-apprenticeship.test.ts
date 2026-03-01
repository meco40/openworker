import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteMasterRepository } from '@/server/master/repository/sqliteMasterRepository';
import { createCapabilityApprenticeshipProposal } from '@/server/master/capabilities/apprenticeship';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

function uniqueDbPath(): string {
  return path.join(
    getTestArtifactsRoot(),
    `master.apprenticeship.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('master apprenticeship', () => {
  const cleanupFiles: string[] = [];

  afterEach(() => {
    for (const filePath of cleanupFiles.splice(0, cleanupFiles.length)) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // ignore sqlite lock on windows
      }
    }
  });

  it('creates proposal including official API/auth/scopes/rate limits and fallback', () => {
    const dbPath = uniqueDbPath();
    cleanupFiles.push(dbPath);
    const repo = new SqliteMasterRepository(dbPath);
    const scope = { userId: 'user-1', workspaceId: 'ws-1' };

    const proposal = createCapabilityApprenticeshipProposal(repo, scope, {
      capability: 'new_platform',
      reason: 'customer demand',
      apiReference: 'https://api.example.com/docs',
      authModel: 'oauth2',
      scopes: ['read', 'write'],
      rateLimit: '100/min',
      fallbackPlan: 'manual sync',
    });

    expect(proposal.status).toBe('awaiting_approval');
    expect(proposal.proposal).toContain('Official API: https://api.example.com/docs');
    expect(proposal.proposal).toContain('Auth Model: oauth2');
    expect(proposal.proposal).toContain('Scopes: read, write');
    expect(proposal.fallbackPlan).toBe('manual sync');

    repo.close();
  });
});
