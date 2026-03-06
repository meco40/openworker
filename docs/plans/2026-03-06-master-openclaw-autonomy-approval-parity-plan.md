# Master OpenClaw Autonomy Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild `Master` from a fixed-capability orchestrator into a demo-style autonomous agent surface with generic tool execution, explicit approvals, persistent allowlists, session/subagent runtime, and richer control UI.

**Architecture:** Keep the existing `src/server/master` and `src/modules/master` slices, but replace the hardcoded capability executor with a generic runtime loop that can select allowed tools, request approvals, resume safely, and stream state back to the UI. Import concepts from `demo/openclaw-main` without copying its framework wholesale: `exec` policy tiers, approval queue semantics, session-aware subagent orchestration, and operator-editable tool policy. Deliver this in phases so the current Master page remains functional while parity features land behind rollout flags.

**Tech Stack:** TypeScript, Next.js App Router, current Master API/runtime/storage, existing tool dispatch layer, SQLite-backed repositories, Vitest, React.

---

## Plan Version

- Version: `V1`
- Date: `2026-03-06`
- Scope lock: `Plan-only update in this session. No implementation.`

## Acceptance Criteria

- Master runtime can choose from a generic allowed-tool set instead of only `web_search|code_generation|notes|reminders|system_ops`.
- High-risk actions create explicit approval requests with `approve_once|approve_always|deny`.
- Approval metadata includes command/action summary, host, cwd/path context, risk level, fingerprint, and expiry.
- Master stores persistent allowlist/policy state and can reuse prior `approve_always` decisions safely.
- Master can spawn and track session-like subagents with durable state and event streaming.
- Master UI exposes approval queue, tool policy, and automation/reminder controls in addition to runs and analytics.
- Reminder/Cron lifecycle is closed-loop: scheduled, fired, audited, surfaced in UI.

## Non-Goals

- No wholesale port of the `demo/openclaw-main` runtime.
- No host package installation or production deployment changes in this phase.
- No full plugin marketplace or cross-channel approval UX in V1.

## Guiding Decisions

- Reuse current Master storage/API patterns where safe; add new slices rather than overloading existing `run.actions` semantics.
- Keep legacy Master execution path behind a feature flag until generic runtime passes integration coverage.
- Approval decisions must be idempotent and bound to a concrete request fingerprint.
- Start with gateway-local runtime parity; node/device/browser parity can be layered after the approval/control plane is stable.

---

### Task 1: Add a Generic Master Tool Runtime

**Files:**

- Modify: `src/server/master/execution/runtime/types.ts`
- Modify: `src/server/master/execution/runtime/executionPlan.ts`
- Modify: `src/server/master/execution/runtime/executionFlow.ts`
- Modify: `src/server/master/execution/runtime/capabilityExecutor.ts`
- Modify: `src/server/master/execution/runtime/toolContext.ts`
- Create: `src/server/master/execution/runtime/toolRunner.ts`
- Create: `src/server/master/execution/runtime/toolPolicy.ts`
- Test: `tests/unit/master/runtime/tool-runner.test.ts`
- Test: `tests/integration/master/master-runtime-tool-loop.test.ts`

**Step 1: Write the failing runtime tests**

- Cover: generic tool selection, policy-filtered tool visibility, approval-required tool result, and resume after approval.
- Run: `pnpm vitest run tests/unit/master/runtime/tool-runner.test.ts tests/integration/master/master-runtime-tool-loop.test.ts`
- Expected: FAIL because `toolRunner` and generic runtime states do not exist.

**Step 2: Expand runtime types away from fixed capabilities**

- Replace the current narrow capability union with a model that supports:

```ts
type MasterExecutionMode = 'capability' | 'tool_call';
type MasterRuntimeTool =
  | 'read'
  | 'write'
  | 'apply_patch'
  | 'shell_execute'
  | 'web_search'
  | 'web_fetch'
  | 'playwright_cli'
  | 'process_manager';
```

