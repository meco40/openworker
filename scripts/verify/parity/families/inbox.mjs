/**
 * `/api/channels/inbox` parity (S3): the v2 page shape and the deprecated v1
 * shape.
 *
 * The reference is `golden/inbox.json`, recorded from the TypeScript route before its
 * removal; the Rust side goes over HTTP. Items are filtered to the conversations this family creates, so a
 * long-lived gateway with leftover conversations does not break the comparison.
 * Volatile fields (ids, timestamps) are normalised.
 *
 * `resync` only feeds the observability counters/logs (OP-2) and changes no
 * response, so it is not part of the comparison.
 */
import { check, goldenReference, rustRequest } from '../harness.mjs';

export const name = 'inbox';

// A per-run marker keeps the family idempotent on a long-lived gateway: only the
// conversations this run creates are compared, never leftovers of an earlier run.
const RUN_TAG = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TITLE_PREFIX = `Parity Inbox ${RUN_TAG}`;
const SEEDS = [`${TITLE_PREFIX} A`, `${TITLE_PREFIX} B`];

function normItem(item) {
  return {
    channelType: item.channelType,
    // The run tag is volatile like an id: the golden reference was recorded with another one.
    title: item.title.replace(TITLE_PREFIX, 'Parity Inbox <run>'),
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

/** The response shape of the route. */
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
  const ts = await goldenReference(name, 'typescript');
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
