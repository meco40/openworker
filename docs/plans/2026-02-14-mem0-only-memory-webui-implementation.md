# Mem0-Only Memory WebUI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate memory storage and management to Mem0-only (no SQLite/hybrid path) while preserving WebUI capabilities for listing, editing, deleting, bulk operations, and persona-scoped cleanup.

**Architecture:** Replace local repository-backed memory CRUD with Mem0-backed service operations. Keep `/api/memory` response contract stable for the UI, but fulfill list/update/delete/bulk/delete-by-persona through Mem0 API calls. Runtime becomes fail-fast if Mem0 is unavailable.

**Tech Stack:** TypeScript, Next.js API routes, Vitest, Mem0 HTTP API (`/v1`, `/v2`).

---

### Task 1: Extend Mem0 Client For Full CRUD + Listing

**Files:**

- Modify: `src/server/memory/mem0Client.ts`
- Modify: `tests/unit/memory/mem0-client.test.ts`

**Step 1: Write failing tests**

- Add tests for:
  - list endpoint call with `filters.user_id` + `filters.agent_id` + pagination,
  - update payload using Mem0-supported field shape,
  - delete-by-filter for persona cleanup,
  - robust parsing for add/list/search response variants.

**Step 2: Run RED tests**

- Run: `npm run test -- tests/unit/memory/mem0-client.test.ts`
- Expected: FAIL.

**Step 3: Implement minimal Mem0 client additions**

- Add client methods required by service/UI:
  - `listMemories`, `getMemory`, `deleteMemoriesByFilter`.
- Keep timeout/auth + defensive parsing.

**Step 4: Run GREEN tests**

- Run: `npm run test -- tests/unit/memory/mem0-client.test.ts`
- Expected: PASS.

### Task 2: Convert MemoryService To Mem0-Only Behavior

**Files:**

- Modify: `src/server/memory/service.ts`
- Modify: `tests/unit/memory/memory-service.test.ts`

**Step 1: Write failing tests**

- Add/adjust tests proving:
  - store/recall/update/delete/list/bulk use Mem0 data path,
  - no local repository mirror assumptions,
  - delete-by-persona removes persona-scoped memories in Mem0,
  - feedback loop still updates/deletes via Mem0 IDs.

**Step 2: Run RED tests**

- Run: `npm run test -- tests/unit/memory/memory-service.test.ts`
- Expected: FAIL.

**Step 3: Implement minimal service changes**

- Remove SQLite/hybrid control flow from runtime path.
- Normalize Mem0 records into `MemoryNode` for existing API/UI contract.

**Step 4: Run GREEN tests**

- Run: `npm run test -- tests/unit/memory/memory-service.test.ts`
- Expected: PASS.

### Task 3: Runtime, API, and Diagnostics Wiring

**Files:**

- Modify: `src/server/memory/runtime.ts`
- Modify: `app/api/memory/route.ts` (if needed for contract consistency)
- Modify: `src/commands/health/checks/coreChecks.ts`
- Modify: `src/commands/health/checkHelpers.ts`
- Modify: `app/api/control-plane/metrics/route.ts`

**Step 1: Write failing tests**

- Add/adjust tests for mem0-only runtime behavior and dependent metrics/health paths.

**Step 2: Run RED tests**

- Run focused failing suites.

**Step 3: Implement minimal wiring**

- Runtime: fail-fast if Mem0 not configured.
- Diagnostics/metrics: query memory via `MemoryService` instead of direct SQLite repository.

**Step 4: Run GREEN tests**

- Run updated suites; ensure route/UI-facing contract stays valid.

### Task 4: Integration Test Coverage For WebUI CRUD Contract

**Files:**

- Modify: `tests/integration/memory/memory-route.test.ts`
- Modify: `tests/integration/personas/personas-memory-cascade-delete.test.ts`

**Step 1: Write failing tests**

- Move integration fixtures to Mem0-backed fake fetch adapter.
- Verify WebUI-relevant behavior:
  - paginated list,
  - edit/save,
  - single delete,
  - bulk update/delete,
  - delete-by-persona cascade.

**Step 2: Run RED tests**

- Run target integration tests and confirm failures.

**Step 3: Implement minimal adaptations**

- Update test scaffolding/env + any missing route/service behavior.

**Step 4: Run GREEN tests**

- Run memory/persona integration suites.

### Task 5: Final Verification

**Step 1: Run verification commands**

- `npm run test -- tests/unit/memory/mem0-client.test.ts tests/unit/memory/memory-service.test.ts tests/unit/memory/runtime.test.ts tests/integration/memory/memory-route.test.ts tests/integration/personas/personas-memory-cascade-delete.test.ts tests/unit/commands/health-command.test.ts tests/integration/control-plane-metrics-route.test.ts`

**Step 2: Validate no unintended file changes**

- `git status --short`

**Step 3: Report outcomes with evidence**

- Include exact pass/fail counts and any remaining risks.