- Keep compatibility for existing `notes` and `reminders` handlers during migration.

**Step 3: Implement `toolRunner`**

- Accept a requested tool, arguments, persona allowlist, and runtime scope.
- Return one of:

```ts
{ status: "completed"; output: string; details?: unknown }
{ status: "approval_required"; approvalRequestId: string; summary: string }
{ status: "blocked"; reason: string }
```

- Route tools through the existing dispatch layer instead of direct capability-only branching.

**Step 4: Rewire planner + execution flow**

- Allow planner to emit generic tool steps for coding/web/system work.
- Keep legacy fallback for old plans while feature-flagged parity mode is off.
- Ensure execution flow can pause on approval and resume without replaying completed side effects.

**Step 5: Re-run focused tests**

- Run: `pnpm vitest run tests/unit/master/runtime/tool-runner.test.ts tests/integration/master/master-runtime-tool-loop.test.ts`
- Expected: PASS

**Step 6: Commit**

```bash
git add src/server/master/execution/runtime tests/unit/master/runtime tests/integration/master/master-runtime-tool-loop.test.ts
git commit -m "feat: add generic master tool runtime"
```

---

### Task 2: Build an Explicit Approval Control Plane

**Files:**

- Create: `src/server/master/approvals/types.ts`
- Create: `src/server/master/approvals/repository.ts`
- Create: `src/server/master/approvals/service.ts`
- Modify: `src/server/master/systemOps.ts`
- Modify: `src/server/master/safety.ts`
- Modify: `src/server/master/execution/runtime/toolRunner.ts`
- Create: `app/api/master/approvals/route.ts`
- Create: `app/api/master/approvals/[id]/decision/route.ts`
- Modify: `app/api/master/runs/[id]/actions/route.ts`
- Test: `tests/integration/master/master-approvals-route.test.ts`
- Test: `tests/unit/master/master-approval-service.test.ts`

**Step 1: Write failing approval tests**

- Cover creation, expiry, `approve_once`, `approve_always`, `deny`, idempotent replay, and fingerprint mismatch rejection.
- Run: `pnpm vitest run tests/unit/master/master-approval-service.test.ts tests/integration/master/master-approvals-route.test.ts`
- Expected: FAIL because approval repository/service/routes do not exist.

**Step 2: Define the approval contract**

- Add a persistent request shape similar to:

```ts
type MasterApprovalDecision = 'approve_once' | 'approve_always' | 'deny';
type MasterApprovalRequest = {
  id: string;
  runId: string;
  toolName: string;
  summary: string;
  host?: 'sandbox' | 'gateway';
  cwd?: string;
  resolvedPath?: string;
  fingerprint: string;
  riskLevel: 'low' | 'medium' | 'high';
  expiresAt: string;
};
```

**Step 3: Persist decisions safely**

- `approve_once`: resume only the bound request.
- `approve_always`: add a normalized allowlist/policy entry tied to tool + host + fingerprint pattern.
- `deny`: mark terminal and unblock the run with a clear audit event.

**Step 4: Integrate approval generation into tool execution**

- `toolRunner` must emit `approval_required` instead of throwing generic errors for high-risk tools.
- Existing `systemOps`/`safety` checks become the low-level policy layer, not the user-facing control plane.

**Step 5: Re-run focused tests**

- Run: `pnpm vitest run tests/unit/master/master-approval-service.test.ts tests/integration/master/master-approvals-route.test.ts`
- Expected: PASS

**Step 6: Commit**

```bash
git add src/server/master/approvals src/server/master/systemOps.ts src/server/master/safety.ts app/api/master/approvals app/api/master/runs/[id]/actions/route.ts tests/unit/master tests/integration/master/master-approvals-route.test.ts
git commit -m "feat: add master approval control plane"
```

---

### Task 3: Add Persistent Tool Policy and Allowlist Semantics

