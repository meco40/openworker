/**
 * `/api/channels/conversations` parity (S3): list, create, patch and delete.
 *
 * The reference is `golden/conversations.json`, recorded from the TypeScript route
 * handler before its removal. The Rust side goes over HTTP.
 * Volatile fields (ids, timestamps, the manual external id) are normalised.
 *
 * The OP-1 remainder of `DELETE` (abort the in-flight generation, clear the
 * summary/recall state) lives in the Node process and has no Rust counterpart,
 * so it is not observable here.
 */
import { check, goldenReference, rustRequest } from '../harness.mjs';

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

/** The response shape of the route. */
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
  const ts = await goldenReference(name, 'typescript');
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
