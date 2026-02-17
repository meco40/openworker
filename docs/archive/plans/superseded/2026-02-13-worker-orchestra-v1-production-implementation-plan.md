# Worker Orchestra V1 Production Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver Worker Orchestra V1 as a production-ready capability with two new UX tabs (`Workflow`, `Orchestra`), visual graph-based automation, persona-to-model binding, user-scoped ownership safety, and full transparency logs (subagent sessions, activities, deliverables).

**Architecture:** Keep the existing Worker runtime and Rooms orchestration foundations, then add an Orchestra layer for graph definitions (template-based editing + publish lifecycle), graph run state, and live visualization. `Orchestra` is the global builder/config tab; `Workflow` is the per-task live execution tab for the current run only.

**Tech Stack:** Next.js route handlers, React 19, TypeScript, better-sqlite3 (worker/persona DBs), existing Gateway events, Vitest (unit + integration), existing Worker/Rooms services.

---

## 1) Gap Analysis (Current Decision Plan vs Production-Ready Plan)

Current decision plan is strong on product direction, but not yet sufficient for implementation because it is missing:

1. A hard decision for release lifecycle (`Draft + Publish` vs alternatives).
2. Exact file-by-file implementation breakdown.
3. Test-first sequencing and mandatory test gates per phase.
4. Git isolation strategy (worktree/branch flow, commit cadence).
5. Rollout, rollback, and operations readiness criteria.

This document closes those gaps.

## 2) Decision Freeze For Execution

All decisions below are fixed for V1 execution:

1. `Workflow` tab = task-level live run graph (current run only, read-only).
2. `Orchestra` tab = global workspace graph builder (editable, template-bounded).
3. Routing = static edges + optional LLM selection only among allowed next nodes.
4. Scheduler = centralized master scheduler.
5. Failure policy = fail-fast.
6. Retry = none in V1.
7. Flow release model = **Draft + Publish** (selected to make production operation safe).
8. Concurrency scope in V1 = parallelism for independent nodes **within one active run**; global task queue remains single-active-task unless explicitly refactored.

## 2.1) Critical Conflicts With Current System (And Resolutions)

These are real conflicts identified against current code and are mandatory to address:

1. Worker APIs are currently not user-scoped/auth-scoped by default (`app/api/worker/route.ts` and `app/api/worker/[id]/route.ts`).
   Resolution: add user context resolution and owner scoping for all new Orchestra and Workflow APIs; prevent cross-user flow/task access.

2. No explicit flow binding currently exists from task -> published flow.
   Resolution: add `flow_published_id` and `current_run_id` tracking in worker task records (or equivalent binding table) before scheduler integration.

3. Existing `worker_artifacts` and new deliverables can diverge.
   Resolution: define canonical export source (`worker_task_deliverables`) and compatibility mapping from legacy artifacts.

4. Existing activity type model differs from mission-control naming.
   Resolution: introduce normalized activity taxonomy and migration-safe compatibility mapping in API/UI.

5. Persona model binding requires model ownership/availability checks.
   Resolution: validate `preferred_model_id` against the user's ModelHub view; fallback chain must be deterministic and logged.

6. Draft edits must never mutate published runs.
   Resolution: immutable published snapshots + run references to exact published version id.

7. Workspace taxonomy in code still allows `creative`, while product decision is `Auto + 4 Presets` without `Kreativ`.
   Resolution: V1 orchestra templates and flow assignment must use the active preset taxonomy only (`research`, `webapp`, `data`, `general`, plus auto mapping rules).

8. Model precedence conflict: existing systems can apply model override at runtime.
   Resolution: enforce and document one precedence chain. In V1 (no node override): `persona.preferred_model_id -> workspace default model`. Later extensions must prepend node override explicitly.

## 3) Git Worktree Strategy (Requested "git three" usage)

Use isolated worktree execution for this feature to avoid cross-feature contamination.

### Task 0: Worktree Setup And Baseline Verification

**Files:**

- Verify: `.gitignore`
- Use existing: `.worktrees/`

**Step 1: Verify worktree directory and ignore safety**

Run:

```bash
git check-ignore -v .worktrees
```

Expected: `.gitignore` contains `.worktrees/` and check-ignore confirms ignore.

**Step 2: Create dedicated worktree and feature branch**

Run:

```bash
git worktree add .worktrees/worker-orchestra-v1 -b feat/worker-orchestra-v1
```

**Step 3: Install deps and verify clean baseline in worktree**

Run:

```bash
npm install
npm run typecheck
npm run test -- tests/unit/worker/worker-state-machine.test.ts
npm run test -- tests/integration/rooms/rooms-runtime.test.ts
```

**Step 4: Commit baseline marker**

Run:

```bash
git add docs/plans/2026-02-13-worker-orchestra-v1-production-implementation-plan.md
git commit -m "docs: add worker orchestra v1 production implementation plan"
```

## 4) Non-Regression Guardrails (Release Blockers)

Do not merge if any of these regress:

1. Worker baseline behavior (`queued -> planning -> executing -> completed/failed`) still works.
2. Rooms runtime stability tests still pass.
3. Existing Worker tabs (`Schritte`, `Dateien`, `Output`, `Aktivitaeten`, `Terminal`, `Planung`) do not break.
4. Existing auth/ownership checks on persona and room APIs remain intact.

Mandatory baseline commands:

```bash
npm run test -- tests/unit/worker/worker-planning.test.ts
npm run test -- tests/unit/worker/worker-state-machine.test.ts
npm run test -- tests/unit/rooms/orchestrator-reentrancy.test.ts
npm run test -- tests/integration/rooms/rooms-runtime.test.ts
npm run test -- tests/integration/worker-api-files.test.ts
npm run test -- tests/unit/worker/worker-callback.test.ts
```

## 5) Implementation Tasks (TDD + frequent commits)

### Task 1: Add Orchestra Domain Types And Schema

**Files:**

- Create: `src/server/worker/orchestraTypes.ts`
- Modify: `src/server/worker/workerTypes.ts`
- Modify: `src/server/worker/workerRepository.ts`
- Modify: `src/server/worker/workerRowMappers.ts`
- Test: `tests/unit/worker/orchestra-schema.test.ts`

**Step 1: Write failing schema/type tests**

Add tests for tables/columns:

1. `worker_flow_templates`
2. `worker_flow_drafts`
3. `worker_flow_published`
4. `worker_runs`
5. `worker_run_nodes`
6. `worker_subagent_sessions`
7. `worker_task_deliverables`
8. `worker_tasks.flow_published_id`
9. `worker_tasks.current_run_id`
10. owner scope columns (for flows/runs) where applicable

Run:

```bash
npm run test -- tests/unit/worker/orchestra-schema.test.ts
```

Expected: FAIL (missing schema and mappers).

**Step 2: Implement minimal schema and row mapping**

Add migration-safe table creation to `workerRepository.ts` and mapping helpers.

**Step 3: Re-run targeted tests**

Run:

```bash
npm run test -- tests/unit/worker/orchestra-schema.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/server/worker/orchestraTypes.ts src/server/worker/workerTypes.ts src/server/worker/workerRepository.ts src/server/worker/workerRowMappers.ts tests/unit/worker/orchestra-schema.test.ts
git commit -m "feat(worker): add orchestra schema and domain types"
```

### Task 2A: User Scope And Auth Hardening For Worker/Orchestra APIs

**Files:**

- Modify: `app/api/worker/route.ts`
- Modify: `app/api/worker/[id]/route.ts`
- Modify: `app/api/worker/[id]/activities/route.ts`
- Create: `app/api/worker/orchestra/flows/route.ts`
- Create: `app/api/worker/orchestra/flows/[id]/route.ts`
- Create: `app/api/worker/orchestra/flows/[id]/publish/route.ts`
- Modify: `src/server/worker/workerRepository.ts`
- Test: `tests/integration/worker/orchestra-auth-guard.test.ts`
- Test: `tests/integration/worker/orchestra-user-scope.test.ts`

**Step 1: Write failing auth/scope tests**

Cover:

1. unauthenticated access blocked where required.
2. authenticated user cannot read/update another user's flow.
3. task-level workflow endpoints reject cross-user task id access.

**Step 2: Implement ownership and scope guards**

Add user context resolution and owner checks for all orchestra read/write endpoints.

**Step 3: Run tests and commit**

### Task 2B: Persona -> Model Binding Through Persona Repository

**Files:**