**Files:**

- Create: `src/server/master/toolPolicy/types.ts`
- Create: `src/server/master/toolPolicy/repository.ts`
- Create: `src/server/master/toolPolicy/service.ts`
- Modify: `src/server/master/systemPersona.ts`
- Modify: `app/api/master/settings/route.ts`
- Modify: `src/server/master/execution/runtime/toolPolicy.ts`
- Test: `tests/unit/master/master-tool-policy.test.ts`
- Test: `tests/integration/master/master-settings-tool-policy-route.test.ts`

**Step 1: Write failing policy tests**

- Cover default policy, agent overrides, allowlist persistence, `approve_always` backfill, and disallowed tool filtering.
- Run: `pnpm vitest run tests/unit/master/master-tool-policy.test.ts tests/integration/master/master-settings-tool-policy-route.test.ts`
- Expected: FAIL because policy storage/service is missing.

**Step 2: Split static allowlist from runtime policy**

- Keep `systemPersona.ts` as the maximum envelope.
- Store operator-editable defaults separately:

```ts
type MasterToolPolicy = {
  security: 'deny' | 'allowlist' | 'full';
  ask: 'off' | 'on_miss' | 'always';
  allowlist: Array<{ pattern: string; lastUsedAt?: string }>;
};
```

**Step 3: Wire settings API**

- Extend `Master > Settings` read/write payloads to include runtime policy and tool policy snapshots.
- Do not overload persona persistence with detailed allowlist history.

**Step 4: Enforce policy in `toolRunner`**

- Resolve effective policy before dispatch.
- Deny tools outside the persona envelope even if settings try to allow them.

**Step 5: Re-run focused tests**

- Run: `pnpm vitest run tests/unit/master/master-tool-policy.test.ts tests/integration/master/master-settings-tool-policy-route.test.ts`
- Expected: PASS

**Step 6: Commit**

```bash
git add src/server/master/toolPolicy src/server/master/systemPersona.ts app/api/master/settings/route.ts src/server/master/execution/runtime/toolPolicy.ts tests/unit/master/master-tool-policy.test.ts tests/integration/master/master-settings-tool-policy-route.test.ts
git commit -m "feat: add master tool policy and allowlists"
```

---

### Task 4: Replace Job-Only Delegation with Durable Master Sessions/Subagents

**Files:**

- Modify: `src/server/master/delegation/dispatcher.ts`
- Modify: `src/server/master/delegation/subagentPool.ts`
- Create: `src/server/master/delegation/sessionTypes.ts`
- Create: `src/server/master/delegation/sessionRepository.ts`
- Create: `src/server/master/delegation/sessionService.ts`
- Modify: `src/server/master/types.ts`
- Create: `app/api/master/subagents/route.ts`
- Create: `app/api/master/subagents/[id]/route.ts`
- Test: `tests/unit/master/master-subagent-session-service.test.ts`
- Test: `tests/integration/master/master-subagents-route.test.ts`

**Step 1: Write failing subagent/session tests**

- Cover spawn, status transitions, event replay, cancellation, and result aggregation.
- Run: `pnpm vitest run tests/unit/master/master-subagent-session-service.test.ts tests/integration/master/master-subagents-route.test.ts`
- Expected: FAIL because session persistence/routes do not exist.

**Step 2: Introduce a durable subagent model**

- Add states:

```ts
type MasterSubagentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
```

- Store prompt, workspace scope, assigned tools, parent run id, and event log.

**Step 3: Rewire dispatcher**

- `dispatcher.ts` should create persisted subagent sessions instead of only local task wrappers.
- `subagentPool.ts` becomes the execution worker for queued sessions.

**Step 4: Add read APIs for UI**

- List subagents by run.
- Fetch detail/event history for a specific subagent.

**Step 5: Re-run focused tests**

- Run: `pnpm vitest run tests/unit/master/master-subagent-session-service.test.ts tests/integration/master/master-subagents-route.test.ts`
- Expected: PASS

