# Seven-Point Ops Console Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bring our webapp to a production-ready, integrated Ops Console across all seven areas (`instances`, `sessions`, `usage`, `cron`, `nodes`, `agents`, `logs`) with consistent UX and live operational data.

**Architecture:** Reuse existing runtime services (gateway registry, conversations/messages, control-plane metrics, rooms/personas, automation, logs) and add thin Ops API aggregators where the frontend currently lacks integrated read models. Add dedicated Ops views for missing points and wire them into Sidebar/AppShell while preserving existing routes and ownership/auth checks.

**Tech Stack:** Next.js App Router, React 19, TypeScript, existing repositories/services in `src/server/*`, Vitest.

---

## Pre-Implementation Production Readiness Review

### Scope Coverage Check (7/7)

1. `instances`: Missing dedicated page. Implement with live WebSocket instance/session details.
2. `sessions`: Missing dedicated admin page. Implement list/search + safe actions (rename/reset/delete).
3. `usage`: Present but shallow. Extend with session-level usage lens.
4. `cron`: Already present. Keep integrated and ensure this plan does not regress it.
5. `nodes`: Missing dedicated page. Implement infra/node health + channel/runtime state view.
6. `agents`: Missing dedicated ops view. Implement persona + room runtime overview.
7. `logs`: Already present. Keep and cross-link from new ops pages.

### Production Gates Checklist

- Auth/ownership: Every new API route resolves user context and scopes data per user.
- Error budget UX: Loading, stale, empty, and error states in each view.
- Safe actions: Confirm destructive actions (`delete`) and disable buttons while pending.
- Observability: Reuse logs/health/doctor sources; avoid hidden side effects.
- Performance: Bounded list limits, selective details fetch, no unbounded polling.
- Backward compatibility: Keep existing routes and existing Sidebar items functioning.
- Testability: Unit coverage for navigation and new views + integration tests for new Ops API routes.

### Risks & Mitigations

- Risk: Duplicate semantics between existing `/api/channels/*` routes and new ops endpoints.
  Mitigation: New ops endpoints are read-only aggregators; mutations keep existing APIs.
- Risk: UI sprawl in Sidebar.
  Mitigation: Group new Ops entries contiguously and keep labels explicit.
- Risk: data fetch fanout for agents/nodes.
  Mitigation: Bounded room fetch + per-room state fetch only for top N rooms.

Decision: Plan is production-ready and complete for this iteration.

---

### Task 1: Add Ops API read models for missing areas

**Files:**

- Create: `app/api/ops/instances/route.ts`
- Create: `app/api/ops/sessions/route.ts`
- Create: `app/api/ops/nodes/route.ts`
- Create: `app/api/ops/agents/route.ts`
- Create: `src/modules/ops/types.ts`

**Step 1: Write failing integration tests**

- Add `tests/integration/ops/ops-routes.test.ts` with:
  - `GET /api/ops/instances` returns ws/session summaries.
  - `GET /api/ops/sessions` returns conversations and optional query filtering.
  - `GET /api/ops/nodes` returns control-plane + channels + diagnostics snapshots.
  - `GET /api/ops/agents` returns personas + active room counts + sampled runtime status.

**Step 2: Run test to verify it fails**
Run: `npm test -- tests/integration/ops/ops-routes.test.ts`
Expected: FAIL (routes missing).

**Step 3: Implement minimal routes and shared types**

- Implement routes with user-scoped access and bounded limits.
- Keep responses flat, typed, and frontend-ready (no UI-only transformations in route handlers).

**Step 4: Re-run test to verify it passes**
Run: `npm test -- tests/integration/ops/ops-routes.test.ts`
Expected: PASS.

---

### Task 2: Build dedicated Ops views for instances, sessions, nodes, agents

**Files:**

- Create: `src/modules/ops/hooks/useOpsInstances.ts`
- Create: `src/modules/ops/hooks/useOpsSessions.ts`
- Create: `src/modules/ops/hooks/useOpsNodes.ts`
- Create: `src/modules/ops/hooks/useOpsAgents.ts`
- Create: `src/modules/ops/components/InstancesView.tsx`
- Create: `src/modules/ops/components/SessionsView.tsx`
- Create: `src/modules/ops/components/NodesView.tsx`
- Create: `src/modules/ops/components/AgentsView.tsx`

**Step 1: Write failing unit tests**

- Add tests:
  - `tests/unit/components/ops-instances-view.test.ts`
  - `tests/unit/components/ops-sessions-view.test.ts`
  - `tests/unit/components/ops-nodes-view.test.ts`
  - `tests/unit/components/ops-agents-view.test.ts`
