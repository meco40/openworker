# Full Omnichannel Messaging System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a production-ready omnichannel messaging system with a unified inbox, shared routing, normalized channel adapters, and live Gateway updates across all supported messenger platforms.

**Architecture:** Keep the existing `MessageService` and Gateway as orchestration layers, then introduce a strict adapter/normalization layer between webhooks and message handling. Persist channel state and external identities in first-class tables so inbox, routing, and replay are deterministic. Expose omnichannel operations through REST and Gateway RPC so UI and external systems use one contract.

**Tech Stack:** Next.js 16, TypeScript, WebSocket Gateway (`ws`), Node SQLite (`node:sqlite`), Vitest.

---

I'm using the writing-plans skill to create the implementation plan.

**Assumptions**

- Existing channels (Telegram, WhatsApp, Discord, iMessage, WebChat) stay supported.
- Slack is added as first new adapter to validate extensibility.
- Existing APIs remain backward-compatible while new omnichannel endpoints are introduced.

### Task 1: Define Omnichannel Domain Contracts

**Files:**

- Create: `src/server/channels/adapters/types.ts`
- Create: `src/server/channels/adapters/capabilities.ts`
- Modify: `types.ts`
- Test: `tests/unit/channels/adapter-types.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  CHANNEL_CAPABILITIES,
  normalizeChannelKey,
} from '../../../src/server/channels/adapters/capabilities';

describe('channel adapter contracts', () => {
  it('normalizes known channel keys and exposes capabilities', () => {
    expect(normalizeChannelKey('telegram')).toBe('telegram');
    expect(CHANNEL_CAPABILITIES.telegram.supportsInbound).toBe(true);
    expect(CHANNEL_CAPABILITIES.webchat.supportsOutbound).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- tests/unit/channels/adapter-types.test.ts`  
Expected: FAIL with module not found for `adapters/capabilities`.

**Step 3: Write minimal implementation**

```ts
// src/server/channels/adapters/types.ts
export type ChannelKey = 'webchat' | 'telegram' | 'whatsapp' | 'discord' | 'imessage' | 'slack';
export interface ChannelCapabilities {
  supportsInbound: boolean;
  supportsOutbound: boolean;
  supportsPairing: boolean;
  supportsStreaming: boolean;
}
```

```ts
// src/server/channels/adapters/capabilities.ts
import type { ChannelCapabilities, ChannelKey } from './types';

export const CHANNEL_CAPABILITIES: Record<ChannelKey, ChannelCapabilities> = {
  webchat: {
    supportsInbound: true,
    supportsOutbound: false,
    supportsPairing: false,
    supportsStreaming: true,
  },
  telegram: {
    supportsInbound: true,
    supportsOutbound: true,
    supportsPairing: true,
    supportsStreaming: false,
  },
  whatsapp: {
    supportsInbound: true,
    supportsOutbound: true,
    supportsPairing: true,
    supportsStreaming: false,
  },
  discord: {
    supportsInbound: true,
    supportsOutbound: true,
    supportsPairing: true,
    supportsStreaming: false,
  },
  imessage: {
    supportsInbound: true,
    supportsOutbound: true,
    supportsPairing: true,
    supportsStreaming: false,
  },
  slack: {
    supportsInbound: true,
    supportsOutbound: true,
    supportsPairing: true,
    supportsStreaming: false,
  },
};

export function normalizeChannelKey(value: string): ChannelKey | null {
  const normalized = value.trim().toLowerCase();
  return normalized in CHANNEL_CAPABILITIES ? (normalized as ChannelKey) : null;
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test -- tests/unit/channels/adapter-types.test.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add types.ts src/server/channels/adapters/types.ts src/server/channels/adapters/capabilities.ts tests/unit/channels/adapter-types.test.ts
git commit -m "feat: add omnichannel adapter contracts and capabilities map"
```

### Task 2: Introduce Unified Inbound Message Envelope

**Files:**

