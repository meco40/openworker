/**
 * `/api/channels/conversations` parity (S3): list, create, patch and delete.
 *
 * The TypeScript side drives the same `MessageService` the route delegates to,
 * in-process against a temporary database, and reproduces the response mapping
 * of `app/api/channels/conversations/route.ts`. The Rust side goes over HTTP.
 * Volatile fields (ids, timestamps, the manual external id) are normalised.
 *
 * The OP-1 remainder of `DELETE` (abort the in-flight generation, clear the
 * summary/recall state) lives in the Node process and has no Rust counterpart,
 * so it is not observable here.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, rustRequest, bestEffortRemoveDir } from '../harness.mjs';

export const name = 'conversations';

function normConversation(conversation) {
  return {
    channelType: conversation.channelType,
    title: conversation.title,
    modelOverride: conversation.modelOverride ?? null,
    personaId: conversation.personaId ?? null,
    externalChatIdIsManual:
      typeof conversation.externalChatId === 'string' &&
      conversation.externalChatId.startsWith('manual-'),
    hasId: typeof conversation.id === 'string' && conversation.id.length > 0,
    hasTimestamps:
      typeof conversation.createdAt === 'string' && typeof conversation.updatedAt === 'string',
  };
}

function normalizePersonaId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** The response mapping of `app/api/channels/conversations/route.ts`. */
async function typescriptSide() {
  const dir = mkdtempSync(join(tmpdir(), 'betaclaw-parity-conversations-'));
  process.env.MESSAGES_DB_PATH = join(dir, 'messages.db');
  const { SqliteMessageRepository } =
    await import('../../../../src/server/channels/messages/sqliteMessageRepository.ts');
  const { MessageService } = await import('../../../../src/server/channels/messages/service.ts');
  const { getPrincipalUserId } = await import('../../../../src/server/auth/principal.ts');

  const userId = getPrincipalUserId();
  const repo = new SqliteMessageRepository(process.env.MESSAGES_DB_PATH);
  const service = new MessageService(repo);

  // GET creates the default WebChat conversation as a side effect.
  const defaultConversation = service.getDefaultWebChatConversation(userId);
  const initialList = service.listConversations(userId);

  const created = service.getOrCreateConversation(
    'WebChat',
    `manual-${userId}-parity`,
    'Notes',
    userId,
  );

  // PATCH binds a persona, then rejects a different one with 409.
  service.setModelOverride(created.id, 'parity-model', userId);
  service.setPersonaId(created.id, 'persona-parity-a', userId);
  const bound = service.getConversation(created.id, userId);
  const currentPersonaId = normalizePersonaId(bound?.personaId);
  const requestedPersonaId = normalizePersonaId('persona-parity-b');
  const mismatchStatus = currentPersonaId && currentPersonaId !== requestedPersonaId ? 409 : 200;

  const deleted = service.deleteConversation(created.id, userId);
  const missingIdStatus = 400;

  const result = {
    initialHasDefault: Boolean(defaultConversation?.id),
    initialOk: Array.isArray(initialList) && initialList.length >= 1,
    createdStatus: 200,
    created: normConversation(created),
    patchStatus: 200,
    mismatchStatus,
    deleted,
    missingIdStatus,
    missingIdError: 'id query param is required',
  };
  repo.close();
  bestEffortRemoveDir(dir);
  return result;
}

async function rustCollect() {
  const createResponse = await rustRequest('POST', '/api/channels/conversations', {
    body: { channelType: 'WebChat', title: 'Notes' },
  });
  const created = createResponse.json?.conversation ?? {};
  const id = created.id;

  const patch = await rustRequest('PATCH', '/api/channels/conversations', {
    body: { conversationId: id, modelOverride: 'parity-model' },
  });
  await rustRequest('PATCH', '/api/channels/conversations', {
    body: { conversationId: id, personaId: 'persona-parity-a' },
  });
  const mismatch = await rustRequest('PATCH', '/api/channels/conversations', {
    body: { conversationId: id, personaId: 'persona-parity-b' },
  });

  const deleted = await rustRequest('DELETE', `/api/channels/conversations?id=${id}`);
  const missingId = await rustRequest('DELETE', '/api/channels/conversations');

  return {
    createdStatus: createResponse.status,
    created: normConversation(created),
    patchStatus: patch.status,
    mismatchStatus: mismatch.status,
    deleted: deleted.status === 200 && deleted.json?.ok === true,
    missingIdStatus: missingId.status,
    missingIdError: missingId.json?.error,
  };
}

export async function run() {
  const ts = await typescriptSide();
  const rust = await rustCollect();

  console.log('--- POST ---');
  check('POST status', rust.createdStatus, ts.createdStatus);
  check('POST conversation', rust.created, ts.created);

  console.log('\n--- PATCH ---');
  check('PATCH status', rust.patchStatus, ts.patchStatus);
  check('personaId mismatch', rust.mismatchStatus, ts.mismatchStatus);

  console.log('\n--- DELETE ---');
  check('DELETE ok', rust.deleted, ts.deleted);
  check('DELETE ohne id status', rust.missingIdStatus, ts.missingIdStatus);
  check('DELETE ohne id Fehler', rust.missingIdError, ts.missingIdError);
}
