# Hybrid Recall Fusion — FTS5 Chat + Mem0 + Knowledge

**Date:** 2026-02-16  
**Goal:** `buildRecallContext()` queries all three recall sources in parallel, fuses results, and delivers combined context to the LLM.

## Problem

`buildRecallContext()` in `src/server/channels/messages/service.ts` uses a **sequential first-match-wins** strategy:

1. Knowledge Layer (episodes/ledger) → if found, **return** (stops here)
2. Mem0 semantic → if found, **return**
3. null

**FTS5 on `messages_fts` is never queried.** Even though the answer "Regeln im Office" exists in SQLite chat history, the system never searches it.

## Design

```
buildRecallContext()
│
├─ Promise.allSettled ─────────────────────────────────
│  ┌────────────────────┐  ┌────────────────┐  ┌──────────────┐
│  │ Knowledge Layer    │  │ Mem0 Semantic   │  │ FTS5 Chat    │
│  │ (Episodes/Ledger)  │  │ (Embeddings)    │  │ (Keyword)    │
│  │ Budget: 1500 chars │  │ Budget: 1200ch  │  │ Budget: 1300 │
│  └────────────────────┘  └────────────────┘  └──────────────┘
│          │                       │                    │
├──────────┴───────────────────────┴────────────────────┘
│
▼
fuseRecallSources({ knowledge?, memory?, chatHits? })
│  - Labels: [Knowledge], [Memory], [Chat History]
│  - Truncate each source to its budget
│  - Total: 4000 chars
▼
Return combined context → system message to LLM
```

### Decisions

- **Persona-isolated**: FTS5 only searches conversations where `persona_id = currentPersonaId`
- **No time limit**: All historical chats are searched
- **Budget**: 4000 chars total (Knowledge 1500 + Mem0 1200 + FTS5 1300)
- **Chat hit format**: `"message content..." — DD.MM.YYYY`

## Tasks

### Task 1: Add `personaId` to `SearchMessagesOptions` + SQL — ✅ DONE

**Files:**

- Modified: `src/server/channels/messages/sqliteMessageRepository.ts`
- Tests: `tests/unit/channels/message-repository-fts.test.ts` (14 tests, all GREEN)

### Task 2: Write failing tests for FTS5 persona-scoped search — ✅ DONE

**Files:**

- Tests added to: `tests/unit/channels/message-repository-fts.test.ts`

### Task 3: Write failing tests for hybrid recall fusion — ✅ DONE

**Files:**

- Created: `tests/unit/channels/recall-fusion.test.ts` (8 tests, all GREEN)

### Task 4: Implement `fuseRecallSources()` as standalone module — ✅ DONE

**Files:**

- Created: `src/server/channels/messages/recallFusion.ts`
- Exports: `fuseRecallSources()`, `RECALL_FUSION_TOTAL_BUDGET`, `RecallSources`
- Budget: Knowledge 1500 + Mem0 1200 + FTS5 Chat 1300 = 4000 total

### Task 5: Rewrite `buildRecallContext()` for parallel fusion — ✅ DONE

**Files:**

- Modified: `src/server/channels/messages/service.ts`
- Three new private methods: `recallFromKnowledge()`, `recallFromMemory()`, `recallFromChat()`
- `Promise.allSettled` parallel execution → `fuseRecallSources()` merger

### Task 6: Raise `MEMORY_CONTEXT_CHAR_LIMIT` to 4000 — ✅ DONE

**Files:**

- Modified: `src/server/channels/messages/service.ts` (1200 → 4000)

### Task 7: Update existing tests for parallel behavior — ✅ DONE

**Files:**

- Modified: `tests/unit/channels/message-service-knowledge-recall.test.ts`
  - Changed 6 `memoryRecallDetailedMock.not.toHaveBeenCalled()` → `.toHaveBeenCalled()`
  - Documents new parallel behavior where all sources are queried simultaneously

### Task 8: Full verification — ✅ DONE

```
npx vitest run → 249 passed, 1 skipped, 1106 tests, 0 failures
npx tsc --noEmit → 0 errors
```