- Modify: `src/server/personas/personaTypes.ts`
- Modify: `src/server/personas/personaRepository.ts`
- Modify: `app/api/personas/route.ts`
- Modify: `app/api/personas/[id]/route.ts`
- Test: `tests/unit/personas/persona-preferred-model.test.ts`
- Test: `tests/integration/personas/personas-model-binding-route.test.ts`
- Test: `tests/integration/personas/personas-model-binding-validation.test.ts`

**Step 1: Write failing unit and integration tests**

Validate:

1. `preferred_model_id` persists and is returned.
2. Updates are user-scoped and cannot cross user boundaries.
3. Invalid or unavailable model ids are rejected.
4. Runtime model precedence chain is deterministic and logged.

**Step 2: Implement migration + API payload support**

Add nullable `preferred_model_id` to personas table and route payload handling with validation against ModelHub-visible models for the current user.

**Step 3: Run tests**

```bash
npm run test -- tests/unit/personas/persona-preferred-model.test.ts
npm run test -- tests/integration/personas/personas-model-binding-route.test.ts
```

**Step 4: Commit**

### Task 3: Orchestra Graph Validation Core

**Files:**

- Create: `src/server/worker/orchestraGraph.ts`
- Create: `src/server/worker/orchestraValidator.ts`
- Test: `tests/unit/worker/orchestra-graph-validation.test.ts`

**Step 1: Write failing validator tests**

Cover:

1. valid DAG passes.
2. cycle rejected.
3. orphan node rejected.
4. edge to unknown node rejected.
5. node persona missing rejected.
6. LLM routing options outside allowed edges rejected.
7. node references to unauthorized persona rejected.

**Step 2: Implement validator + helper utilities**

Minimal deterministic validation for template-bounded graphs.

**Step 3: Run tests and commit**

### Task 4: Draft/Publish Flow APIs (Global Orchestra Tab Backend)

**Files:**

- Create: `app/api/worker/orchestra/flows/route.ts`
- Create: `app/api/worker/orchestra/flows/[id]/route.ts`
- Create: `app/api/worker/orchestra/flows/[id]/publish/route.ts`
- Create: `src/server/worker/orchestraService.ts`
- Modify: `src/server/worker/workerRepository.ts`
- Test: `tests/integration/worker/orchestra-flows-routes.test.ts`

**Step 1: Write failing integration tests**

Cover:

1. create draft flow.
2. update draft flow.
3. publish draft -> active published version.
4. list flows includes latest published metadata.
5. invalid graph returns 400 with validator error.
6. editing draft does not mutate previously published snapshots.

**Step 2: Implement routes + service methods**

Enforce `Draft + Publish` contract strictly with immutable published snapshots and version pinning.

**Step 3: Run tests and commit**

### Task 5: Runtime Scheduler For Orchestra Graph Runs

**Files:**

- Create: `src/server/worker/orchestraScheduler.ts`
- Create: `src/server/worker/orchestraRunner.ts`
- Modify: `src/server/worker/workerAgent.ts`
- Modify: `src/server/worker/workerExecutor.ts`
- Test: `tests/unit/worker/orchestra-scheduler.test.ts`
- Test: `tests/integration/worker/orchestra-run-failfast.test.ts`

**Step 1: Write failing tests**

Cover:

1. master selects runnable nodes by dependency completion.
2. independent nodes can be scheduled in parallel.
3. first node failure sets run failed immediately (fail-fast).
4. no retry performed.
5. run is pinned to a single published flow version id from start to finish.

**Step 2: Implement scheduler + integration hook**

`workerAgent` chooses orchestra path when a published flow is attached to task/workspace type. In V1, keep global queue behavior unchanged; parallelism is inside the active run graph only.

**Step 3: Run tests and commit**

### Task 6: Mission-Control Transparency Layer (Subagent Sessions + Activities + Deliverables)

**Files:**

- Modify: `src/server/worker/workerRepository.ts`
- Create: `app/api/worker/[id]/subagents/route.ts`
- Create: `app/api/worker/[id]/deliverables/route.ts`
- Modify: `app/api/worker/[id]/activities/route.ts`
- Modify: `src/server/worker/workerCallback.ts`
- Test: `tests/integration/worker/orchestra-subagent-sessions.test.ts`
- Test: `tests/integration/worker/orchestra-deliverables-route.test.ts`
- Test: `tests/integration/worker/orchestra-activities-route.test.ts`

