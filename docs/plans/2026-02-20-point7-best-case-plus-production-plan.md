# Point 7 Best Case Plus Production Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expand Punkt 7 to a production-ready Best-Case+ rollout by upgrading Sessions filtering depth, Logs scalability, and Cron history depth without introducing cross-user data leaks.

**Architecture:** Keep existing route/hook/view architecture and extend each layer end-to-end with bounded query parsing, explicit server-enforced security gates, and small UI controls that expose new capability safely. Add coverage in integration tests first so behavior changes are enforced before implementation.

**Tech Stack:** Next.js App Router, TypeScript, React hooks/components, Vitest integration/unit tests, SQLite-backed repositories.

---

### Task 1: Sessions Best-Case+ Filter Contract (TDD)

**Files:**

- Modify: `tests/integration/ops/ops-routes.test.ts`

**Step 1: Write failing tests for new sessions filters**

- Extend ops sessions route tests for:
- `activeMinutes` filter behavior.
- `includeUnknown` behavior (unknown = missing `personaId`).
- `includeGlobal` request vs. applied behavior:
- requested true + authenticated context => `includeGlobalApplied: false`.
- requested true + unauthenticated context => `includeGlobalApplied: true`.

**Step 2: Run only this test file and verify failures**

Run: `npm test -- tests/integration/ops/ops-routes.test.ts`

Expected: FAIL on missing query fields / missing filter behavior.

**Step 3: Commit checkpoint**

Run:

```bash
git add tests/integration/ops/ops-routes.test.ts
git commit -m "test: define sessions best-case filter contract"
```

### Task 2: Sessions API + Hook + UI Implementation

**Files:**

- Modify: `app/api/ops/sessions/route.ts`
- Modify: `src/modules/ops/types.ts`
- Modify: `src/modules/ops/hooks/useOpsSessions.ts`
- Modify: `src/modules/ops/components/SessionsView.tsx`
- Modify: `tests/unit/components/ops-sessions-view.test.ts`

**Step 1: Implement minimal server-side filter parsing**

- Add parsing for `activeMinutes`, `limit`, `includeGlobal`, `includeUnknown`.
- Enforce:
- `includeGlobalApplied = false` when `userContext.authenticated === true`.
- `includeGlobalApplied = true` only in unauthenticated legacy mode.
- Apply `activeMinutes` filter using `updatedAt`.
- Apply `includeUnknown=false` to exclude sessions with missing `personaId`.
- Extend response query payload with applied/requested fields.

**Step 2: Implement hook/UI wiring**

- Add local hook state for new filters and pass as query params.
- Keep existing CRUD actions unchanged.
- Add SessionsView controls:
- Active minutes input.
- Limit input.
- Include global toggle.
- Include unknown toggle.
- Add small hint when includeGlobal requested but not applied.

**Step 3: Run focused tests**

Run:

```bash
npm test -- tests/integration/ops/ops-routes.test.ts tests/unit/components/ops-sessions-view.test.ts
```

Expected: PASS.

**Step 4: Commit checkpoint**

Run:

```bash
git add app/api/ops/sessions/route.ts src/modules/ops/types.ts src/modules/ops/hooks/useOpsSessions.ts src/modules/ops/components/SessionsView.tsx tests/unit/components/ops-sessions-view.test.ts
git commit -m "feat: add production-safe sessions filter depth"
```

### Task 3: Logs Cursor Contract (TDD)

**Files:**

- Modify: `tests/integration/telemetry/logs-route.test.ts`

**Step 1: Write failing tests for logs pagination metadata**

- Add tests for:
- `limit` clamping and metadata.
- `before` cursor pagination.
- `total` staying global for active filters.
- `hasMore` and `nextCursor` correctness.

**Step 2: Run only logs route tests**

Run: `npm test -- tests/integration/telemetry/logs-route.test.ts`

Expected: FAIL on missing pagination metadata fields.

**Step 3: Commit checkpoint**

Run:

```bash
git add tests/integration/telemetry/logs-route.test.ts
git commit -m "test: define logs cursor metadata contract"
```

### Task 4: Logs API + Hook + Toolbar Implementation

