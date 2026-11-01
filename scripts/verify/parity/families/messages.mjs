/**
 * `/api/channels/messages` parity (S3): the `GET` listing shape.
 *
 * The reference is `golden/messages.json`, recorded from the TypeScript route before its
 * removal; the Rust side goes over HTTP. Message *creation* (`POST /api/channels/messages`) is the chat
 * dispatch and still belongs to Next.js, so this family can only compare the
 * listing of conversations this family creates; both sides are empty there.
 * Volatile fields (ids) are normalised.
 */
import { check, goldenReference, rustRequest } from '../harness.mjs';

export const name = 'messages';

const TITLE = 'Parity Messages';

function normMessage(message) {
  return {
    role: message.role,
    content: message.content,
    platform: message.platform,
    hasId: typeof message.id === 'string' && message.id.length > 0,
    hasCreatedAt: typeof message.createdAt === 'string',
  };
}

function normListing(body) {
  return {
    ok: body.ok,
    hasConversationId: typeof body.conversationId === 'string' && body.conversationId.length > 0,
    messages: (body.messages ?? []).map(normMessage),
  };
}

async function rustCollect() {
  const createResponse = await rustRequest('POST', '/api/channels/conversations', {
    body: { channelType: 'WebChat', title: TITLE },
  });
  const createdId = createResponse.json?.conversation?.id ?? '';

  const defaultResponse = await rustRequest('GET', '/api/channels/messages?limit=100');
  const createdResponse = await rustRequest(
    'GET',
    `/api/channels/messages?limit=100&conversationId=${createdId}`,
  );
  const unknownResponse = await rustRequest(
    'GET',
    '/api/channels/messages?limit=100&conversationId=parity-unknown-conversation',
  );

  return {
    default: normListing(defaultResponse.json ?? {}),
    created: normListing(createdResponse.json ?? {}),
    unknownConversation: normListing(unknownResponse.json ?? {}),
  };
}

export async function run() {
  const ts = await goldenReference(name, 'typescript');
  const rust = await rustCollect();

  console.log('--- Default-Konversation ---');
  check('default ok', rust.default, ts.default);

  console.log('\n--- Angelegte Konversation ---');
  check('created ok', rust.created, ts.created);

  console.log('\n--- Unbekannte Konversation ---');
  check('unknown ok', rust.unknownConversation, ts.unknownConversation);
}
