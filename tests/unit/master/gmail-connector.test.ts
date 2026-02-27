import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteMasterRepository } from '@/server/master/sqliteMasterRepository';
import { storeConnectorSecret } from '@/server/master/connectors/secretStore';
import { executeGmailAction } from '@/server/master/connectors/gmail/actions';
import { resetGmailClientState } from '@/server/master/connectors/gmail/client';

function uniqueDbPath(): string {
  return path.join(
    process.cwd(),
    '.local',
    `master.gmail.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('gmail connector', () => {
  const cleanupFiles: string[] = [];

  afterEach(() => {
    resetGmailClientState();
    for (const filePath of cleanupFiles.splice(0, cleanupFiles.length)) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // ignore sqlite lock on windows
      }
    }
  });

  it('supports read/search/draft and enforces approval+idempotency for send', async () => {
    const dbPath = uniqueDbPath();
    cleanupFiles.push(dbPath);
    const repo = new SqliteMasterRepository(dbPath);
    const scope = { userId: 'user-1', workspaceId: 'ws-1' };

    storeConnectorSecret(repo, scope, {
      provider: 'gmail',
      keyRef: 'default',
      plainText: 'access-token',
    });

    const read = await executeGmailAction(repo, {
      scope,
      runId: 'run-1',
      stepId: 'step-1',
      action: 'read',
    });
    expect(read.ok).toBe(true);

    const draft = await executeGmailAction(repo, {
      scope,
      runId: 'run-1',
      stepId: 'step-2',
      action: 'draft',
      draft: { to: 'a@b.c', subject: 'Hi', body: 'Text' },
    });
    expect(draft.ok).toBe(true);

    const sendNeedsApproval = await executeGmailAction(repo, {
      scope,
      runId: 'run-1',
      stepId: 'step-3',
      action: 'send',
      draft: { to: 'a@b.c', subject: 'Hi', body: 'Text' },
    });
    expect(sendNeedsApproval.approvalRequired).toBe(true);

    const sendFirst = await executeGmailAction(repo, {
      scope,
      runId: 'run-1',
      stepId: 'step-3',
      action: 'send',
      decision: 'approve_once',
      draft: { to: 'a@b.c', subject: 'Hi', body: 'Text' },
    });
    const sendSecond = await executeGmailAction(repo, {
      scope,
      runId: 'run-1',
      stepId: 'step-3',
      action: 'send',
      decision: 'approve_once',
      draft: { to: 'a@b.c', subject: 'Hi', body: 'Text' },
    });
    expect(sendFirst.ok).toBe(true);
    expect(sendSecond.ok).toBe(true);
    expect(sendFirst.result).toStrictEqual(sendSecond.result);

    const search = await executeGmailAction(repo, {
      scope,
      runId: 'run-1',
      stepId: 'step-4',
      action: 'search',
      query: 'Hi',
    });
    expect(search.ok).toBe(true);

    repo.close();
  });
});
