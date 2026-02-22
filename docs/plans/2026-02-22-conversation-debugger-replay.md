# Conversation Debugger & Replay — Implementation Plan

**Date:** 2026-02-22  
**Feature:** UI debugger for conversation history with step-by-step replay and per-turn diagnostics  
**Trigger:** `promptDispatchRepository` logs every LLM dispatch server-side, but has no conversation linkage, no latency, and no debugger UI

---

## Context & Existing Foundation

### What already exists

| Component                  | File                                                                   | Notes                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `PromptDispatchRepository` | `src/server/stats/promptDispatchRepository.ts`                         | Stores every LLM dispatch: tokens, cost, risk, full prompt payload — **no conversation linkage or latency**                        |
| `GatewayAuditContext`      | `src/server/model-hub/Models/types.ts:42`                              | Has `conversationId?`, `kind`, `taskId` — already threaded through `request.auditContext`                                          |
| `aiDispatcher.ts`          | `src/server/channels/messages/service/dispatchers/aiDispatcher.ts:137` | Sets `auditContext.conversationId` already; `memoryContext` string computed at line 55 but not forwarded to `runModelToolLoop`     |
| `RecallService`            | `src/server/channels/messages/service/recallService.ts`                | `buildRecallContext()` returns fused `knowledge`, `memory`, `chat` context (up to 5 000 chars)                                     |
| `StoredMessage.seq`        | `src/server/channels/messages/messageRowMappers.ts:28`                 | Per-message sequence number within a conversation                                                                                  |
| `prompt-logs` route        | `app/api/stats/prompt-logs/route.ts`                                   | Closest analogue — uses `resolveRequestUserContext()`, `export const runtime = 'nodejs'`, `export const dynamic = 'force-dynamic'` |
| `View` enum                | `src/shared/domain/types.ts:134`                                       | Needs `View.DEBUGGER` added                                                                                                        |

### What is missing

1. **Schema** — `prompt_dispatch_logs` has no `conversation_id`, `turn_seq`, `latency_ms`, `tool_calls_json`, `memory_context_json`
2. **Gateway wiring** — latency not measured; `result.functionCalls` not persisted; `memoryContext` + `turnSeq` not forwarded into `auditContext`
3. **`aiDispatcher.ts` wiring** — `memoryContext` computed locally at line 55 but not forwarded to `runModelToolLoop` → `auditContext`
4. **Debug API** — no `/api/debug/conversations`, `/api/debug/conversations/[id]/turns`, or `/api/debug/conversations/[id]/replay` routes
5. **Replay service** — no `ReplayService` to reconstruct conversation history
6. **UI module** — `src/modules/conversation-debugger/` does not exist

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  ConversationDebuggerView (View.DEBUGGER)                    │
│                                                              │
│  ┌──────────────────┐  ┌─────────────────────────────────┐  │
│  │ ConversationPicker│→ │     TurnTimeline                │  │
│  │ (search + filter) │  │  turn 1 → turn 2 → … turn N   │  │
│  └──────────────────┘  │  [tokens] [latency] [tools] [M] │  │
│                         └─────────────────┬───────────────┘  │
│                                           ↓ click            │
│                         ┌─────────────────────────────────┐  │
│                         │  TurnDetailPanel                 │  │
│                         │  • prompt preview (collapsible)  │  │
│                         │  • token bar chart               │  │
│                         │  • latency badge                 │  │
│                         │  • memory recalls (3 sources)    │  │
│                         │  • tool calls list               │  │
│                         │  • risk indicator                │  │
│                         │  • [Re-run from here →]          │  │
│                         └─────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘

Data flow (inbound message):
  aiDispatcher.ts
    → memoryContext computed (line 55)
    → runModelToolLoop(params + { memoryContext, turnSeq })  ← NEW
      → gateway.ts dispatchGatewayRequest()
            dispatchStart = Date.now()  ← NEW (before all three dispatch branches)
            ↓ actual model call
            latencyMs = Date.now() - dispatchStart  ← NEW (after branches, before audit)
        → recordDispatch({ conversationId, turnSeq, latencyMs,
                           toolCallsJson, memoryContextJson })  ← EXTENDED

Replay flow:
  POST /api/debug/conversations/[id]/replay { fromSeq, modelOverride? }
    → input validation: fromSeq must be integer ≥ 1
    → ReplayService.replayFrom(conversationId, fromSeq, modelOverride?)
      → load original conversation (channelType, personaId, userId)
      → load messages with seq 1..fromSeq-1 from MessageRepository
      → create new conversation (same metadata)
      → seed pre-history messages (role=user/assistant pairs)
      → return { newConversationId }
    → UI navigates to View.CHAT with that conversation
