# Persistent Chat Session Best-Case Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Date:** 2026-02-10  
**Status:** Validated with stakeholder  
**Goal:** Copilot-like chat continuity across devices and restarts with strict user isolation, model-independent conversation threads, and no regressions in chat/workspace/worker flows.

## Validated Decisions

1. **Conversation model:** Model-independent thread (one conversation survives provider/model switch).
2. **Identity model:** Auth.js (NextAuth) with real per-user isolation.
3. **Context strategy:** `thread summary + recent messages + optional memory recall`.
4. **Scope target:** Cross-device continuation for authenticated users.
5. **Safety constraint:** No regressions in existing chat, worker, or workspace workflows.

## Architecture Overview

Use a server-centric chat runtime with clear responsibility boundaries:

1. `SessionManager`

- Resolves Auth.js session and `user_id`.
- Verifies conversation ownership.
- Resolves or creates active conversation state for the user.

2. `HistoryManager`

- Appends user/assistant messages durably.
- Provides pagination and replay.
- Guarantees stable order via per-conversation sequence.

3. `ContextBuilder`

- Assembles prompt context from summary, recent history window, and optional memory recall.
- Applies provider/model token budgets.
- Produces a model-agnostic context payload for gateway dispatch.

4. `ModelHub Gateway`

- Keeps provider specifics isolated.
- Receives normalized context from `ContextBuilder`.
- Returns response + usage/metadata for storage.

## Data Model (SQLite, Auth.js compatible)

### Auth

Adopt Auth.js tables for users/sessions/accounts/verification tokens.

### Conversations

Extend `conversations` with:

- `user_id TEXT NOT NULL` (owner)
- Optional thread metadata fields as needed (`last_message_seq`, `last_model_event_at`)

Indexes:

- `idx_conversations_user_updated` on `(user_id, updated_at DESC)`

### Messages

Extend `messages` with:

- `seq INTEGER NOT NULL` (strict ordering inside conversation)
- Optional `client_message_id TEXT` (idempotency)
- Optional AI metadata fields (provider/model/usage/latency)

Indexes:

- `idx_messages_conversation_seq` on `(conversation_id, seq)`
- `idx_messages_client_id` on `(conversation_id, client_message_id)` when enabled

### Conversation Context

New table `conversation_context`:

- `conversation_id TEXT PRIMARY KEY`
- `summary_text TEXT NOT NULL DEFAULT ''`
- `summary_upto_seq INTEGER NOT NULL DEFAULT 0`
- `updated_at TEXT NOT NULL`

### Optional Audit (recommended)

`conversation_model_events`:

- model/provider switches, gateway failures, fallback events.

## API and Runtime Flow

### Send message (`POST /api/channels/messages`)

1. `SessionManager` validates session and loads `user_id`.
2. Ownership guard: requested `conversationId` must belong to `user_id`.
3. `HistoryManager` persists user message (`seq = previous + 1`).
4. `ContextBuilder` builds context:

- `summary_text`
- messages with `seq > summary_upto_seq` in recent window
- optional `core_memory_recall` augmentation

5. Gateway dispatch via ModelHub (model/provider may change, thread does not).
6. `HistoryManager` persists assistant message + metadata.
7. Stream/SSE emits only to authorized user thread subscribers.
8. Async summarizer updates `conversation_context` on threshold.

### Load messages (`GET /api/channels/messages`)

- Always scoped by session `user_id`.
- Paged by `before_seq` or `before_timestamp` with stable ordering.

### List conversations (`GET /api/channels/conversations`)

- Always scoped by session `user_id`.
- Sorted by recent activity.

## Context Builder Policy

Primary policy:

1. Start with `summary_text` if present.
2. Add recent messages after `summary_upto_seq` up to token budget.
3. Optionally append relevant memory recall snippets.
4. Trim oldest unsummarized messages first when budget exceeded.

Recommended defaults:

- Summary refresh every 20 new messages or budget threshold trigger.
- Recent window target: 20-40 messages (adapt by model context limits).
- Hard budget enforcement per model/provider profile.

## Non-Regression Requirements

No-go criteria:

1. Lost chat messages.
2. Cross-user data exposure.
3. Worker command regressions (`/worker-*`).
4. Workspace flow regressions (including file hooks and task-related operations).
5. Stream/SSE breakage for active chats.

Required regression suite:

1. Chat send/load/reload continuation.
2. Provider/model switch within same conversation.
3. Worker commands from chat unchanged.
4. Workspace hooks unchanged (including `useWorkspaceFiles` behavior).
5. Dual-user isolation tests (cannot read/write others' conversations).
6. Migration up/re-run/idempotency tests.

## Rollout Plan (Risk-Minimized)

### Phase 0: Guardrails

- Add feature flag: `CHAT_PERSISTENT_SESSION_V2`.
- Add metrics/logging for failures, latency, missing events.

### Phase 1: Identity Foundation

- Integrate Auth.js and secure session retrieval in API routes.
- Keep old chat behavior temporarily.

### Phase 2: Additive Schema Migration

- Add new columns/tables/indexes without destructive changes.
- Backfill existing rows via legacy user mapping.

### Phase 3: Repository Dual-Compatibility

- Add user-scoped queries while preserving temporary fallback read paths.

### Phase 4: Enforce User Scoping

- Remove non-user-scoped API paths for conversations/messages/stream.

### Phase 5: Activate Managers Behind Flag

- Turn on `SessionManager`, `HistoryManager`, `ContextBuilder`.

### Phase 6: Frontend Path Switch

- Route send/load through server-persistent path only.
- Keep local state as transient UI cache.

### Phase 7: Canary and Global Rollout

- Internal users -> partial rollout -> full rollout.
- Defined rollback thresholds based on error rate and message integrity.

## Implementation Guardrails

1. No destructive migration during initial rollout.
2. No change to worker/workspace domain behavior in same PR without explicit tests.
3. All conversation/message queries must include `user_id` scope.
4. Gateway/provider changes must remain conversation-agnostic.
5. Feature-flagged activation required before default enablement.

## Definition of Done

1. User can continue the same conversation on another device after restart/login.
2. Model/provider switching does not break thread continuity.
3. Context continuity is stable via summary + recent + memory recall.
4. No regressions in worker/workspace/chat baseline flows.
5. All required tests pass (unit, integration, migration, isolation, build/type/lint gates).