**Files:**

- Modify: `app/api/logs/route.ts`
- Modify: `src/components/logs/hooks/useLogs.ts`
- Modify: `src/components/LogsView.tsx`
- Modify: `src/components/logs/components/LogsToolbar.tsx`
- Modify: `src/components/logs/components/StatusBar.tsx`

**Step 1: Implement server pagination metadata**

- Add safe limit parsing.
- Return pagination object with `nextCursor`, `hasMore`, `returned`, and effective `limit`.

**Step 2: Implement client load-more and retention controls**

- Add `loadOlder`, `hasMoreHistory`, `isLoadingMore`.
- Prepend older logs by cursor while deduplicating.
- Add configurable stream buffer limit in UI state and apply to WebSocket append cap.
- Add toolbar controls for:
- Load older logs.
- History fetch limit.
- Buffer limit.

**Step 3: Run focused tests**

Run:

```bash
npm test -- tests/integration/telemetry/logs-route.test.ts
```

Expected: PASS.

**Step 4: Commit checkpoint**

Run:

```bash
git add app/api/logs/route.ts src/components/logs/hooks/useLogs.ts src/components/LogsView.tsx src/components/logs/components/LogsToolbar.tsx src/components/logs/components/StatusBar.tsx
git commit -m "feat: add cursor-based logs loading and scalable retention controls"
```

### Task 5: Cron History Depth Best-Case+ (TDD + Implementation)

**Files:**

- Modify: `tests/integration/automation/automations-routes.test.ts`
- Modify: `tests/unit/components/cron-view.test.ts`
- Modify: `src/server/automation/service.ts`
- Modify: `app/api/automations/[id]/runs/route.ts`
- Modify: `src/modules/cron/hooks/useCronRules.ts`
- Modify: `src/modules/cron/components/CronView.tsx`

**Step 1: Write failing tests**

- Add route-level test proving >50 runs can be returned when requested (within clamp).
- Add view-level test expectations for history-limit control rendering.

**Step 2: Run targeted tests and verify red**

Run:

```bash
npm test -- tests/integration/automation/automations-routes.test.ts tests/unit/components/cron-view.test.ts
```

Expected: FAIL on current fixed-limit behavior / missing UI.

**Step 3: Implement minimal production changes**

- Forward optional `limit` through automation service to repository.
- Use requested limit in runs route (with clamp).
- Replace fixed history limit in cron hook with selectable state.
- Add Run History limit selector in CronView.

**Step 4: Run targeted tests**

Run:

```bash
npm test -- tests/integration/automation/automations-routes.test.ts tests/unit/components/cron-view.test.ts
```

Expected: PASS.

**Step 5: Commit checkpoint**

Run:

```bash
git add tests/integration/automation/automations-routes.test.ts tests/unit/components/cron-view.test.ts src/server/automation/service.ts app/api/automations/[id]/runs/route.ts src/modules/cron/hooks/useCronRules.ts src/modules/cron/components/CronView.tsx
git commit -m "feat: expand cron run history depth with bounded limits"
```

### Task 6: Final Verification + Documentation

**Files:**

- Modify: `docs/OPENCLAW_WEBAPP_VERGLEICH_UND_UMSETZUNG_2026-02-20.md`

**Step 1: Run full verification for affected scope**

Run:

```bash
npm run typecheck
npm test -- tests/integration/ops/ops-routes.test.ts tests/integration/telemetry/logs-route.test.ts tests/integration/automation/automations-routes.test.ts tests/unit/components/ops-sessions-view.test.ts tests/unit/components/cron-view.test.ts
```

Expected: all commands pass.

**Step 2: Update comparison doc Punkt 7**

- Re-evaluate Punkt 7 as Best-Case+.
- Note what was implemented now vs. what remains.

**Step 3: Commit checkpoint**

Run:

```bash
git add docs/OPENCLAW_WEBAPP_VERGLEICH_UND_UMSETZUNG_2026-02-20.md docs/plans/2026-02-20-point7-best-case-plus-production-plan.md
git commit -m "docs: update point 7 to best-case-plus with implementation status"
```
