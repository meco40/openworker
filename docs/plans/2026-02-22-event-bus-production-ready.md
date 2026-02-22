# Event Bus Production-Ready Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Introduce a typed internal server event bus and move proactive evaluation to event-driven runtime integration with production-safe behavior.

**Architecture:** Add a typed in-process event bus with explicit domain events for chat message persistence and summary refresh. Publish events from message and summary flows; subscribe once during runtime bootstrap. Move proactive ingestion/evaluation behind an event subscriber so message/summarization logic is decoupled from proactive internals.

**Tech Stack:** TypeScript, Node runtime single-process in-memory bus, existing MessageService/SummaryService/ProactiveGateService, Vitest.

---

### Task 1: Add failing tests for event-driven proactive integration

**Files:**

- Create: `tests/unit/events/runtime-subscribers.test.ts`
- Modify: `tests/unit/channels/message-service-proactive-gate.test.ts`

**Step 1: Write the failing test**

- Assert that publishing `chat.message.persisted` and `chat.summary.refreshed` triggers proactive ingest/evaluate through runtime subscriber setup.
- Update old direct-coupling test expectation to no longer rely on direct call in summary service.

**Step 2: Run test to verify it fails**

- Run: `npm run test -- tests/unit/events/runtime-subscribers.test.ts tests/unit/channels/message-service-proactive-gate.test.ts`
- Expected: failing assertions due to missing event bus/subscriber behavior.

### Task 2: Implement typed event bus core

**Files:**

- Create: `src/server/events/types.ts`
- Create: `src/server/events/eventBus.ts`
- Create: `src/server/events/runtime.ts`

**Step 1: Implement minimal typed bus API**

- `publish`, `subscribe`, `clearAllSubscribers` (test-only safety), error-isolated listeners.
- Use domain event map with payload types (conversation + message summary payloads).

**Step 2: Add runtime singleton access**

- `getServerEventBus()` with process-wide singleton semantics.

### Task 3: Implement proactive event subscribers

**Files:**

- Create: `src/server/proactive/subscribers.ts`
- Modify: `src/server/channels/messages/runtime.ts`

**Step 1: Add subscriber registration**

- Subscribe proactive ingest to `chat.message.persisted` (user-only).
- Subscribe proactive evaluate to `chat.summary.refreshed`.

**Step 2: Bootstrap once**

- During `bootstrapMessageRuntime()`, register event subscribers exactly once.

### Task 4: Publish events from message + summary flows

**Files:**

- Modify: `src/server/channels/messages/service/index.ts`
- Modify: `src/server/channels/messages/service/utils/responseHelper.ts`
- Modify: `src/server/channels/messages/service/summaryService.ts`

**Step 1: Publish persisted message events**

- Emit `chat.message.persisted` for user and agent messages after DB save.

**Step 2: Publish summary refreshed event**

- Emit `chat.summary.refreshed` with conversation and summarized chunk metadata.
- Remove direct proactive call from summary service.

### Task 5: Verify and harden

**Files:**

- Modify: `docs/plans/2026-02-22-event-bus-production-ready.md` (optional notes)
- Modify: `.agent/CONTINUITY.md`

**Step 1: Run verification commands**

- `npm run test -- tests/unit/events/runtime-subscribers.test.ts tests/unit/channels/message-service-proactive-gate.test.ts tests/unit/proactive/proactive-gate-service.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npm run build`

**Step 2: Record outcomes**

- Update continuity with decision rationale and verification evidence summary.
