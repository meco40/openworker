import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteMasterRepository } from '@/server/master/sqliteMasterRepository';
import {
  decryptConnectorSecret,
  storeConnectorSecret,
} from '@/server/master/connectors/secretStore';
import {
  revokeConnectorSecret,
  rotateConnectorSecret,
} from '@/server/master/connectors/secretPolicies';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

function uniqueDbPath(): string {
  return path.join(
    getTestArtifactsRoot(),
    `master.secret.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('master connector secret lifecycle', () => {
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

  it('stores encrypted secret, rotates, revokes and keeps plaintext out of storage', () => {
    const dbPath = uniqueDbPath();
    cleanupFiles.push(dbPath);
    const repo = new SqliteMasterRepository(dbPath);
    const scope = { userId: 'user-1', workspaceId: 'ws-1' };

    storeConnectorSecret(repo, scope, {
      provider: 'gmail',
      keyRef: 'default',
      plainText: 'token-1',
    });
    const stored = repo.getConnectorSecret(scope, 'gmail', 'default');
    expect(stored).not.toBeNull();
    expect(stored?.encryptedPayload).not.toBe('token-1');
    expect(stored?.encryptedPayload.startsWith('enc:v2:')).toBe(true);
    expect(decryptConnectorSecret(stored!.encryptedPayload)).toBe('token-1');

    rotateConnectorSecret(repo, scope, {
      provider: 'gmail',
      keyRef: 'default',
      nextPlainText: 'token-2',
    });
    const rotated = repo.getConnectorSecret(scope, 'gmail', 'default');
    expect(decryptConnectorSecret(rotated!.encryptedPayload)).toBe('token-2');

    revokeConnectorSecret(repo, scope, { provider: 'gmail', keyRef: 'default' });
    const revoked = repo.getConnectorSecret(scope, 'gmail', 'default');
    expect(revoked?.revokedAt).not.toBeNull();
    const audit = repo.listAuditEvents(scope);
    expect(audit.some((event) => event.action === 'store')).toBe(true);
    expect(audit.some((event) => event.action === 'rotate')).toBe(true);
    expect(audit.some((event) => event.action === 'revoke')).toBe(true);

    repo.close();
  });
});