- Cover loading/empty/rendered states and primary action affordances.

**Step 2: Run tests to verify failure**
Run: `npm test -- tests/unit/components/ops-instances-view.test.ts tests/unit/components/ops-sessions-view.test.ts tests/unit/components/ops-nodes-view.test.ts tests/unit/components/ops-agents-view.test.ts`
Expected: FAIL (components missing).

**Step 3: Implement views and hooks**

- Instances: show connected users, connections, uptime buckets.
- Sessions: list/filter conversations; actions via existing `/api/channels/conversations` APIs.
- Nodes: show gateway/runtime health, channels status, automation lease and doctor/health summaries.
- Agents: show personas, active-room counts, room runtime/member status snapshot.

**Step 4: Re-run unit tests**
Run: same as Step 2.
Expected: PASS.

---

### Task 3: Integrate new views in Sidebar/AppShell and keep the 7 points coherent

**Files:**

- Modify: `src/shared/domain/types.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/modules/app-shell/components/AppShellViewContent.tsx`
- Modify: `tests/unit/components/sidebar-cron-item.test.ts`
- Create: `tests/unit/components/sidebar-ops-seven-points.test.ts`
- Modify: `tests/unit/app-shell/default-view-config.test.ts`

**Step 1: Write failing navigation tests**

- Verify Sidebar contains all seven operations points: `Instances`, `Sessions`, `Usage`, `Cron`, `Nodes`, `Agents`, `Logs`.
- Verify new `View` enums resolve via config parser.

**Step 2: Run tests to verify failure**
Run: `npm test -- tests/unit/components/sidebar-ops-seven-points.test.ts tests/unit/app-shell/default-view-config.test.ts`
Expected: FAIL.

**Step 3: Implement integration**

- Add `View.INSTANCES`, `View.SESSIONS`, `View.NODES`, `View.AGENTS`.
- Wire dynamic imports and render blocks for new views.
- Keep existing `View.STATS`, `View.CRON`, `View.LOGS` visible and grouped as Ops cluster.

**Step 4: Re-run tests**
Run: same as Step 2.
Expected: PASS.

---

### Task 4: Improve Usage depth (without breaking existing stats/logs)

**Files:**

- Modify: `src/components/StatsView.tsx`
- Modify: `app/api/stats/route.ts`
- Create: `tests/integration/stats/stats-route-sessions-lens.test.ts`
- Create: `tests/unit/components/stats-view-ops-depth.test.ts`

**Step 1: Write failing tests**

- Add API test for optional session lens payload (`topSessions`, bounded).
- Add UI test ensuring a session-oriented tab/section exists and renders cards/table shell.

**Step 2: Run tests to verify failure**
Run: `npm test -- tests/integration/stats/stats-route-sessions-lens.test.ts tests/unit/components/stats-view-ops-depth.test.ts`
Expected: FAIL.

**Step 3: Implement usage depth**

- Extend stats response with optional session lens summary from message repository (top recent conversations).
- Add session lens panel/tab to StatsView while retaining existing overview/logs behavior.

**Step 4: Re-run tests**
Run: same as Step 2.
Expected: PASS.

---

### Task 5: End-to-end verification and hardening

**Files:**

- Modify as needed for fixes from verification.

**Step 1: Run targeted suites**
Run:
`npm test -- tests/integration/ops/ops-routes.test.ts tests/unit/components/ops-instances-view.test.ts tests/unit/components/ops-sessions-view.test.ts tests/unit/components/ops-nodes-view.test.ts tests/unit/components/ops-agents-view.test.ts tests/unit/components/sidebar-ops-seven-points.test.ts tests/integration/stats/stats-route-sessions-lens.test.ts tests/unit/components/stats-view-ops-depth.test.ts`

Expected: PASS.

**Step 2: Run regression safety suites**
Run:
`npm test -- tests/unit/components/cron-view.test.ts tests/unit/components/sidebar-cron-item.test.ts tests/unit/components/stats-view-tabs.test.ts tests/integration/control-plane-metrics-route.test.ts tests/integration/automation/automations-routes.test.ts`

Expected: PASS.

**Step 3: Typecheck gate**
Run: `npm run typecheck`
Expected: PASS.

**Step 4: Readiness report**

- Confirm all 7 ops points are present and functionally wired.
- Confirm no auth regression in new APIs.
- Confirm destructive session actions require confirmation in UI.
- Confirm empty/error/loading states across all new views.
