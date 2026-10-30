/**
 * `/api/channels/inbox` parity (S3): the v2 page shape and the deprecated v1
 * shape.
 *
 * The TypeScript side drives the same `MessageService.listInbox` the route
 * delegates to and maps it through the `contract.ts` helpers; the Rust side goes
 * over HTTP. Items are filtered to the conversations this family creates, so a
 * long-lived gateway with leftover conversations does not break the comparison.
 * Volatile fields (ids, timestamps) are normalised.
 *
 * `resync` only feeds the observability counters/logs (OP-2) and changes no
 * response, so it is not part of the comparison.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, rustRequest, bestEffortRemoveDir } from '../harness.mjs';

export const name = 'inbox';

// A per-run marker keeps the family idempotent on a long-lived gateway: only the
// conversations this run creates are compared, never leftovers of an earlier run.
const RUN_TAG = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TITLE_PREFIX = `Parity Inbox ${RUN_TAG}`;
const SEEDS = [`${TITLE_PREFIX} A`, `${TITLE_PREFIX} B`];

function normItem(item) {
  return {
    channelType: item.channelType,
    title: item.title,
    hasConversationId: typeof item.conversationId === 'string' && item.conversationId.length > 0,
    hasUpdatedAt: typeof item.updatedAt === 'string' && item.updatedAt.length > 0,
    lastMessage: item.lastMessage
      ? {
          role: item.lastMessage.role,
          content: item.lastMessage.content,
          platform: item.lastMessage.platform,
          hasId: typeof item.lastMessage.id === 'string',
          hasCreatedAt: typeof item.lastMessage.createdAt === 'string',
        }
      : null,
  };
}

function normItems(items) {
  return items
    .filter((item) => typeof item.title === 'string' && item.title.startsWith(TITLE_PREFIX))
    .map(normItem)
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** The response mapping of `app/api/channels/inbox/route.ts`. */
async function typescriptSide() {
  const dir = mkdtempSync(join(tmpdir(), 'betaclaw-parity-inbox-'));
  process.env.MESSAGES_DB_PATH = join(dir, 'messages.db');
  const { SqliteMessageRepository } =
    await import('../../../../src/server/channels/messages/sqliteMessageRepository.ts');
  const { MessageService } = await import('../../../../src/server/channels/messages/service.ts');
  const { getPrincipalUserId } = await import('../../../../src/server/auth/principal.ts');
  const { toInboxV1Response, toInboxV2Response } =
    await import('../../../../src/server/channels/inbox/contract.ts');

  const userId = getPrincipalUserId();
  const repo = new SqliteMessageRepository(process.env.MESSAGES_DB_PATH);
  const service = new MessageService(repo);
  SEEDS.forEach((title, index) => {
    service.getOrCreateConversation('WebChat', `manual-${userId}-inbox-${index}`, title, userId);
  });

  const v2 = toInboxV2Response(service.listInbox({ userId, limit: 100 }));
  const v1 = toInboxV1Response(service.listInbox({ userId, limit: 100 }));

  const result = {
    v2: {
      ok: v2.ok,
      items: normItems(v2.items),
      limit: v2.page.limit,
      hasMore: v2.page.hasMore,
      returned: normItems(v2.items).length,
    },
    v1: {
      ok: v1.ok,
      items: normItems(v1.items),
      nextCursor: v1.nextCursor,
    },
  };
  repo.close();
  bestEffortRemoveDir(dir);
  return result;
}

async function rustCollect() {
  for (const [index, title] of SEEDS.entries()) {
    await rustRequest('POST', '/api/channels/conversations', {
      body: { channelType: 'WebChat', title, externalChatId: `parity-inbox-${index}` },
    });
  }

  const v2 = await rustRequest('GET', '/api/channels/inbox?limit=100');
  const v1 = await rustRequest('GET', '/api/channels/inbox?limit=100&version=1');

  const v2Items = normItems(v2.json?.items ?? []);
  return {
    v2: {
      ok: v2.json?.ok,
      items: v2Items,
      limit: v2.json?.page?.limit,
      hasMore: v2.json?.page?.hasMore,
      returned: v2Items.length,
    },
    v1: {
      ok: v1.json?.ok,
      items: normItems(v1.json?.items ?? []),
      nextCursor: v1.json?.nextCursor ?? null,
    },
  };
}

export async function run() {
  const ts = await typescriptSide();
  const rust = await rustCollect();

  console.log('--- v2 ---');
  check('v2 ok', rust.v2.ok, ts.v2.ok);
  check('v2 items', rust.v2.items, ts.v2.items);
  check('v2 limit', rust.v2.limit, ts.v2.limit);
  check('v2 hasMore', rust.v2.hasMore, ts.v2.hasMore);
  check('v2 returned (gefiltert)', rust.v2.returned, ts.v2.returned);

  console.log('\n--- v1 (deprecated) ---');
  check('v1 ok', rust.v1.ok, ts.v1.ok);
  check('v1 items', rust.v1.items, ts.v1.items);
  check('v1 nextCursor', rust.v1.nextCursor, ts.v1.nextCursor);
}
