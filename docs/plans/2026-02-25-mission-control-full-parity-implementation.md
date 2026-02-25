# Mission Control Full-Parity Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implementiere `crshdn/mission-control` funktionsgleich in dieses System, inklusive neuem Sidebar-Menuepunkt `Mission Control`, produktionsreifem Backend und vollständiger Realtime- und Security-Haertung.

**Architecture:** Wir integrieren Mission Control als neue AppShell-View und bauen die Domain serverseitig auf bestehender OpenClaw-Infrastruktur (`agent-v2`, Gateway WS, vorhandene Auth- und Runtime-Patterns) auf. Persistenz bleibt in der existierenden SQLite (`MESSAGES_DB_PATH`) mit additiven Migrationen und klarer State-Machine fuer Task-Lifecycle und Planning/Dispatch.

**Tech Stack:** Next.js App Router (`app/api`), React 19, TypeScript, better-sqlite3, bestehendes Gateway (`/ws`, `/ws-agent-v2`), SSE fuer Mission-Feed, Vitest.

---

## Execution Context (bereits umgesetzt)

- Worktree: `C:\Users\djm2k\.config\superpowers\worktrees\clawtest\mission-control-parity-2026-02-25`
- Branch: `plan/mission-control-parity-2026-02-25`
- Upstream baseline fuer Paritaet: `crshdn/mission-control` @ `5ccc27a4d65baab169db4a423155f093255fc046` (2026-02-19)

---

## Full Parity Scope (Muss komplett umgesetzt werden)

1. Kanban mit 7 Statusspalten (`planning, inbox, assigned, in_progress, testing, review, done`) inkl. Drag-and-Drop.
2. AI Planning Q&A Flow (Fragen stellen, Antworten sammeln, Approval/Retry/Cancel, auto dispatch).
3. Agent Discovery/Import aus Gateway.
4. OpenClaw Session/Uptime/Model-Proxies.
5. Live Event Feed (SSE) + UI updates in Echtzeit.
6. Workspace Verwaltung + Datei Upload/Download/Preview/Reveal.
7. Activities + Deliverables pro Task.
8. Webhook completion endpoint mit HMAC validation.
9. Security: optional Bearer token auth fuer externe API calls + path traversal hardening.
10. Docker/Runbook/Production Doku fuer den neuen Bereich.

---

## Design Decisions (bindend)

- Keine neue Datenbank: Mission-Control Tabellen in bestehende `messages.db`.
- Realtime dual-path: Gateway Events fuer interne UI + SSE fuer Mission-Control Feed APIs.
- Statuswechsel nur ueber zentrale State-Machine (kein freies, unvalidiertes Dragging).
- API-Kompatibilitaet zum Upstream (`/api/tasks`, `/api/agents`, `/api/openclaw`, `/api/events`, `/api/workspaces`, `/api/files`, `/api/webhooks/agent-completion`).
- AppShell bekommt neue View `MISSION_CONTROL` und Sidebar Label `Mission Control`.
- Rollout erfolgt ueber Feature-Flag + stufenweise Aktivierung (dark launch -> canary -> full rollout) mit dokumentiertem Rollback-Runbook.

---

### Task 1: Domain Contracts + Lifecycle State Machine

**Files:**

- Create: `src/modules/mission-control/types.ts`
- Create: `src/server/mission-control/stateMachine.ts`
- Test: `tests/unit/mission-control/state-machine.test.ts`
- Test: `tests/unit/mission-control/types-contract.test.ts`

**Step 1: Write failing tests**

```ts
expect(TASK_STATUSES).toEqual([
  'planning',
  'inbox',
  'assigned',
  'in_progress',
  'testing',
  'review',
  'done',
]);
expect(canTransition('inbox', 'assigned', false)).toBe(true);
expect(canTransition('in_progress', 'review', true)).toBe(false);
```

**Step 2: Run test to verify failure**

Run: `pnpm vitest run tests/unit/mission-control/state-machine.test.ts tests/unit/mission-control/types-contract.test.ts`
Expected: FAIL (missing modules).

**Step 3: Implement minimal contracts**

```ts
export type MissionTaskStatus =
  | 'planning'
  | 'inbox'
  | 'assigned'
  | 'in_progress'
  | 'testing'
  | 'review'
  | 'done';
```