**Step 6: Commit**

```bash
git add src/server/master/delegation app/api/master/subagents src/server/master/types.ts tests/unit/master/master-subagent-session-service.test.ts tests/integration/master/master-subagents-route.test.ts
git commit -m "feat: add durable master subagent sessions"
```

---

### Task 5: Expand the Master UI into an Operator Control Surface

**Files:**

- Modify: `src/modules/master/components/MasterView.tsx`
- Modify: `src/modules/master/components/MasterSettingsPanel.tsx`
- Modify: `src/modules/master/components/RunDetailPanel.tsx`
- Create: `src/modules/master/components/ApprovalQueuePanel.tsx`
- Create: `src/modules/master/components/ToolPolicyPanel.tsx`
- Create: `src/modules/master/components/SubagentSessionsPanel.tsx`
- Create: `src/modules/master/components/AutomationPanel.tsx`
- Modify: `src/modules/master/hooks/useMasterView.ts`
- Modify: `src/modules/master/api.ts`
- Test: `tests/unit/components/master/approval-queue-panel.test.tsx`
- Test: `tests/unit/components/master/tool-policy-panel.test.tsx`
- Test: `tests/unit/components/master/subagent-sessions-panel.test.tsx`

**Step 1: Write failing component tests**

- Cover approval queue rendering, approve/deny actions, policy editing, subagent list/detail, and automation panel loading.
- Run: `pnpm vitest run tests/unit/components/master/approval-queue-panel.test.tsx tests/unit/components/master/tool-policy-panel.test.tsx tests/unit/components/master/subagent-sessions-panel.test.tsx`
- Expected: FAIL because the new panels do not exist.

**Step 2: Add new Master tabs**

- Extend `MasterView` with:
  - `Approvals`
  - `Tools`
  - `Automation`
- Preserve current `New Run`, `Runs`, `Analytics`, `Settings`.

**Step 3: Hook UI to new APIs**

- `ApprovalQueuePanel`: list pending requests and submit decisions.
- `ToolPolicyPanel`: edit security/ask defaults and allowlist entries.
- `SubagentSessionsPanel`: inspect spawned sessions and their latest events.
- `AutomationPanel`: surface reminders/cron state.

**Step 4: Keep the UI responsive**

- Reuse the existing abort/guard patterns in `useMasterView`.
- Add optimistic states only where the server returns an authoritative outcome.

**Step 5: Re-run focused tests**

- Run: `pnpm vitest run tests/unit/components/master/approval-queue-panel.test.tsx tests/unit/components/master/tool-policy-panel.test.tsx tests/unit/components/master/subagent-sessions-panel.test.tsx`
- Expected: PASS

**Step 6: Commit**

```bash
git add src/modules/master/components src/modules/master/hooks/useMasterView.ts src/modules/master/api.ts tests/unit/components/master
git commit -m "feat: add master operator control panels"
```

---

### Task 6: Close the Reminder/Cron Loop and Surface It in Runtime

**Files:**

- Modify: `src/server/master/cronBridge.ts`
- Modify: `src/server/master/types.ts`
- Modify: `app/api/master/reminders/route.ts`
- Create: `app/api/master/reminders/[id]/route.ts`
- Create: `src/server/master/reminders/service.ts`
- Modify: `src/server/master/execution/runtime/executionPlan.ts`
- Modify: `src/server/master/execution/runtime/toolRunner.ts`
- Test: `tests/integration/master/master-reminders-lifecycle.test.ts`
- Test: `tests/unit/master/master-reminders-service.test.ts`

**Step 1: Write failing reminder lifecycle tests**

- Cover create, schedule projection, fire callback, state transition to `fired`, audit event emission, and UI-visible status.
- Run: `pnpm vitest run tests/unit/master/master-reminders-service.test.ts tests/integration/master/master-reminders-lifecycle.test.ts`
- Expected: FAIL because the current lifecycle does not mark reminders as fired.