```

---

## Important Implementation Constraint: Two Separate Databases

`prompt_dispatch_logs` lives in `stats.db` (`STATS_DB_PATH`).  
`messages` / `conversations` live in the main channel messages DB.

**SQL joins between them are impossible.** The `/api/debug/conversations/[id]/turns` route must:

1. Fetch dispatch rows from `PromptDispatchRepository` filtered by `conversationId`
2. Separately fetch `StoredMessage` list from `MessageRepository` for the same `conversationId`
3. Merge by `seq` number at the application layer

---

## Data Model Changes

### `GatewayAuditContext` — two new optional fields

```ts
// src/server/model-hub/Models/types.ts
export interface GatewayAuditContext {
  kind: GatewayAuditKind;
  conversationId?: string;
  turnSeq?: number; // sequence number of the user message that triggered this dispatch
  memoryContext?: string; // fused recall context injected this turn (truncated to 500 chars for storage)
  taskId?: string;
  stepId?: string;
  nodeId?: string;
}
```

### `prompt_dispatch_logs` — five new columns

```sql
-- All via ensureColumnExists() — idempotent, never breaks existing data
conversation_id      TEXT
turn_seq             INTEGER
latency_ms           INTEGER
tool_calls_json      TEXT NOT NULL DEFAULT '[]'
memory_context_json  TEXT
```

> **`ensureColumnExists` call for `tool_calls_json`:**
>
> ```ts
> this.ensureColumnExists('prompt_dispatch_logs', 'tool_calls_json', "TEXT NOT NULL DEFAULT '[]'");
> ```
>
> SQLite permits `ALTER TABLE ADD COLUMN … NOT NULL DEFAULT …` as long as a literal default is provided.

> **Memory context storage cap:** raw recall context can be up to 5 000 chars.
> Truncate to 500 chars before storing:
>
> ```ts
> memoryContextJson: request.auditContext?.memoryContext?.slice(0, 500) ?? null,
> ```

### `RecordPromptDispatchInput` — five new optional fields

```ts
conversationId?:    string | null;
turnSeq?:           number | null;
latencyMs?:         number | null;
toolCallsJson?:     string;          // JSON-serialised Array<{name: string; args: unknown}>
memoryContextJson?: string | null;
```

### `PromptDispatchEntry` — five new required fields

```ts
conversationId: string | null;
turnSeq: number | null;
latencyMs: number | null;
toolCallsJson: string; // never null — defaults to '[]'
memoryContextJson: string | null;
```

> **`toEntry()` null guard for pre-migration rows:**
>
> ```ts
> toolCallsJson: String(row.tool_calls_json ?? '[]'),
> ```

### `PromptDispatchFilter` — one new optional field

```ts
conversationId?: string;
```

---

## Implementation Plan

---

### Task 1 — Extend schema + repository types

**Files:**

- Modify: `src/server/stats/promptDispatchRepository.ts`
- Modify: `tests/unit/stats/prompt-dispatch-repository.test.ts`

**Step 1: Write failing tests**

```ts
// tests/unit/stats/prompt-dispatch-repository.test.ts (additions)

it('stores and retrieves conversation_id, turn_seq, latency_ms', () => {
  const entry = repo.recordDispatch({
    ...makeBaseInput(),
    conversationId: 'conv-123',
    turnSeq: 2,
    latencyMs: 450,
    toolCallsJson: JSON.stringify([{ name: 'web_search', args: { query: 'test' } }]),
    memoryContextJson: '[Memory]\nUser prefers dark mode',
  });
  expect(entry.conversationId).toBe('conv-123');
  expect(entry.turnSeq).toBe(2);
  expect(entry.latencyMs).toBe(450);
  expect(entry.toolCallsJson).toContain('web_search');
  expect(entry.memoryContextJson).toContain('dark mode');
});

it('defaults toolCallsJson to "[]" when not provided', () => {
  const entry = repo.recordDispatch(makeBaseInput());
  expect(entry.toolCallsJson).toBe('[]');
});