```ts
export function canTransition(
  from: MissionTaskStatus,
  to: MissionTaskStatus,
  isActiveRun: boolean,
): boolean;
```

**Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/unit/mission-control/state-machine.test.ts tests/unit/mission-control/types-contract.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/mission-control/types.ts src/server/mission-control/stateMachine.ts tests/unit/mission-control/state-machine.test.ts tests/unit/mission-control/types-contract.test.ts
git commit -m "feat(mission-control): add domain contracts and lifecycle state machine"
```

---

### Task 2: SQLite Schema (Mission Control Tables) in Existing messages.db

**Files:**

- Modify: `src/server/channels/messages/repository/migrations/index.ts`
- Modify: `src/server/channels/messages/repository/types.ts`
- Create: `src/server/channels/messages/repository/queries/missionControl.ts`
- Modify: `src/server/channels/messages/sqliteMessageRepository.ts`
- Test: `tests/unit/channels/mission-control-queries.test.ts`
- Test: `tests/integration/channels/mission-control-migrations.test.ts`

**Step 1: Write failing migration/query tests**

Assert tables and indexes exist:

- `mc_workspaces`
- `mc_agents`
- `mc_tasks`
- `mc_planning_questions`
- `mc_planning_specs`
- `mc_task_activities`
- `mc_task_deliverables`
- `mc_events`
- migration backup marker + rollback metadata table (`mc_migration_meta`) exist
- partial migration failure keeps previous app behavior intact (compatibility test)

**Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/unit/channels/mission-control-queries.test.ts tests/integration/channels/mission-control-migrations.test.ts`
Expected: FAIL.

**Step 3: Implement additive migrations and query module**

Add query APIs:

```ts
listTasksByWorkspace(workspaceId: string): MissionTaskRecord[]
updateTaskStatus(taskId: string, status: MissionTaskStatus): void
insertPlanningQuestion(...): void
insertActivity(...): void
insertDeliverable(...): void
appendEvent(...): void
```

Add rollout-safe migration artifacts:

```ts
createMigrationSnapshot(...): void
recordMigrationVersion(...): void
rollbackMissionControlSchema(...): void
```

**Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/unit/channels/mission-control-queries.test.ts tests/integration/channels/mission-control-migrations.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/channels/messages/repository/migrations/index.ts src/server/channels/messages/repository/types.ts src/server/channels/messages/repository/queries/missionControl.ts src/server/channels/messages/sqliteMessageRepository.ts tests/unit/channels/mission-control-queries.test.ts tests/integration/channels/mission-control-migrations.test.ts
git commit -m "feat(mission-control): add sqlite schema and repository queries"
```

---

### Task 3: Mission Service Layer (CRUD, Status, Activities, Deliverables)

**Files:**

- Create: `src/server/mission-control/service.ts`
- Create: `src/server/mission-control/types.ts`
- Test: `tests/unit/mission-control/service-status.test.ts`
- Test: `tests/unit/mission-control/service-activity-deliverables.test.ts`

**Step 1: Write failing service tests**

Cover:

- create/list/update/delete task
- guarded status transitions via state machine
- activity logging on status/dispatch events
- deliverables append and list

**Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/unit/mission-control/service-status.test.ts tests/unit/mission-control/service-activity-deliverables.test.ts`
Expected: FAIL.

**Step 3: Implement service API**

```ts
createTask(input)
updateTaskStatus(input)
startPlanning(taskId)
recordPlanningAnswer(taskId, ...)
recordDispatchResult(taskId, ...)
```

**Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/unit/mission-control/service-status.test.ts tests/unit/mission-control/service-activity-deliverables.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/mission-control/service.ts src/server/mission-control/types.ts tests/unit/mission-control/service-status.test.ts tests/unit/mission-control/service-activity-deliverables.test.ts
git commit -m "feat(mission-control): add mission service layer"
```

---

### Task 4: Planning Engine + Auto Dispatch Bridge to agent-v2

**Files:**

- Create: `src/server/mission-control/planning.ts`
- Create: `src/server/mission-control/dispatch.ts`
- Modify: `src/server/agent-v2/sessionManager.ts`
- Test: `tests/unit/mission-control/planning.test.ts`
- Test: `tests/unit/mission-control/dispatch-agent-v2.test.ts`

**Step 1: Write failing tests**

Cover:

- planning question generation lifecycle
- answer progression and completion
- dispatch creates/uses agent-v2 session + input/follow_up
- retry-dispatch path

**Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/unit/mission-control/planning.test.ts tests/unit/mission-control/dispatch-agent-v2.test.ts`
Expected: FAIL.

