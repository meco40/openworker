import type { MasterRepository } from '@/server/master/repository';
import type { ApprovalDecision, WorkspaceScope } from '@/server/master/types';
import { buildIdempotencyKey } from '@/server/master/execution/idempotency';
import { MasterActionLedgerService } from '@/server/master/execution/actionLedger';
import { GmailClient } from '@/server/master/connectors/gmail/client';
import { loadGmailOAuthState } from '@/server/master/connectors/gmail/oauth';
import type { GmailDraftInput } from '@/server/master/connectors/gmail/types';

export type GmailAction = 'read' | 'search' | 'draft' | 'send';

export async function executeGmailAction(
  repo: MasterRepository,
  input: {
    scope: WorkspaceScope;
    runId: string;
    stepId: string;
    action: GmailAction;
    query?: string;
    draft?: GmailDraftInput;
    decision?: ApprovalDecision;
    fingerprint?: string;
  },
): Promise<{ ok: boolean; approvalRequired?: boolean; result?: unknown; error?: string }> {
  const oauth = loadGmailOAuthState(repo, input.scope);
  if (!oauth) {
    return { ok: false, error: 'Gmail connector is not configured.' };
  }
  const client = new GmailClient(oauth.accessToken);
  const mailboxKey = `${input.scope.userId}:${input.scope.workspaceId}`;

  if (input.action === 'read') {
    return { ok: true, result: client.listMessages(mailboxKey) };
  }
  if (input.action === 'search') {
    return { ok: true, result: client.searchMessages(mailboxKey, input.query || '') };
  }
  if (input.action === 'draft') {
    if (!input.draft) return { ok: false, error: 'draft payload is required' };
    return { ok: true, result: client.createDraft(input.draft) };
  }

  // send is always approval-gated
  const decision = input.decision;
  if (!decision) {
    return { ok: false, approvalRequired: true, error: 'Approval required for gmail.send' };
  }
  if (decision === 'deny') {
    return { ok: false, error: 'Action denied by operator.' };
  }
  if (!input.draft) return { ok: false, error: 'draft payload is required' };

  if (decision === 'approve_always') {
    repo.upsertApprovalRule(
      input.scope,
      'gmail.send',
      input.fingerprint || `${input.draft.to}:${input.draft.subject}`,
      'approve_always',
    );
  }

  const idempotencyKey = buildIdempotencyKey({
    runId: input.runId,
    stepId: input.stepId,
    actionType: 'gmail.send',
    actionPayload: JSON.stringify(input.draft),
  });
  const ledger = new MasterActionLedgerService(repo);
  const executed = await ledger.executeExactlyOnce({
    scope: input.scope,
    runId: input.runId,
    stepId: input.stepId,
    actionType: 'gmail.send',
    idempotencyKey,
    execute: async () => client.sendMessage(mailboxKey, input.draft!),
  });
  return { ok: true, result: executed.result };
}