**Step 1: Write failing integration tests**

Validate:

1. subagent session create/list/update.
2. activity events are persisted and ordered.
3. deliverables are persisted and exportable.
4. artifact-to-deliverable compatibility mapping remains intact for legacy tasks.

**Step 2: Implement persistence + route handlers**

Keep payload shape stable and strict typed. Define canonical export source as `worker_task_deliverables` and backfill/bridge from `worker_artifacts` where required.

**Step 3: Run tests and commit**

### Task 7: Workflow Live API And Event Stream Contract

**Files:**

- Create: `app/api/worker/[id]/workflow/route.ts`
- Modify: `src/server/gateway/events.ts`
- Modify: `src/server/worker/workerAgent.ts`
- Test: `tests/integration/worker/orchestra-workflow-route.test.ts`
- Test: `tests/unit/worker/orchestra-event-payload.test.ts`

**Step 1: Write failing contract tests**

Contract includes:

1. nodes with status (`pending|running|completed|failed|skipped`).
2. edges and active path.
3. current node and timestamp.

**Step 2: Implement route + broadcast payload**

Ensure backward compatibility for existing `worker.status` listeners.

**Step 3: Run tests and commit**

### Task 8: UI - Add Global `Orchestra` Builder Tab

**Files:**

- Modify: `WorkerView.tsx`
- Create: `components/worker/WorkerOrchestraTab.tsx`
- Create: `src/modules/worker/hooks/useWorkerOrchestraFlows.ts`
- Modify: `styles/worker.css`
- Test: `tests/unit/worker/worker-orchestra-tab.test.tsx`

**Step 1: Write failing component tests**

Cover:

1. tab visible and selectable from worker view.
2. flow list loads.
3. create/edit draft with template-bounded controls.
4. publish action reflected in UI state.

**Step 2: Implement tab and hook**

No free-form topology in V1. Only template-bounded edits.

**Step 3: Run tests and commit**

### Task 9: UI - Add Task-Level `Workflow` Live Graph Tab

**Files:**

- Modify: `components/worker/WorkerTaskDetail.tsx`
- Create: `components/worker/WorkerWorkflowTab.tsx`
- Create: `src/modules/worker/hooks/useWorkerWorkflow.ts`
- Modify: `styles/worker.css`
- Test: `tests/unit/worker/worker-workflow-tab.test.tsx`

**Step 1: Write failing tests**

Cover:

1. new `Workflow` tab appears for task detail.
2. graph renders current run node states.
3. only current run is shown (no history list in V1).

**Step 2: Implement tab wiring + live polling/subscription**

Prefer existing gateway event client; add route fallback polling.

**Step 3: Run tests and commit**

### Task 10: Security, Quotas, And Safety Guards

**Files:**

- Create: `src/server/worker/orchestraPolicy.ts`
- Modify: `src/server/worker/orchestraScheduler.ts`
- Modify: `src/server/worker/workerExecutor.ts`
- Test: `tests/unit/worker/orchestra-policy.test.ts`
- Test: `tests/integration/worker/orchestra-auth-guard.test.ts`

**Step 1: Write failing tests**

Cover:

1. role-based write operations for orchestra builder.
2. per-run node limit and edge limit.
3. command approvals still enforced under orchestra path.
4. publish permission and draft-write permission are enforced independently.

**Step 2: Implement policy checks and hard limits**

Fail closed with explicit errors.

**Step 3: Run tests and commit**

### Task 11: Export UX And Deliverable-First Downloads

**Files:**

- Modify: `app/api/worker/[id]/export/route.ts`
- Modify: `components/worker/WorkerTaskDetail.tsx`
- Test: `tests/integration/worker/orchestra-export-route.test.ts`
- Test: `tests/unit/worker/worker-task-detail-deliverables.test.tsx`

**Step 1: Write failing tests**

Validate zip now prioritizes deliverables and includes machine-readable manifest.

**Step 2: Implement export manifest and UI affordances**

Add `deliverables.json` + improved naming.

**Step 3: Run tests and commit**

### Task 12: Ops Readiness (Metrics, Runbook, Rollout Flags)

**Files:**

- Create: `docs/runbooks/worker-orchestra-v1-rollout.md`
- Modify: `src/server/gateway/events.ts`
- Modify: `app/api/control-plane/metrics/route.ts`
- Test: `tests/integration/control-plane-metrics-route.test.ts`