**Step 3: Implement planning + dispatch bridge**

```ts
generatePlanningQuestion(taskId);
submitPlanningAnswer(taskId, answer);
dispatchTask(taskId);
retryDispatch(taskId);
```

**Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/unit/mission-control/planning.test.ts tests/unit/mission-control/dispatch-agent-v2.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/mission-control/planning.ts src/server/mission-control/dispatch.ts src/server/agent-v2/sessionManager.ts tests/unit/mission-control/planning.test.ts tests/unit/mission-control/dispatch-agent-v2.test.ts
git commit -m "feat(mission-control): add planning and agent-v2 dispatch bridge"
```

---

### Task 5: Tasks API Family (`/api/tasks/*`) Full Upstream Parity

**Files:**

- Create: `app/api/tasks/route.ts`
- Create: `app/api/tasks/[id]/route.ts`
- Create: `app/api/tasks/[id]/dispatch/route.ts`
- Create: `app/api/tasks/[id]/planning/route.ts`
- Create: `app/api/tasks/[id]/planning/answer/route.ts`
- Create: `app/api/tasks/[id]/planning/poll/route.ts`
- Create: `app/api/tasks/[id]/planning/approve/route.ts`
- Create: `app/api/tasks/[id]/planning/retry-dispatch/route.ts`
- Create: `app/api/tasks/[id]/activities/route.ts`
- Create: `app/api/tasks/[id]/deliverables/route.ts`
- Create: `app/api/tasks/[id]/subagent/route.ts`
- Create: `app/api/tasks/[id]/test/route.ts`
- Test: `tests/integration/mission-control/tasks-api.test.ts`

**Step 1: Write failing integration tests**

Cover full REST flow: create task -> planning -> answer -> dispatch -> activities/deliverables.
Add authorization isolation tests:

- user A cannot read/patch/delete user B workspace/task
- workspace scoped access is enforced on every task endpoint

**Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/integration/mission-control/tasks-api.test.ts`
Expected: FAIL.

**Step 3: Implement route handlers using mission service**

Every route:

- `resolveRequestUserContext()` auth gate
- zod-like payload validation (existing style)
- structured `{ ok, ... }` responses
- workspace/user ownership checks before any read/write

**Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/integration/mission-control/tasks-api.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add app/api/tasks src/server/mission-control tests/integration/mission-control/tasks-api.test.ts
git commit -m "feat(mission-control): implement tasks and planning api family"
```

---

### Task 6: Workspaces API + Workspace View Contracts

**Files:**

- Create: `app/api/workspaces/route.ts`
- Create: `app/api/workspaces/[id]/route.ts`
- Create: `src/server/mission-control/workspaceService.ts`
- Test: `tests/integration/mission-control/workspaces-api.test.ts`

**Step 1: Write failing tests**

Cover create/list/get workspace incl. computed stats (`taskCount`, `openCount`, `doneCount`).

**Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/integration/mission-control/workspaces-api.test.ts`
Expected: FAIL.

**Step 3: Implement workspace service + routes**

Use `mc_workspaces` and mission task aggregates.

**Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/integration/mission-control/workspaces-api.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add app/api/workspaces src/server/mission-control/workspaceService.ts tests/integration/mission-control/workspaces-api.test.ts
git commit -m "feat(mission-control): add workspaces api and stats"
```

---

### Task 7: Agents + OpenClaw APIs (`/api/agents`, `/api/openclaw/*`)

**Files:**

- Create: `app/api/agents/route.ts`
- Create: `app/api/agents/[id]/route.ts`
- Create: `app/api/agents/discover/route.ts`
- Create: `app/api/agents/import/route.ts`
- Create: `app/api/agents/[id]/openclaw/route.ts`
- Create: `app/api/openclaw/status/route.ts`
- Create: `app/api/openclaw/models/route.ts`
- Create: `app/api/openclaw/orchestra/route.ts`
- Create: `app/api/openclaw/sessions/route.ts`
- Create: `app/api/openclaw/sessions/[id]/route.ts`
- Create: `app/api/openclaw/sessions/[id]/history/route.ts`
- Create: `src/server/mission-control/openclawClient.ts`
- Test: `tests/integration/mission-control/agents-openclaw-api.test.ts`

**Step 1: Write failing integration tests**

Cover discover/import/list agents and status/sessions proxy behavior.

**Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/integration/mission-control/agents-openclaw-api.test.ts`
Expected: FAIL.

**Step 3: Implement OpenClaw bridge + routes**

Reuse existing gateway credentials and auth context.

**Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/integration/mission-control/agents-openclaw-api.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add app/api/agents app/api/openclaw src/server/mission-control/openclawClient.ts tests/integration/mission-control/agents-openclaw-api.test.ts
git commit -m "feat(mission-control): add agents and openclaw parity endpoints"
```

---

### Task 8: Events + SSE + Webhook + File APIs

**Files:**

- Create: `app/api/events/route.ts`
- Create: `app/api/events/stream/route.ts`
- Create: `app/api/webhooks/agent-completion/route.ts`
- Create: `app/api/files/upload/route.ts`
- Create: `app/api/files/download/route.ts`
- Create: `app/api/files/preview/route.ts`
- Create: `app/api/files/reveal/route.ts`
- Create: `src/server/mission-control/events.ts`
- Create: `src/server/mission-control/webhook.ts`
- Test: `tests/integration/mission-control/events-sse-webhook-files.test.ts`

**Step 1: Write failing integration tests**

Cover:

- SSE connect + event push
- webhook signature validation
- file path traversal rejection
- upload/download/preview flow
- webhook replay/idempotency handling
- SSE stream only emits events for authorized user/workspace scope

**Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/integration/mission-control/events-sse-webhook-files.test.ts`
Expected: FAIL.

**Step 3: Implement event broadcaster + endpoints**

- SSE keepalive
- `WEBHOOK_SECRET` HMAC
- workspace boundary checks via resolved absolute paths

**Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/integration/mission-control/events-sse-webhook-files.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add app/api/events app/api/webhooks/agent-completion app/api/files src/server/mission-control/events.ts src/server/mission-control/webhook.ts tests/integration/mission-control/events-sse-webhook-files.test.ts
git commit -m "feat(mission-control): add realtime events webhook and file api"
```

---

### Task 9: Mission Control Frontend Data Store + SSE Hook

**Files:**

- Create: `src/modules/mission-control/store.ts`
- Create: `src/modules/mission-control/hooks/useSSE.ts`
- Create: `src/modules/mission-control/lib/planning-utils.ts`
- Test: `tests/unit/modules/mission-control/store.test.ts`
- Test: `tests/unit/modules/mission-control/use-sse.test.ts`

**Step 1: Write failing tests**

Cover state updates from SSE events and task/event deduplication.

**Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/unit/modules/mission-control/store.test.ts tests/unit/modules/mission-control/use-sse.test.ts`
Expected: FAIL.

**Step 3: Implement store + SSE hook**

Store state slices: `workspaces`, `tasks`, `agents`, `events`, `planningSessions`, `connectionState`.

**Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/unit/modules/mission-control/store.test.ts tests/unit/modules/mission-control/use-sse.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/mission-control/store.ts src/modules/mission-control/hooks/useSSE.ts src/modules/mission-control/lib/planning-utils.ts tests/unit/modules/mission-control/store.test.ts tests/unit/modules/mission-control/use-sse.test.ts
git commit -m "feat(mission-control): add frontend store and sse integration"
```

---

### Task 10: Core Mission Control UI Components (Parity Build)

**Files:**

- Create: `src/modules/mission-control/components/MissionControlView.tsx`
- Create: `src/modules/mission-control/components/WorkspaceDashboard.tsx`
- Create: `src/modules/mission-control/components/MissionQueue.tsx`
- Create: `src/modules/mission-control/components/TaskModal.tsx`
- Create: `src/modules/mission-control/components/PlanningTab.tsx`
- Create: `src/modules/mission-control/components/AgentsSidebar.tsx`
- Create: `src/modules/mission-control/components/LiveFeed.tsx`
- Create: `src/modules/mission-control/components/ActivityLog.tsx`
- Create: `src/modules/mission-control/components/DeliverablesList.tsx`
- Create: `src/modules/mission-control/components/DiscoverAgentsModal.tsx`
- Test: `tests/unit/components/mission-control-view.test.tsx`
- Test: `tests/unit/components/mission-queue-kanban.test.tsx`
- Test: `tests/unit/components/task-modal-planning-tabs.test.tsx`

**Step 1: Write failing UI tests**

Cover:

- 7-column Kanban rendering
- drag status move invokes PATCH
- modal tabs (overview/planning/activity/deliverables/sessions)
- live feed + agents sidebar presence

**Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/unit/components/mission-control-view.test.tsx tests/unit/components/mission-queue-kanban.test.tsx tests/unit/components/task-modal-planning-tabs.test.tsx`
Expected: FAIL.

**Step 3: Implement components**

Follow upstream composition but adapt to AppShell design tokens.

**Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/unit/components/mission-control-view.test.tsx tests/unit/components/mission-queue-kanban.test.tsx tests/unit/components/task-modal-planning-tabs.test.tsx`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/mission-control/components tests/unit/components/mission-control-view.test.tsx tests/unit/components/mission-queue-kanban.test.tsx tests/unit/components/task-modal-planning-tabs.test.tsx
git commit -m "feat(mission-control): implement workspace dashboard queue and task modal"
```

---

### Task 11: AppShell Integration + Sidebar Menu Item `Mission Control`

**Files:**

- Modify: `src/shared/domain/types.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/modules/app-shell/components/AppShellViewContent.tsx`
- Modify: `src/modules/app-shell/App.tsx`
- Test: `tests/unit/components/sidebar-mission-control-nav.test.tsx`
- Test: `tests/unit/modules/app-shell/mission-control-view-routing.test.ts`

**Step 1: Write failing routing/navigation tests**

Assert:

- `View.MISSION_CONTROL` exists
- Sidebar label `Mission Control` exists
- view switch renders `MissionControlView`

**Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/unit/components/sidebar-mission-control-nav.test.tsx tests/unit/modules/app-shell/mission-control-view-routing.test.ts`
Expected: FAIL.

**Step 3: Implement integration**

- Add enum value
- Add sidebar item
- Add dynamic import and view branch
- Ensure data-loading toggles include mission-control requirements

**Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/unit/components/sidebar-mission-control-nav.test.tsx tests/unit/modules/app-shell/mission-control-view-routing.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/shared/domain/types.ts src/components/Sidebar.tsx src/modules/app-shell/components/AppShellViewContent.tsx src/modules/app-shell/App.tsx tests/unit/components/sidebar-mission-control-nav.test.tsx tests/unit/modules/app-shell/mission-control-view-routing.test.ts
git commit -m "feat(mission-control): add app-shell view and sidebar navigation"
```

---

### Task 12: Security Hardening (Bearer Token, Validation, Headers)

**Files:**

- Create: `src/server/mission-control/auth.ts`
- Create: `src/server/mission-control/validation.ts`
- Create: `app/middleware.ts`
- Modify: `app/api/tasks/**`
- Modify: `app/api/agents/**`
- Modify: `app/api/openclaw/**`
- Modify: `app/api/files/**`
- Modify: `app/api/events/**`
- Test: `tests/integration/mission-control/security.test.ts`

**Step 1: Write failing security tests**

Cover:

- external API access requires `Authorization: Bearer` when `MC_API_TOKEN` is set
- invalid payload rejects with 400
- security headers present
- SSE token query param handling
- cross-tenant access attempts return 403/404 consistently
- rate-limit behavior for mission-critical write endpoints

**Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/integration/mission-control/security.test.ts`
Expected: FAIL.

**Step 3: Implement hardening**

- token guard helper for mission endpoints
- strict input validation
- middleware security headers for mission routes

**Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/integration/mission-control/security.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/mission-control/auth.ts src/server/mission-control/validation.ts app/middleware.ts app/api/tasks app/api/agents app/api/openclaw app/api/files app/api/events tests/integration/mission-control/security.test.ts
git commit -m "feat(mission-control): harden mission endpoints and middleware security"
```

---

### Task 13: Production Ops (Docker, Env, Runbooks, Troubleshooting)

**Files:**

- Modify: `.env.local.example`
- Modify: `README.md`
- Create: `docs/MISSION_CONTROL_RUNBOOK.md`
- Modify: `docker-compose.yml`
- Modify: `Dockerfile`
- Test: `tests/integration/mission-control/env-contract.test.ts`

**Step 1: Write failing env contract test**

Assert required vars and sane defaults:

- `OPENCLAW_GATEWAY_URL`
- `OPENCLAW_GATEWAY_TOKEN`
- `MC_API_TOKEN` (optional)
- `WEBHOOK_SECRET` (optional but required when webhook enabled)

**Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/integration/mission-control/env-contract.test.ts`
Expected: FAIL.

**Step 3: Implement docs + compose updates**

- add mission-control section to runtime docs
- add volume paths for mission workspace/files
- include production checklist and incident playbook

**Step 4: Run test to verify pass**

Run: `pnpm vitest run tests/integration/mission-control/env-contract.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add .env.local.example README.md docs/MISSION_CONTROL_RUNBOOK.md docker-compose.yml Dockerfile tests/integration/mission-control/env-contract.test.ts
git commit -m "docs(mission-control): add production runbook and env/docker contracts"
```

---

### Task 14: End-to-End Verification + Quality Gates (Happy + Failure Paths)

**Files:**

- Modify: `.agent/CONTINUITY.md`
- Create: `tests/e2e/mission-control-parity.e2e.test.ts`
- Create: `tests/integration/mission-control/full-parity-smoke.test.ts`
- Create: `tests/integration/mission-control/failure-paths.test.ts`

**Step 1: Write failing parity smoke + failure-path tests**

Smoke checklist:

1. create workspace
2. create task
3. run planning Q&A
4. dispatch to agent-v2
5. stream events
6. add deliverable/activity
7. move statuses across kanban
8. complete task
9. webhook completion updates task
10. simulate agent-v2 outage and verify graceful task state + user-visible error
11. simulate SSE disconnect/reconnect and verify no duplicate/missing events
12. invalid webhook signature/replay is rejected and logged

**Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/integration/mission-control/full-parity-smoke.test.ts tests/integration/mission-control/failure-paths.test.ts`
Expected: FAIL.

**Step 3: Run full verification suite**

Run:

- `pnpm vitest run tests/unit/mission-control tests/integration/mission-control`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`
- `pnpm test:e2e:smoke` (or targeted e2e if env constrained)

**Step 4: Fix regressions until green**

Expected: no new lint/type errors, mission-control happy and failure-path tests pass.

**Step 5: Commit**

```bash
git add tests/e2e/mission-control-parity.e2e.test.ts tests/integration/mission-control/full-parity-smoke.test.ts tests/integration/mission-control/failure-paths.test.ts .agent/CONTINUITY.md
git commit -m "test(mission-control): add parity smoke and failure-path coverage"
```

---

### Task 15: Observability, SLOs, and Alerting

**Files:**

- Modify: `app/api/control-plane/metrics/route.ts`
- Create: `src/server/mission-control/metrics.ts`
- Create: `docs/MISSION_CONTROL_SLO.md`
- Create: `tests/integration/mission-control/metrics-slo.test.ts`

**Step 1: Write failing metrics/SLO tests**

Cover:

- mission counters exposed (`tasks_created_total`, `dispatch_failures_total`, `webhook_rejected_total`)
- latency percentiles for mission APIs
- SSE lag and stream count metrics

**Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/integration/mission-control/metrics-slo.test.ts`
Expected: FAIL.

**Step 3: Implement metrics + SLO docs**

- add mission metric aggregation
- define SLO targets, error budgets, and alert thresholds
- document alert runbook links

**Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/integration/mission-control/metrics-slo.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add app/api/control-plane/metrics/route.ts src/server/mission-control/metrics.ts docs/MISSION_CONTROL_SLO.md tests/integration/mission-control/metrics-slo.test.ts
git commit -m "feat(mission-control): add observability metrics and slo contracts"
```

---

### Task 16: Load, Backpressure, and Resilience Testing

**Files:**

- Create: `scripts/load/mission-control-load.ts`
- Create: `tests/integration/mission-control/load-resilience.test.ts`
- Modify: `docs/MISSION_CONTROL_RUNBOOK.md`

**Step 1: Write failing resilience tests**

Cover:

- burst create/update under load
- dispatch queue backpressure
- SSE fanout with many clients
- webhook duplicate delivery idempotency

**Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/integration/mission-control/load-resilience.test.ts`
Expected: FAIL.

**Step 3: Implement load harness + safeguards**

- scripted load profile
- explicit backpressure/timeout/retry limits
- saturation troubleshooting section

**Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/integration/mission-control/load-resilience.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/load/mission-control-load.ts tests/integration/mission-control/load-resilience.test.ts docs/MISSION_CONTROL_RUNBOOK.md
git commit -m "test(mission-control): add load and resilience coverage"
```

---

### Task 17: Canary Rollout + Rollback Drill

**Files:**

- Modify: `docs/MISSION_CONTROL_RUNBOOK.md`
- Create: `tests/integration/mission-control/rollback-drill.test.ts`

**Step 1: Write failing rollback drill test**

Cover:

- feature flag off blocks mission-control surface
- canary-on scope behaves correctly
- rollback restores previous behavior after mission-control disable

**Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/integration/mission-control/rollback-drill.test.ts`
Expected: FAIL.

**Step 3: Implement release playbook**

- stages: dark launch, internal canary, staged rollout, full release
- go/no-go gates (error-rate, queue-depth, SLOs)
- rollback commands + schema compatibility checks

**Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/integration/mission-control/rollback-drill.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add docs/MISSION_CONTROL_RUNBOOK.md tests/integration/mission-control/rollback-drill.test.ts
git commit -m "docs(mission-control): add canary rollout and rollback drill"
```

---

## Final Acceptance Criteria

- Sidebar hat neuen Eintrag `Mission Control`.
- Mission Control deckt alle upstream Features funktional ab.
- APIs sind upstream-kompatibel und auth-hardened.
- Persistenz ist in vorhandener `messages.db` integriert (keine zweite DB).
- Planning + Dispatch funktionieren ueber bestehenden OpenClaw/agent-v2 Stack.
- Realtime updates laufen stabil ueber SSE + Gateway Events.
- Docker + Runbook + troubleshooting sind dokumentiert.
- Migrationen sind rollout-sicher (snapshot, rollback-path, compatibility checks).
- Tenant-Isolation ist fuer alle Mission-Endpunkte und Event-Streams getestet.
- Observability + SLO-Dashboard + Alerts sind aktiv und dokumentiert.
- Load/Resilience tests sind gruen und reproduzierbar.
- Quality gates (`typecheck`, `lint`, tests, build) sind sauber oder bekannte Baselineabweichungen explizit dokumentiert.

---

## Risks + Mitigation

- **Risk:** Race conditions bei Kanban Drag waehrend aktiver Ausfuehrung.
  - **Mitigation:** zentrale state machine + optimistic lock auf `updated_at`.
- **Risk:** Planning JSON ist model-abhaengig instabil.
  - **Mitigation:** strict parser + retry + fallback question generator.
- **Risk:** Event storms bei SSE/WS Doppelpfad.
  - **Mitigation:** event dedupe key (`event_id`) + bounded buffers.
- **Risk:** Unvollstaendige Upstream parity bei seltenen endpoints.
  - **Mitigation:** parity smoke test gegen dokumentierte upstream endpoint matrix.
- **Risk:** Shared SQLite migration breaks unrelated runtime paths.
  - **Mitigation:** pre-deploy snapshot, additive schema discipline, rollback drill.
- **Risk:** Cross-tenant data leakage through mission endpoints or streams.
  - **Mitigation:** explicit ownership checks + negative authorization integration tests.
- **Risk:** Production degradation under event/dispatch burst.
  - **Mitigation:** backpressure limits, load tests, SLO alerting, canary rollout gates.

---

Plan complete and saved to `docs/plans/2026-02-25-mission-control-full-parity-implementation.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