- Create: `src/server/channels/inbound/envelope.ts`
- Create: `src/server/channels/inbound/normalizers.ts`
- Modify: `app/api/channels/telegram/webhook/route.ts`
- Modify: `app/api/channels/discord/webhook/route.ts`
- Modify: `app/api/channels/whatsapp/webhook/route.ts`
- Modify: `app/api/channels/imessage/webhook/route.ts`
- Test: `tests/unit/channels/inbound-normalizers.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { normalizeTelegramInbound } from '../../../src/server/channels/inbound/normalizers';

describe('inbound normalizers', () => {
  it('maps telegram webhook payload to unified envelope', () => {
    const env = normalizeTelegramInbound({
      message: { chat: { id: 7 }, text: 'hi', from: { username: 'max' }, message_id: 11 },
    });
    expect(env.channel).toBe('telegram');
    expect(env.externalChatId).toBe('7');
    expect(env.content).toBe('hi');
    expect(env.externalMessageId).toBe('11');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- tests/unit/channels/inbound-normalizers.test.ts`  
Expected: FAIL with missing normalizer exports.

**Step 3: Write minimal implementation**

```ts
// src/server/channels/inbound/envelope.ts
export interface InboundEnvelope {
  channel: 'telegram' | 'whatsapp' | 'discord' | 'imessage' | 'webchat' | 'slack';
  externalChatId: string;
  externalMessageId: string | null;
  senderName: string | null;
  content: string;
  receivedAt: string;
  raw: unknown;
}
```

Webhook routes should call a specific normalizer and forward the envelope to one shared ingress handler.

**Step 4: Run tests to verify it passes**

Run: `npm run test -- tests/unit/channels/inbound-normalizers.test.ts tests/unit/channels/webhook-parsing.test.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/channels/inbound/envelope.ts src/server/channels/inbound/normalizers.ts app/api/channels/telegram/webhook/route.ts app/api/channels/discord/webhook/route.ts app/api/channels/whatsapp/webhook/route.ts app/api/channels/imessage/webhook/route.ts tests/unit/channels/inbound-normalizers.test.ts
git commit -m "feat: normalize inbound webhooks into unified envelope"
```

### Task 3: Add Adapter Registry and Shared Channel Router

**Files:**

- Create: `src/server/channels/routing/adapterRegistry.ts`
- Create: `src/server/channels/routing/inboundRouter.ts`
- Create: `src/server/channels/routing/outboundRouter.ts`
- Modify: `src/server/channels/outbound/router.ts`
- Modify: `src/server/channels/messages/service.ts`
- Test: `tests/unit/channels/adapter-registry.test.ts`
- Test: `tests/unit/channels/routing.test.ts`

**Step 1: Write the failing tests**

```ts
it('routes outbound delivery through registered adapter', async () => {
  const called: string[] = [];
  registerAdapter({ channel: 'telegram', send: async () => called.push('telegram') });
  await routeOutbound({ channel: 'telegram', externalChatId: 'c1', content: 'hello' });
  expect(called).toEqual(['telegram']);
});
```

**Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/unit/channels/adapter-registry.test.ts tests/unit/channels/routing.test.ts`  
Expected: FAIL with undefined registry/router functions.

**Step 3: Write minimal implementation**

Implement a typed registry:

- `registerAdapter(adapter)`
- `getAdapter(channel)`
- `routeInbound(envelope, ctx)`
- `routeOutbound(command)`

Then switch `MessageService` to call `routeOutbound` instead of direct `deliverOutbound`.

**Step 4: Run tests to verify pass**

Run: `npm run test -- tests/unit/channels/adapter-registry.test.ts tests/unit/channels/routing.test.ts tests/unit/channels/message-service-summary.test.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/channels/routing/adapterRegistry.ts src/server/channels/routing/inboundRouter.ts src/server/channels/routing/outboundRouter.ts src/server/channels/outbound/router.ts src/server/channels/messages/service.ts tests/unit/channels/adapter-registry.test.ts tests/unit/channels/routing.test.ts
git commit -m "refactor: route channel traffic through adapter registry"
```

### Task 4: Persist Channel Bindings and External Participants

**Files:**

- Modify: `src/server/channels/messages/repository.ts`
- Modify: `src/server/channels/messages/sqliteMessageRepository.ts`
- Create: `src/server/channels/messages/channelBindings.ts`
- Test: `tests/unit/channels/channel-bindings-repository.test.ts`
- Test: `tests/unit/channels/message-repository-migration.test.ts`

**Step 1: Write failing migration test**

```ts
it('creates channel_bindings table and stores per-user channel config', () => {
  const repo = new SqliteMessageRepository(':memory:');
  repo.upsertChannelBinding({
    userId: 'u1',
    channel: 'telegram',
    status: 'connected',
    externalPeerId: 'chat-1',
  });
  const rows = repo.listChannelBindings('u1');
  expect(rows[0].channel).toBe('telegram');
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- tests/unit/channels/channel-bindings-repository.test.ts`  
Expected: FAIL with missing repository methods/table.

**Step 3: Write minimal implementation**

Add DB tables:

- `channel_bindings`
- `channel_participants`

Expose repository methods:

- `upsertChannelBinding`
- `listChannelBindings`
- `touchChannelLastSeen`

**Step 4: Run tests to verify pass**

Run: `npm run test -- tests/unit/channels/channel-bindings-repository.test.ts tests/unit/channels/message-repository-migration.test.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/channels/messages/repository.ts src/server/channels/messages/sqliteMessageRepository.ts src/server/channels/messages/channelBindings.ts tests/unit/channels/channel-bindings-repository.test.ts tests/unit/channels/message-repository-migration.test.ts
git commit -m "feat: persist omnichannel bindings and participant state"
```

### Task 5: Add Omnichannel REST APIs for Inbox and Channel State

**Files:**

- Create: `app/api/channels/state/route.ts`
- Create: `app/api/channels/inbox/route.ts`
- Modify: `app/api/channels/conversations/route.ts`
- Modify: `app/api/channels/messages/route.ts`
- Test: `tests/integration/channels/state-route.test.ts`
- Test: `tests/integration/channels/inbox-route.test.ts`

**Step 1: Write failing API tests**

```ts
it('returns channel state with capability + connection info', async () => {
  const { GET } = await import('../../../app/api/channels/state/route');
  const res = await GET();
  const json = await res.json();
  expect(json.ok).toBe(true);
  expect(Array.isArray(json.channels)).toBe(true);
});
```

**Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/integration/channels/state-route.test.ts tests/integration/channels/inbox-route.test.ts`  
Expected: FAIL with route modules not found.

**Step 3: Write minimal implementation**

Add:

- `GET /api/channels/state` for per-channel status/capabilities
- `GET /api/channels/inbox` with filters `channel`, `q`, `limit`, `cursor`

Keep old `/api/channels/conversations` and `/api/channels/messages` behavior unchanged.

**Step 4: Run tests to verify pass**

Run: `npm run test -- tests/integration/channels/state-route.test.ts tests/integration/channels/inbox-route.test.ts tests/integration/persistent-chat-session-v2.contract.test.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add app/api/channels/state/route.ts app/api/channels/inbox/route.ts app/api/channels/conversations/route.ts app/api/channels/messages/route.ts tests/integration/channels/state-route.test.ts tests/integration/channels/inbox-route.test.ts
git commit -m "feat: add omnichannel state and unified inbox routes"
```

### Task 6: Extend Gateway RPC for Omnichannel Operations

**Files:**

- Create: `src/server/gateway/methods/channels.ts`
- Modify: `src/server/gateway/index.ts`
- Modify: `src/server/gateway/events.ts`
- Modify: `src/modules/gateway/ws-client.ts`
- Test: `tests/unit/gateway/channels-methods.test.ts`
- Test: `tests/unit/gateway/gateway-contract.test.ts`

**Step 1: Write failing RPC tests**

```ts
it('responds to channels.list with omnichannel state', async () => {
  const out: unknown[] = [];
  await dispatchFrame({ type: 'req', id: '1', method: 'channels.list' }, mockClient('u1'), (f) =>
    out.push(f),
  );
  expect((out[0] as any).ok).toBe(true);
});
```

**Step 2: Run tests to verify fail**

Run: `npm run test -- tests/unit/gateway/channels-methods.test.ts`  
Expected: FAIL with unknown method `channels.list`.

**Step 3: Write minimal implementation**

Register new RPC methods:

- `channels.list`
- `channels.pair`
- `channels.unpair`
- `inbox.list`

Emit events:

- `channels.status`
- `inbox.updated`

**Step 4: Run tests to verify pass**

Run: `npm run test -- tests/unit/gateway/channels-methods.test.ts tests/unit/gateway/method-router.test.ts tests/unit/gateway/protocol.test.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/gateway/methods/channels.ts src/server/gateway/index.ts src/server/gateway/events.ts src/modules/gateway/ws-client.ts tests/unit/gateway/channels-methods.test.ts tests/unit/gateway/gateway-contract.test.ts
git commit -m "feat: expose omnichannel operations via gateway rpc"
```

### Task 7: Implement Slack Adapter End-to-End

**Files:**

- Create: `src/server/channels/pairing/slack.ts`
- Create: `src/server/channels/outbound/slack.ts`
- Create: `app/api/channels/slack/webhook/route.ts`
- Modify: `src/server/channels/pairing/index.ts`
- Modify: `src/server/channels/outbound/router.ts`
- Modify: `types.ts`
- Test: `tests/unit/channels/slack-pairing.test.ts`
- Test: `tests/unit/channels/slack-webhook-route.test.ts`

**Step 1: Write failing Slack tests**

```ts
it('pairs slack channel with bot token and stores credentials', async () => {
  await expect(pairChannel('slack', 'xoxb-token')).resolves.toMatchObject({ status: 'connected' });
});
```

**Step 2: Run tests to verify fail**

Run: `npm run test -- tests/unit/channels/slack-pairing.test.ts tests/unit/channels/slack-webhook-route.test.ts`  
Expected: FAIL because Slack is not supported by pairing/router.

**Step 3: Write minimal implementation**

Add Slack support through same adapter contracts:

- token validation via Slack auth endpoint
- webhook ingestion to unified envelope
- outbound reply via Slack `chat.postMessage`

**Step 4: Run tests to verify pass**

Run: `npm run test -- tests/unit/channels/slack-pairing.test.ts tests/unit/channels/slack-webhook-route.test.ts tests/integration/channels/pairing-router.test.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/channels/pairing/slack.ts src/server/channels/outbound/slack.ts app/api/channels/slack/webhook/route.ts src/server/channels/pairing/index.ts src/server/channels/outbound/router.ts types.ts tests/unit/channels/slack-pairing.test.ts tests/unit/channels/slack-webhook-route.test.ts
git commit -m "feat: add slack adapter to omnichannel stack"
```

### Task 8: Build Unified Inbox UX (Filter, Search, Channel Switch)

**Files:**

- Modify: `src/modules/app-shell/useConversationSync.ts`
- Modify: `components/ChatInterface.tsx`
- Modify: `src/modules/chat/components/ChatConversationList.tsx`
- Create: `src/modules/chat/components/InboxFilters.tsx`
- Modify: `src/modules/chat/hooks/useChatInterfaceState.ts`
- Test: `tests/unit/chat/unified-inbox-filters.test.tsx`
- Test: `tests/integration/react-best-practices-refactor.test.ts`

**Step 1: Write failing UI tests**

```tsx
it('filters conversation list by selected channel', async () => {
  render(<InboxFilters channels={['All', 'Telegram']} active="Telegram" onChange={onChange} />);
  expect(screen.getByRole('button', { name: 'Telegram' })).toHaveAttribute('aria-pressed', 'true');
});
```

**Step 2: Run tests to verify fail**

Run: `npm run test -- tests/unit/chat/unified-inbox-filters.test.tsx`  
Expected: FAIL with missing `InboxFilters`.

**Step 3: Write minimal implementation**

Add:

- channel chips (`All`, per platform)
- search input
- unread/updated sorting toggle

Back it with `/api/channels/inbox` query params.

**Step 4: Run tests to verify pass**

Run: `npm run test -- tests/unit/chat/unified-inbox-filters.test.tsx tests/unit/chat/chat-ui-utils.test.ts tests/unit/app-shell/runtime-logic.test.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/app-shell/useConversationSync.ts components/ChatInterface.tsx src/modules/chat/components/ChatConversationList.tsx src/modules/chat/components/InboxFilters.tsx src/modules/chat/hooks/useChatInterfaceState.ts tests/unit/chat/unified-inbox-filters.test.tsx
git commit -m "feat: add unified inbox filters and search"
```

### Task 9: Wire Pairing UI to Server-Backed Channel State

**Files:**

- Modify: `messenger/ChannelPairing.tsx`
- Modify: `src/modules/app-shell/useAppShellState.ts`
- Create: `src/modules/app-shell/useChannelStateSync.ts`
- Test: `tests/unit/app-shell/channel-state-sync.test.ts`
- Test: `tests/unit/channels/channels-pair-route.test.ts`

**Step 1: Write failing sync test**

```ts
it('hydrates coupled channels from /api/channels/state instead of local-only defaults', async () => {
  const state = await loadChannelState(fetchMock);
  expect(state.telegram.status).toBe('connected');
});
```

**Step 2: Run test to verify fail**

Run: `npm run test -- tests/unit/app-shell/channel-state-sync.test.ts`  
Expected: FAIL with missing hook/helper.

**Step 3: Write minimal implementation**

Implement `useChannelStateSync`:

- load initial state from API
- subscribe to `channels.status` Gateway events
- keep `ChannelPairing` UI in sync with server truth

**Step 4: Run tests to verify pass**

Run: `npm run test -- tests/unit/app-shell/channel-state-sync.test.ts tests/channels-pair-route.test.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add messenger/ChannelPairing.tsx src/modules/app-shell/useAppShellState.ts src/modules/app-shell/useChannelStateSync.ts tests/unit/app-shell/channel-state-sync.test.ts tests/channels-pair-route.test.ts
git commit -m "feat: sync pairing ui with persisted channel state"
```

### Task 10: Add Omnichannel Observability, Security, and Verification

**Files:**

- Modify: `src/server/channels/webhookAuth.ts`
- Modify: `src/server/telemetry/logService.ts`
- Modify: `app/api/security/status/route.ts`
- Create: `tests/integration/channels/omnichannel-security.contract.test.ts`
- Create: `tests/integration/channels/omnichannel-observability.contract.test.ts`
- Modify: `docs/GATEWAY_WEBSOCKET_INTEGRATION.md`
- Create: `docs/OMNICHANNEL_RUNBOOK.md`

**Step 1: Write failing integration tests**

```ts
it('reports per-channel webhook verification status in security route', async () => {
  const { GET } = await import('../../../app/api/security/status/route');
  const res = await GET();
  const json = await res.json();
  expect(json.channels).toBeDefined();
});
```

**Step 2: Run tests to verify fail**

Run: `npm run test -- tests/integration/channels/omnichannel-security.contract.test.ts tests/integration/channels/omnichannel-observability.contract.test.ts`  
Expected: FAIL with missing fields/events.

**Step 3: Write minimal implementation**

Add:

- per-channel security diagnostics (signature mode, secret configured, last verify result)
- structured channel telemetry (`channel.inbound.accepted`, `channel.outbound.failed`, latency)
- runbook for pairing/webhook troubleshooting and replay steps

**Step 4: Run full verification**

Run: `npm run test`  
Expected: PASS for full suite.

Run: `npm run typecheck`  
Expected: PASS with zero type errors.

Run: `npm run lint`  
Expected: PASS with no new lint violations.

**Step 5: Commit**

```bash
git add src/server/channels/webhookAuth.ts src/server/telemetry/logService.ts app/api/security/status/route.ts tests/integration/channels/omnichannel-security.contract.test.ts tests/integration/channels/omnichannel-observability.contract.test.ts docs/GATEWAY_WEBSOCKET_INTEGRATION.md docs/OMNICHANNEL_RUNBOOK.md
git commit -m "chore: harden omnichannel security and observability"
```

### Completion Checklist

- All webhook channels use shared `InboundEnvelope`.
- Pairing and channel status are persisted server-side, not local-only.
- Unified inbox supports cross-channel filter/search and real-time updates.
- Gateway exposes omnichannel RPC/event contracts.
- Slack proves adapter extensibility; existing channels remain backward-compatible.
- Security and telemetry cover each channel path.
- Tests, typecheck, and lint all pass.

### Skills to apply during execution

- `@superpowers:test-driven-development` before each implementation step.
- `@superpowers:systematic-debugging` for any failing test beyond first expected failure.
- `@superpowers:verification-before-completion` before claiming done.
- `@superpowers:requesting-code-review` after all tasks pass.

Plan complete and saved to `docs/plans/2026-02-11-omnichannel-messaging-system.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