it('listDispatches filters by conversationId, excluding null conversation_id rows', () => {
  repo.recordDispatch({ ...makeBaseInput(), conversationId: 'conv-a' });
  repo.recordDispatch({ ...makeBaseInput(), conversationId: 'conv-b' });
  repo.recordDispatch(makeBaseInput()); // no conversationId — must not appear
  const results = repo.listDispatches({ conversationId: 'conv-a' });
  expect(results).toHaveLength(1);
  expect(results[0].conversationId).toBe('conv-a');
});
```

**Step 2:** Run → FAIL
`npm test -- tests/unit/stats/prompt-dispatch-repository.test.ts`

**Step 3: Implement**

Add to `RecordPromptDispatchInput`:

```ts
conversationId?: string | null;
turnSeq?: number | null;
latencyMs?: number | null;
toolCallsJson?: string;
memoryContextJson?: string | null;
```

Add to `PromptDispatchEntry`:

```ts
conversationId: string | null;
turnSeq: number | null;
latencyMs: number | null;
toolCallsJson: string;
memoryContextJson: string | null;
```

Add to `PromptDispatchFilter`:

```ts
conversationId?: string;
```

In `migrate()`, add after the existing `ensureColumnExists` calls:

```ts
this.ensureColumnExists('prompt_dispatch_logs', 'conversation_id', 'TEXT');
this.ensureColumnExists('prompt_dispatch_logs', 'turn_seq', 'INTEGER');
this.ensureColumnExists('prompt_dispatch_logs', 'latency_ms', 'INTEGER');
this.ensureColumnExists('prompt_dispatch_logs', 'tool_calls_json', "TEXT NOT NULL DEFAULT '[]'");
this.ensureColumnExists('prompt_dispatch_logs', 'memory_context_json', 'TEXT');

this.db.exec(`
  CREATE INDEX IF NOT EXISTS idx_prompt_dispatch_logs_conversation
    ON prompt_dispatch_logs (conversation_id)
    WHERE conversation_id IS NOT NULL;
`);
```

In `recordDispatch()`, add to INSERT columns + values + return object:

```ts
// columns: conversation_id, turn_seq, latency_ms, tool_calls_json, memory_context_json
input.conversationId ?? null,
input.turnSeq ?? null,
input.latencyMs ?? null,
input.toolCallsJson ?? '[]',
input.memoryContextJson ?? null,
```

In `toEntry()`, handle pre-migration null rows:

```ts
conversationId:    row.conversation_id ? String(row.conversation_id) : null,
turnSeq:           row.turn_seq != null ? Number(row.turn_seq) : null,
latencyMs:         row.latency_ms != null ? Number(row.latency_ms) : null,
toolCallsJson:     String(row.tool_calls_json ?? '[]'),
memoryContextJson: row.memory_context_json ? String(row.memory_context_json) : null,
```

In `buildWhere()`, add:

```ts
if (filter.conversationId) {
  conditions.push('conversation_id = ?');
  params.push(filter.conversationId);
}
```

Add `listConversationSummaries()` method for the conversations list API:

```ts
listConversationSummaries(): DebugConversationSummary[] {
  const rows = this.db.prepare(`
    SELECT
      conversation_id,
      COUNT(*) AS turn_count,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
      MAX(created_at) AS last_activity,
      (SELECT model_name FROM prompt_dispatch_logs p2
       WHERE p2.conversation_id = p.conversation_id
       ORDER BY created_at DESC LIMIT 1) AS model_name
    FROM prompt_dispatch_logs p
    WHERE conversation_id IS NOT NULL
    GROUP BY conversation_id
    ORDER BY last_activity DESC
    LIMIT 100
  `).all() as Array<Record<string, unknown>>;
  return rows.map(toConversationSummary);
}
```

(`DebugConversationSummary` type is defined in `src/modules/conversation-debugger/types.ts` — Task 5. Import it there once Task 5 is done.)

**Step 4:** Run → PASS
**Step 5:** Commit: `feat(stats): extend prompt_dispatch_logs with conversation linkage, latency, tool calls`

---

### Task 2 — Thread context through gateway

**Files:**

- Modify: `src/server/model-hub/Models/types.ts`
- Modify: `src/server/model-hub/gateway.ts`
- Modify: `tests/unit/model-hub/gateway-prompt-logging.test.ts`

**Step 1: Write failing test**

```ts
// tests/unit/model-hub/gateway-prompt-logging.test.ts (addition)

