/**
 * `/api/channels/messages` parity (S3): the `GET` listing shape.
 *
 * The TypeScript side drives `MessageService.listMessages`, the Rust side goes
 * over HTTP. Message *creation* (`POST /api/channels/messages`) is the chat
 * dispatch and still belongs to Next.js, so this family can only compare the
 * listing of conversations this family creates; both sides are empty there.
 * Volatile fields (ids) are normalised.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, rustRequest, bestEffortRemoveDir } from '../harness.mjs';

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

async function typescriptSide() {
  const dir = mkdtempSync(join(tmpdir(), 'betaclaw-parity-messages-'));
  process.env.MESSAGES_DB_PATH = join(dir, 'messages.db');
  const { SqliteMessageRepository } =
    await import('../../../../src/server/channels/messages/sqliteMessageRepository.ts');
  const { MessageService } = await import('../../../../src/server/channels/messages/service.ts');
  const { getPrincipalUserId } = await import('../../../../src/server/auth/principal.ts');

  const userId = getPrincipalUserId();
  const repo = new SqliteMessageRepository(process.env.MESSAGES_DB_PATH);
  const service = new MessageService(repo);

  const defaultConversation = service.getDefaultWebChatConversation(userId);
  const created = service.getOrCreateConversation(
    'WebChat',
    `manual-${userId}-messages`,
    TITLE,
    userId,
  );

  const result = {
    default: normListing({
      ok: true,
      conversationId: defaultConversation.id,
      messages: service.listMessages(defaultConversation.id, userId, 100),
    }),
    created: normListing({
      ok: true,
      conversationId: created.id,
      messages: service.listMessages(created.id, userId, 100),
    }),
    unknownConversation: normListing({
      ok: true,
      conversationId: 'parity-unknown-conversation',
      messages: service.listMessages('parity-unknown-conversation', userId, 100),
    }),
  };
  repo.close();
  bestEffortRemoveDir(dir);
  return result;
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
  const ts = await typescriptSide();
  const rust = await rustCollect();

  console.log('--- Default-Konversation ---');
  check('default ok', rust.default, ts.default);

  console.log('\n--- Angelegte Konversation ---');
  check('created ok', rust.created, ts.created);

  console.log('\n--- Unbekannte Konversation ---');
  check('unknown ok', rust.unknownConversation, ts.unknownConversation);
}