**Step 1: Add rollout flags**

1. `WORKER_ORCHESTRA_ENABLED`
2. `WORKER_ORCHESTRA_BUILDER_WRITE_ENABLED`
3. `WORKER_WORKFLOW_TAB_ENABLED`

**Step 2: Add metrics**

1. orchestra run count
2. orchestra fail-fast abort count
3. active subagent sessions

**Step 3: Finalize runbook + tests and commit**

## 6) Complete Test Strategy (Implementation + Verification)

### New Unit Tests To Add

1. `tests/unit/worker/orchestra-schema.test.ts`
2. `tests/unit/personas/persona-preferred-model.test.ts`
3. `tests/unit/worker/orchestra-graph-validation.test.ts`
4. `tests/unit/worker/orchestra-scheduler.test.ts`
5. `tests/unit/worker/orchestra-event-payload.test.ts`
6. `tests/unit/worker/worker-orchestra-tab.test.tsx`
7. `tests/unit/worker/worker-workflow-tab.test.tsx`
8. `tests/unit/worker/orchestra-policy.test.ts`
9. `tests/unit/worker/worker-task-detail-deliverables.test.tsx`
10. `tests/unit/worker/orchestra-version-pinning.test.ts`

### New Integration Tests To Add

1. `tests/integration/personas/personas-model-binding-route.test.ts`
2. `tests/integration/personas/personas-model-binding-validation.test.ts`
3. `tests/integration/worker/orchestra-flows-routes.test.ts`
4. `tests/integration/worker/orchestra-run-failfast.test.ts`
5. `tests/integration/worker/orchestra-subagent-sessions.test.ts`
6. `tests/integration/worker/orchestra-deliverables-route.test.ts`
7. `tests/integration/worker/orchestra-activities-route.test.ts`
8. `tests/integration/worker/orchestra-workflow-route.test.ts`
9. `tests/integration/worker/orchestra-auth-guard.test.ts`
10. `tests/integration/worker/orchestra-user-scope.test.ts`
11. `tests/integration/worker/orchestra-export-route.test.ts`

### Mandatory Full Verification Before Merge

```bash
npm run typecheck
npm run lint
npm run test -- tests/unit/worker
npm run test -- tests/unit/rooms
npm run test -- tests/unit/personas/persona-preferred-model.test.ts
npm run test -- tests/integration/rooms/rooms-runtime.test.ts
npm run test -- tests/integration/worker-api-files.test.ts
npm run test -- tests/integration/worker-delete-routes.test.ts
npm run test -- tests/integration/worker/orchestra-flows-routes.test.ts
npm run test -- tests/integration/worker/orchestra-run-failfast.test.ts
npm run test -- tests/integration/worker/orchestra-workflow-route.test.ts
npm run test -- tests/integration/worker/orchestra-user-scope.test.ts
npm run build
```

## 7) Rollout Plan (Production)

1. Deploy with all orchestra flags off.
2. Enable `WORKER_ORCHESTRA_ENABLED=1` on staging only.
3. Run synthetic staging scenarios:
   1. Research flow with 2 personas.
   2. Failure path to validate fail-fast.
   3. Deliverable-first export path.
4. Canary production at 10% of new worker tasks for 30 minutes.
5. Promote to 50%, then 100% if no blocker metrics.

## 8) Rollback Plan

1. Set `WORKER_WORKFLOW_TAB_ENABLED=0`.
2. Set `WORKER_ORCHESTRA_BUILDER_WRITE_ENABLED=0`.
3. Set `WORKER_ORCHESTRA_ENABLED=0`.
4. Keep legacy Worker path active and redeploy previous build if needed.
5. Capture incident notes in runbook within 24h.

## 9) Definition Of Done (Production Ready)

All must be true:

1. Draft + Publish flow lifecycle works end-to-end.
2. Orchestra builder is editable but template-bounded.
3. Workflow live graph shows current run status accurately.
4. Subagent sessions, activities, deliverables are persisted and visible.
5. Persona preferred model binding works with default fallback.
6. Fail-fast enforced, no implicit retries.
7. Full verification suite passes (typecheck, lint, tests, build).
8. Rollout and rollback runbook exists and is reviewed.