**Step 2: Add a Master-owned reminder service**

- Move state transitions out of ad hoc runtime branches.
- Persist timestamps:

```ts
type MasterReminderStatus = 'pending' | 'fired' | 'paused' | 'cancelled';
```

**Step 3: Add cron/tool integration**

- Planner/runtime should be able to create reminder/cron actions explicitly.
- `cronBridge.ts` must write completion back into Master-owned state.

**Step 4: Re-run focused tests**

- Run: `pnpm vitest run tests/unit/master/master-reminders-service.test.ts tests/integration/master/master-reminders-lifecycle.test.ts`
- Expected: PASS

**Step 5: Commit**

```bash
git add src/server/master/cronBridge.ts src/server/master/reminders app/api/master/reminders src/server/master/types.ts src/server/master/execution/runtime tests/unit/master/master-reminders-service.test.ts tests/integration/master/master-reminders-lifecycle.test.ts
git commit -m "feat: close master reminder and cron lifecycle"
```

---

### Task 7: Document, Flag, and Verify the Rollout

**Files:**

- Modify: `docs/MASTER_AGENT_SYSTEM.md`
- Modify: `docs/API_REFERENCE.md`
- Create: `docs/runbooks/master-autonomy-rollout.md`
- Modify: `src/server/master/featureFlags.ts`
- Test: `tests/integration/master/master-feature-flag-parity.test.ts`

**Step 1: Write failing rollout tests**

- Cover feature flag off => legacy path, feature flag on => generic runtime + approvals path.
- Run: `pnpm vitest run tests/integration/master/master-feature-flag-parity.test.ts`
- Expected: FAIL until rollout gating is implemented.

**Step 2: Add parity rollout flags**

- Suggested flags:
  - `MASTER_GENERIC_RUNTIME_ENABLED`
  - `MASTER_APPROVAL_CONTROL_PLANE_ENABLED`
  - `MASTER_SUBAGENT_SESSIONS_ENABLED`

**Step 3: Update docs**

- Document:
  - runtime topology
  - approval semantics
  - allowlist persistence
  - UI panels
  - migration and rollback path

**Step 4: Run focused then full verification**

- Focused:
  - `pnpm vitest run tests/integration/master tests/unit/master tests/unit/components/master`
- Full:
  - `pnpm run typecheck`
  - `pnpm run lint`
  - `pnpm run test`
  - `pnpm run check`
  - `pnpm run build`

**Step 5: Commit**

```bash
git add docs/MASTER_AGENT_SYSTEM.md docs/API_REFERENCE.md docs/runbooks/master-autonomy-rollout.md src/server/master/featureFlags.ts tests/integration/master/master-feature-flag-parity.test.ts
git commit -m "docs: document master autonomy rollout"
```

---

## Suggested Delivery Order

1. Task 1: Generic runtime
2. Task 2: Approval control plane
3. Task 3: Tool policy and allowlists
4. Task 4: Durable subagent sessions
5. Task 5: Master operator UI
6. Task 6: Reminder/Cron lifecycle
7. Task 7: Rollout docs and verification

## Risks to Watch

- Conflating persona allowlist with operator-managed allowlist will make rollback and auditing brittle.
- Approval resume without request fingerprinting will create replay and double-execution bugs.
- UI optimism around approvals or subagent state will drift from server truth under race conditions.
- Expanding tool access before policy storage exists will create unsafe hidden behavior.
- Replacing delegation before durable session persistence exists will regress current Master responsiveness.

## Definition of Done

- New runtime path is feature-flagged, tested, and documented.
- Approval requests are persistent, inspectable, and safely resumable.
- `approve_always` creates reusable allowlist entries with audit metadata.
- Master UI exposes approvals, tool policy, subagents, and automation.
- Reminder firing updates Master-owned state.
- Full repo validation passes.