it('records conversationId, turnSeq, latency and tool calls from auditContext', async () => {
  let captured: RecordPromptDispatchInput | undefined;
  vi.spyOn(repo, 'recordDispatch').mockImplementation((input) => {
    captured = input;
    return { ...input, id: 'test-id', createdAt: new Date().toISOString() } as PromptDispatchEntry;
  });

  await dispatchGatewayRequest(mockAccount, encKey, {
    ...baseRequest,
    auditContext: { kind: 'chat', conversationId: 'conv-x', turnSeq: 3 },
  });

  expect(captured?.conversationId).toBe('conv-x');
  expect(captured?.turnSeq).toBe(3);
  expect(captured?.latencyMs).toBeGreaterThanOrEqual(0);
  expect(captured?.toolCallsJson).toBeDefined();
  expect(() => JSON.parse(captured!.toolCallsJson!)).not.toThrow();
});
```

**Step 2:** Run → FAIL
`npm test -- tests/unit/model-hub/gateway-prompt-logging.test.ts`

**Step 3: Implement**

In `GatewayAuditContext` (`src/server/model-hub/Models/types.ts`), add after `conversationId?`:

```ts
turnSeq?: number;       // sequence number of the user message that triggered this dispatch
memoryContext?: string; // fused recall context — stored truncated (500 chars max)
```

In `gateway.ts`, add the timer **before** the `if (adapter?.dispatchGateway) {` block:

```ts
const dispatchStart = Date.now();
```

Add `latencyMs` calculation **after** all three dispatch branches close, before the token-recording section:

```ts
const latencyMs = Date.now() - dispatchStart;
```

In `recordDispatch()` call, add five new fields:

```ts
conversationId:    request.auditContext?.conversationId ?? null,
turnSeq:           request.auditContext?.turnSeq ?? null,
latencyMs,
toolCallsJson:     JSON.stringify(result.functionCalls ?? []),
memoryContextJson: request.auditContext?.memoryContext
  ? request.auditContext.memoryContext.slice(0, 500)
  : null,
```

**Step 4:** Run → PASS
**Step 5:** Commit: `feat(gateway): record latency, tool calls, and conversation linkage in dispatch log`

---

### Task 3 — Wire turnSeq + memoryContext into aiDispatcher

**Files:**

- Modify: `src/server/channels/messages/service/dispatchers/aiDispatcher.ts`
- Test: `tests/unit/channels/messages/ai-dispatcher-audit-context.test.ts` (new)

> `conversationId` is already set at line 137 of `aiDispatcher.ts`.
> `memoryContext` is computed at line 55 but not forwarded to `runModelToolLoop`.
> `turnSeq` must come from the caller (saved message seq).

**Step 1: Write failing test**

```ts
// tests/unit/channels/messages/ai-dispatcher-audit-context.test.ts (new)

it('forwards memoryContext and turnSeq in auditContext to runModelToolLoop', async () => {
  const capturedAuditContexts: GatewayAuditContext[] = [];

  const stubRunModelToolLoop = vi.fn(async (_toolManager, params) => {
    capturedAuditContexts.push(params.auditContextExtras as GatewayAuditContext);
    return { content: 'ok', metadata: { ok: true } };
  });

  const deps = buildTestDeps({
    runModelToolLoop: stubRunModelToolLoop,
    recallService: { buildRecallContext: async () => '[Memory]\nUser prefers dark mode' },
  });

  await dispatchToAI(deps, {
    conversation: makeConversation({ id: 'conv-1' }),
    platform: 'web',
    externalChatId: 'ext-1',
    userInput: 'hello',
    turnSeq: 4,
  });

  expect(capturedAuditContexts[0].memoryContext).toContain('dark mode');
  expect(capturedAuditContexts[0].turnSeq).toBe(4);
});
```

**Step 2:** Run → FAIL
`npm test -- tests/unit/channels/messages/ai-dispatcher-audit-context.test.ts`

**Step 3: Implement**

Add `turnSeq?: number` to the `params` object of `dispatchToAI()`.

Pass `memoryContext` + `turnSeq` through `runModelToolLoop` params as `auditContextExtras`:

```ts
modelOutcome = await deps.runModelToolLoop(deps.toolManager, {
  conversation,
  messages,
  modelHubProfileId,
  preferredModelId,
  toolContext,
  abortSignal: abortController.signal,
  onStreamDelta,
  auditContextExtras: {
    // NEW
    turnSeq: params.turnSeq,
    memoryContext: memoryContext ?? undefined,
  },
});
```

In `runModelToolLoop`, merge extras into `auditContext`:

```ts
auditContext: {
  kind: 'chat',
  conversationId: conversation.id,
  ...(params.auditContextExtras ?? {}),
},
```

In the caller (`processInbound` or the service entry point), pass the saved message's seq:

```ts
await deps.dispatchToAI(deps, {
  ...existingParams,
  turnSeq: savedMessage.seq ?? undefined,
});
```

**Step 4:** Run → PASS
**Step 5:** Commit: `feat(messages): forward turnSeq and memoryContext into gateway auditContext`

---

### Task 4 — Debug API routes

**Files:**

- Create: `app/api/debug/conversations/route.ts`
- Create: `app/api/debug/conversations/[id]/turns/route.ts`
- Create: `app/api/debug/conversations/[id]/replay/route.ts`
- Create: `src/server/debug/replayService.ts`
- Test: `tests/integration/debug/debug-conversations-route.test.ts` (new)

> **Auth — required on all three routes (non-negotiable):**
>
> ```ts
> const user = await resolveRequestUserContext();
> if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
> ```
>
> These routes expose full prompt payloads including PII — same protection as `prompt-logs`.

> **Required boilerplate on every debug route file:**
>
> ```ts
> export const runtime = 'nodejs';
> export const dynamic = 'force-dynamic';
> ```

**Step 1: Write failing tests**

```ts
// tests/integration/debug/debug-conversations-route.test.ts

vi.mock('@/server/auth/userContext', () => ({
  resolveRequestUserContext: vi.fn().mockResolvedValue({ userId: 'user-1' }),
}));

it('GET /api/debug/conversations returns grouped list, excluding null conversation_id rows', async () => {
  repo.recordDispatch({ ...base, conversationId: 'conv-a', turnSeq: 1 });
  repo.recordDispatch({ ...base, conversationId: 'conv-a', turnSeq: 2 });
  repo.recordDispatch({ ...base, conversationId: 'conv-b', turnSeq: 1 });
  repo.recordDispatch(base); // no conversationId — must be excluded

  const res = await GET(makeGetRequest());
  const json = await res.json();

  expect(json.ok).toBe(true);
  expect(json.conversations).toHaveLength(2);
  expect(json.conversations[0].turnCount).toBe(2);
});

it('GET /api/debug/conversations returns 401 when unauthenticated', async () => {
  vi.mocked(resolveRequestUserContext).mockResolvedValueOnce(null);
  const res = await GET(makeGetRequest());
  expect(res.status).toBe(401);
});

it('GET /api/debug/conversations/[id]/turns returns turns sorted by seq ASC', async () => {
  repo.recordDispatch({ ...base, conversationId: 'conv-x', turnSeq: 1, latencyMs: 100 });
  repo.recordDispatch({
    ...base,
    conversationId: 'conv-x',
    turnSeq: 2,
    latencyMs: 200,
    toolCallsJson: JSON.stringify([{ name: 'web_search', args: {} }]),
  });

  const res = await GET(makeTurnsRequest('conv-x'));
  const json = await res.json();

  expect(json.ok).toBe(true);
  expect(json.turns).toHaveLength(2);
  expect(json.turns[0].seq).toBe(1);
  expect(json.turns[1].toolCalls).toHaveLength(1);
  expect(json.turns[0].latencyMs).toBe(100);
});

it('POST /api/debug/conversations/[id]/replay returns 400 for fromSeq < 1', async () => {
  const res = await POST(makeReplayRequest('conv-x', { fromSeq: 0 }));
  expect(res.status).toBe(400);
});

it('POST /api/debug/conversations/[id]/replay returns newConversationId', async () => {
  const res = await POST(makeReplayRequest('conv-x', { fromSeq: 2 }));
  const json = await res.json();
  expect(json.ok).toBe(true);
  expect(typeof json.newConversationId).toBe('string');
});
```

**Step 2:** Run → FAIL
`npm test -- tests/integration/debug/debug-conversations-route.test.ts`

**Step 3: Implement**

**`app/api/debug/conversations/route.ts`:**

```ts
import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '@/server/auth/userContext';
import { getPromptDispatchRepository } from '@/server/stats/promptDispatchRepository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await resolveRequestUserContext();
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  try {
    const conversations = getPromptDispatchRepository().listConversationSummaries();
    return NextResponse.json({ ok: true, conversations });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
```

**`app/api/debug/conversations/[id]/turns/route.ts`:**

```ts
// Application-layer join (two separate DBs — SQL join is not possible):
// 1. getPromptDispatchRepository().listDispatches({ conversationId: id }) → dispatch rows
// 2. getMessageRepository().listMessages(id, ...) → StoredMessage[] for user/assistant previews
// 3. Merge by seq: for each dispatch row, find message with matching seq
// 4. Return DebugTurn[] sorted by turn_seq ASC
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await resolveRequestUserContext();
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  // ... application-layer merge and return DebugTurn[]
}
```

**`src/server/debug/replayService.ts`:**

```ts
export class ReplayService {
  constructor(
    private readonly messageRepo: MessageRepository,
    private readonly dispatchRepo: PromptDispatchRepository,
  ) {}

  async replayFrom(
    conversationId: string,
    fromSeq: number,
    modelOverride?: string,
  ): Promise<string> {
    if (fromSeq < 1) throw new Error('fromSeq must be >= 1');

    // 1. Load original conversation — preserve channelType, personaId, userId
    const original = this.messageRepo.getConversation(conversationId);
    if (!original) throw new Error(`Conversation ${conversationId} not found`);

    // 2. Load history: messages with seq 1..fromSeq-1
    const history = this.messageRepo.listMessages(conversationId, { maxSeq: fromSeq - 1 });

    // 3. Create new conversation with same metadata
    const newConversation = this.messageRepo.createConversation({
      channelType: original.channelType,
      userId: original.userId,
      personaId: original.personaId,
      externalChatId: `replay-${Date.now()}`,
      name: `[Replay from T${fromSeq}] ${original.name ?? conversationId}`,
    });

    // 4. Seed history as pre-existing messages
    for (const msg of history) {
      this.messageRepo.saveMessage({
        conversationId: newConversation.id,
        role: msg.role,
        content: msg.content,
        platform: msg.platform,
      });
    }

    // 5. modelOverride: Phase 2 — user selects model in chat after navigating
    return newConversation.id;
  }
}

export function getReplayService(): ReplayService {
  return new ReplayService(getMessageRepository(), getPromptDispatchRepository());
}
```

**`app/api/debug/conversations/[id]/replay/route.ts`:**

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await resolveRequestUserContext();
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const body = (await request.json()) as { fromSeq?: unknown; modelOverride?: unknown };

  const fromSeq = Number(body.fromSeq);
  if (!Number.isInteger(fromSeq) || fromSeq < 1) {
    return NextResponse.json(
      { ok: false, error: 'fromSeq must be an integer >= 1' },
      { status: 400 },
    );
  }

  const modelOverride = typeof body.modelOverride === 'string' ? body.modelOverride : undefined;

  try {
    const newConversationId = await getReplayService().replayFrom(id, fromSeq, modelOverride);
    return NextResponse.json({ ok: true, newConversationId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Replay failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
```

**Step 4:** Run → PASS
**Step 5:** Commit: `feat(debug): add conversation debugger API routes + ReplayService`

---

### Task 5 — Frontend module scaffold + View enum

**Files:**

- Modify: `src/shared/domain/types.ts` (add `View.DEBUGGER = 'debugger'`)
- Modify: `src/components/Sidebar.tsx` (add Debugger entry)
- Modify: `src/modules/app-shell/components/AppShellViewContent.tsx`
- Create: `src/modules/conversation-debugger/types.ts`
- Create: `src/modules/conversation-debugger/useConversationDebugger.ts`
- Create: `src/modules/conversation-debugger/ConversationDebuggerView.tsx`
- Create: `src/modules/conversation-debugger/components/ConversationPicker.tsx`

**Step 1: Add enum value and fix type errors**

Add `DEBUGGER = 'debugger'` to the `View` enum in `src/shared/domain/types.ts`.

Run: `npm run typecheck`
Fix any exhaustive switch/guard that now reports an unhandled `View.DEBUGGER` case.

**Step 2:** `npm run typecheck` → 0 errors

**Step 3: Implement**

`src/modules/conversation-debugger/types.ts`:

```ts
export interface DebugConversationSummary {
  conversationId: string;
  turnCount: number;
  totalTokens: number;
  totalCostUsd: number | null;
  lastActivity: string;
  modelName: string;
}

export interface DebugTurn {
  seq: number;
  userPreview: string;
  assistantPreview: string;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number | null;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  memoryContext: string | null;
  riskLevel: 'low' | 'medium' | 'high';
  dispatchId: string;
}
```

`useConversationDebugger.ts`: manages state (selected conversation, turns, selected turn, loading state, replay state) + fetch helpers for all three debug API endpoints.

`ConversationPicker.tsx`: table with columns:

- Conversation ID (truncated + copy icon)
- Turns
- Total tokens
- Cost (USD, or `—` if null)
- Last activity (relative time)
- Last model
- [Debug →] button

**Step 4:** `npm run typecheck` → 0 errors
**Step 5:** Commit: `feat(debugger): scaffold conversation debugger module + View.DEBUGGER`

---

### Task 6 — TurnTimeline + TurnDetailPanel

**Files:**

- Create: `src/modules/conversation-debugger/components/TurnTimeline.tsx`
- Create: `src/modules/conversation-debugger/components/TurnDetailPanel.tsx`

**Step 1:** Confirm `npm run typecheck` passes before adding new files

**Step 2: Implement**

`TurnTimeline.tsx` — vertical scrollable list of turn cards, each showing:

- Turn N badge (seq number)
- User message preview (1 line, `truncated…`)
- Token pill: `{promptTokens + completionTokens} tok`
- Latency pill: `{latencyMs}ms` or `—`
- Tool count badge: `{toolCalls.length} tools` (hidden when 0)
- Memory badge `M` (shown when `memoryContext !== null`)
- Risk dot: green/amber/red
- Highlighted border when selected

`TurnDetailPanel.tsx` — right panel:

```
┌──────────────────────────────────────────────────────────┐
│ Turn 3 · chat · gemini-1.5-pro-002                       │
│ 450ms total · 1 234 prompt tok · 89 completion tok       │
├──────────────────────────────────────────────────────────┤
│ ▶ PROMPT PREVIEW   (click to expand full payload)        │
│   "User asked: What is the weather in Berlin?"           │
├──────────────────────────────────────────────────────────┤
│ TOKENS          ████████████░░  1 234 prompt / 89 compl  │
│ TOTAL LATENCY   ■■■■■■■■■■■■■■  450 ms                   │
├──────────────────────────────────────────────────────────┤
│ MEMORY RECALLS (injected into context)                   │
│   [Knowledge]  …snippet…                                 │
│   [Memory]     User prefers dark mode                    │
│   [Chat]       Previous: "I'm in Berlin"                 │
├──────────────────────────────────────────────────────────┤
│ TOOL CALLS (2)                                           │
│   web_search({ query: "Berlin weather" })                │
│   get_location({ city: "Berlin" })                       │
├──────────────────────────────────────────────────────────┤
│ RISK  ● LOW (score: 0)                                   │
├──────────────────────────────────────────────────────────┤
│ [Re-run from Turn 3 →]                                   │
└──────────────────────────────────────────────────────────┘
```

**Step 3:** `npm run typecheck` → 0 errors; visually verify in browser
**Step 4:** Commit: `feat(debugger): TurnTimeline and TurnDetailPanel components`

---

### Task 7 — ReplayModal

**Files:**

- Create: `src/modules/conversation-debugger/components/ReplayModal.tsx`
- Modify: `src/modules/conversation-debugger/useConversationDebugger.ts`

**Step 1:** Confirm `npm run typecheck` passes before adding new files

**Step 2: Implement**

`ReplayModal.tsx`:

- Heading: "Re-run from Turn N"
- Info text: "Turns 1–{N−1} will be seeded as history. Turn N is the first live message."
- Model selector: `<select>` populated from `GET /api/model-hub/pipeline` (lists available accounts + model IDs).
  Default option: "(same model)" — sends no `modelOverride`
- "Inject history only" checkbox — seeds history without triggering live generation
- [Cancel] / [Start Replay →] buttons

On submit:

1. POST `/api/debug/conversations/[id]/replay` `{ fromSeq, modelOverride? }`
2. Show inline spinner
3. On success: replace body with "✓ New conversation created" + **[Open Chat →]** that navigates to `View.CHAT` with `newConversationId` passed via app shell state

**Step 3:** `npm run typecheck` → 0 errors; test replay flow manually in browser
**Step 4:** Commit: `feat(debugger): ReplayModal with model override + post-replay navigation`

---

### Task 8 — Wire ConversationDebuggerView + AppShell

**Files:**

- Modify: `src/modules/conversation-debugger/ConversationDebuggerView.tsx`
- Modify: `src/modules/app-shell/components/AppShellViewContent.tsx`

**Step 1:** No new tests needed — covered by typecheck + manual smoke test

**Step 2: Implement**

Final layout of `ConversationDebuggerView.tsx`:

```
┌──────────────────────────────────────────────────────────────┐
│ Conversation Debugger             Filter: model [All ▼]      │
│ Search: [_________________]                  Page: [< 1 >]   │
├─────────────────────┬────────────────────────────────────────┤
│ ConversationPicker  │ (conversation selected):               │
│ (25 per page)       │   TurnTimeline  |  TurnDetailPanel     │
│                     │                                        │
└─────────────────────┴────────────────────────────────────────┘
Responsive: on narrow viewports, hide left panel when a conversation is selected
```

In `AppShellViewContent.tsx`, add with dynamic import (ssr: false):

```tsx
{
  currentView === View.DEBUGGER && <ConversationDebuggerView />;
}
```

**Step 3:** `npm run typecheck` → 0 errors
**Step 4:** Commit: `feat(debugger): complete ConversationDebuggerView wiring`

---

### Task 9 — End-to-end verification

**Step 1:** `npm run typecheck` → 0 errors
**Step 2:** `npm run lint` → 0 errors
**Step 3:** `npm test` → all existing tests pass + all new debugger tests pass
**Step 4:** `npm run build` → compiled successfully; confirm these routes appear in the route table:

- `/api/debug/conversations`
- `/api/debug/conversations/[id]/turns`
- `/api/debug/conversations/[id]/replay`

**Step 5: Manual smoke test**

1. Start dev server
2. Send ≥ 3 messages in a chat that triggers at least one tool call and one memory recall
3. Navigate to Sidebar → **Debugger**
4. Confirm conversation appears with correct turn count and token total
5. Click conversation → turns listed with tokens, latency, and tool count badges
6. Click a turn with tool calls → detail panel shows prompt preview, memory context, tool calls
7. Click **Re-run from Turn 2** → ReplayModal opens → start replay → new conversation created → [Open Chat →] navigates to replayed conversation
8. Verify the replayed conversation contains the seeded history (Turn 1 only) before the first live model response

**Step 6:** Commit: `feat(debugger): end-to-end verified — Conversation Debugger complete`

---

## Out of Scope — Phase 2

| Topic                                                    | Reason                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Per-tool latency breakdown (LLM vs. tool network vs. DB) | Requires per-tool timing hooks across all skill adapters; `latency_ms` covers total turn time for now |
| Side-by-side A/B model diff across two replays           | Phase 2 — add `replay_of_conversation_id` + `replay_of_turn_seq` columns                              |
| `modelOverride` persisted on replayed conversation       | Phase 2 — requires model preference storage per conversation                                          |
| Export conversation as JSON/CSV                          | Phase 2 — trivial once `/turns` endpoint is live                                                      |
| Real-time live-updating debugger (WebSocket)             | Phase 2 — polling suffices for now                                                                    |

---

## File Summary

### New files

```
src/modules/conversation-debugger/
  types.ts
  useConversationDebugger.ts
  ConversationDebuggerView.tsx
  components/
    ConversationPicker.tsx
    TurnTimeline.tsx
    TurnDetailPanel.tsx
    ReplayModal.tsx

src/server/debug/
  replayService.ts

app/api/debug/
  conversations/
    route.ts                      (GET — list, auth guard, runtime=nodejs, dynamic=force-dynamic)
    [id]/
      turns/route.ts              (GET — turn list, app-layer message join, auth guard)
      replay/route.ts             (POST — replay, fromSeq validation, auth guard)
```

### Modified files

```
src/server/stats/promptDispatchRepository.ts      (+5 columns, +partial index, +listConversationSummaries)
src/server/model-hub/Models/types.ts              (+turnSeq, +memoryContext on GatewayAuditContext)
src/server/model-hub/gateway.ts                   (+dispatchStart/latencyMs, +toolCallsJson, +memoryContextJson)
src/server/channels/messages/service/dispatchers/aiDispatcher.ts  (+turnSeq + memoryContext forwarding via auditContextExtras)
src/shared/domain/types.ts                        (+View.DEBUGGER)
src/components/Sidebar.tsx                        (+Debugger sidebar item)
src/modules/app-shell/components/AppShellViewContent.tsx  (+View.DEBUGGER case, dynamic import)
```

### Test files

```
tests/unit/stats/prompt-dispatch-repository.test.ts             (modified — 3 new cases)
tests/unit/model-hub/gateway-prompt-logging.test.ts             (modified — 1 new case)
tests/unit/channels/messages/ai-dispatcher-audit-context.test.ts  (new — 1 case)
tests/integration/debug/debug-conversations-route.test.ts       (new — 5 cases)
```
