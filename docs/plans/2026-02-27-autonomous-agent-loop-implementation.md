# Master Agent V8 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a dedicated `Master` page where one autonomous Master Agent completes tasks end-to-end, delegates execution to subagents, stays reachable at all times, integrates Gmail, and expands capabilities safely without changing Agent Room behavior.

**Architecture:** Implement a separate `Master` vertical slice (`src/modules/master`, `src/server/master`, `app/api/master/*`) with its own run lifecycle, storage, and orchestration runtime. Split runtime into `Control Plane` (Master always reachable) and `Worker Plane` (subagent execution). Add a capability framework with inventory, confidence scoring, and apprenticeship workflow for missing tools/connectors. Reuse existing skill/tooling infra via strict safety gates and approval workflows. No framework migration: import proven orchestration patterns from existing projects into the current framework.

**Tech Stack:** TypeScript, Next.js AppShell views, SQLite, existing auth/approval system, existing skills runtime, Vitest.

---

## Plan Version

- Version: `V8`
- Date: `2026-02-27`
- Scope lock: `Plan-only update in this session. No implementation.`

---

## Hard Boundaries

- `Agent Room` remains chat-only and must not be repurposed into Master orchestration.
- `Master` uses separate UI, APIs, runtime, and persistence.
- `Master` runs with strict Persona Workspace isolation (files/tools/actions scoped to the selected persona workspace only).
- No Master fields in `agent_room_swarms`.
- High-risk actions require explicit policy + approval + audit trail.
- System-changing actions are allowed only after explicit approval.
- Gmail `send` always requires approval (no auto-send mode).
- Approval decisions must support:
  - `approve_once` (single execution only),
  - `approve_always` (persisted allow-rule),
  - `deny` (reject now; request can be asked again later).

## Runtime Topology (Master Always Reachable)

- `Control Plane` (Master):
  - Handles user chat, contract updates, approvals, cancellation, reprioritization.
  - Never blocks on long-running execution.
  - Owns delegation, aggregation, verification, and final answer.
- `Worker Plane` (Subagents):
  - Executes delegated tasks in isolated contexts with strict time/budget limits.
  - Reports status/events/results back to Master through a persistent queue/inbox.
  - Can be restarted or replaced without losing Master conversation availability.

Suggested lifecycle states:

- `IDLE`, `ANALYZING`, `PLANNING`, `DELEGATING`, `EXECUTING`, `VERIFYING`, `REFINING`, `AWAITING_APPROVAL`, `COMPLETED`, `FAILED`.
- `AWAITING_APPROVAL` pauses the run until decision is received; no side-effect execution continues in this state.

### Execution Safety Contracts (Critical)

- Every side-effect action must carry an idempotency key (`runId + stepId + actionHash`).
- Add action ledger for exactly-once semantics (`planned -> started -> committed|rolled_back|failed`).
- On restart/retry, executor must reconcile against ledger before re-running side effects.
- Worker recovery must preserve causal order for events and reject stale/duplicate commits.

---

## External Pattern Inputs (No Framework Switch)

Reference implementation studied: `ruvnet/agentic-flow` (especially `agentic-flow/src/workers/*`).

Patterns to adopt into `Master`:

- Prompt/intent-driven background dispatch with non-blocking control plane behavior.
- Trigger policy registry per capability (`priority`, `timeout`, `cooldown`, `maxAgents`, optional topic extraction).
- Resource governor with hard caps (global concurrency, per-trigger limits, timeout cleanup, memory guardrails).
- Persistent worker registry and restart-safe worker state (`queued/running/complete/failed/timeout`) with event persistence.
- Context reinjection from completed worker runs back into active user interaction.
- Event bridge + worker stats endpoints for live visibility and debugging.

Patterns to avoid copying directly:

- Domain-specific worker presets and claim-heavy integrations not required by Master user value.
- Unbounded dynamic worker loading without approval/policy checks.
- Mixing unrelated domains in one runtime slice.

---

## Required Capability Set

| Capability             | Target Behavior                                                       | Delivery                                                                                      |
| ---------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Web search/fetch       | Agent can research current info with sources                          | Integrate existing web skills into Master                                                     |
| Code/program writing   | Agent can create/edit/test code in workspace                          | Integrate existing coding compat + approvals                                                  |
| Notes                  | Agent can create/search/update structured notes                       | New `master_notes` domain                                                                     |
| Reminders              | Agent can store reminders and trigger follow-ups                      | New reminder service + cron bridge                                                            |
| Cron management        | Agent can create/pause/resume/list scheduled jobs                     | Integrate existing automation/cron APIs                                                       |
| System management      | Agent can inspect/manage local runtime safely                         | Integrate process/shell tools with strict policy                                              |
| Gmail integration      | Agent can read/search/draft/send via Gmail                            | New Gmail connector (OAuth2)                                                                  |
| Subagent orchestration | Master delegates work, remains responsive, aggregates results         | New control/worker delegation runtime                                                         |
| Tool Forge             | Agent can create new internal tools/skills safely                     | New tool-forge pipeline (scaffold/test/sandbox/approval/activate) with global sharing support |
| Self-expansion         | Agent can propose and add missing capabilities when required by tasks | Tool Forge + connector apprenticeship loop                                                    |

---

## Autonomous Learning Loop (Core Requirement)

Master runtime keeps these loops logically active, but executes them in a scheduled maintenance window:

- cadence: once per day at `03:00` server time.
- max runtime per cycle and resource budgets enforced (CPU/time/cost caps).
- learning work is preemptible and must never block active user runs.

1. **System Learning Loop**

- Build tool/capability inventory on startup.
- Run micro-benchmarks to learn tool semantics (inputs, failure modes, latency).
- Maintain confidence score per capability.

2. **Tool Understanding Loop**

- For each tool, maintain test prompts and expected outcomes.
- Detect regressions and lower confidence automatically.

3. **Capability Expansion Loop**

- If task needs a missing capability, create apprenticeship ticket.
- Research official API/docs and auth model.
- Generate connector spec + tests + minimal adapter draft.
- Run in sandbox, produce risk review, request human approval for activation.

No automatic activation of new external connectors without approval.

---

## Optional External Integration Policy (Example: Instagram)

If Master detects a capability gap for any external platform/service:

- Use official APIs and compliant auth flows only.
- No credential scraping, no bypass automation, no unsafe browser hacking.
- Generate an `Integration Proposal` containing:
  - business reason (why needed for this task class),
  - scopes/permissions and minimum viable access,
  - rate limits and ToS constraints,
  - data retention/deletion behavior,
  - rollback and kill-switch plan.
- Require explicit operator approval before install/enablement.
- If not approved, Master must offer fallback plans and continue with available capabilities.

---

## User-Value Outcomes

1. User creates one contract; Master executes autonomously with visible progress.
2. User gets verifiable output, not just chat text.
3. User can delegate email + reminders + scheduling to Master safely.
4. Master improves over time through trajectory learning and feedback.
5. Master can propose and learn new platform integrations when capabilities are missing.
6. Master stays immediately erreichbar even while delegated subagent work is running.

---

## Success Metrics

- `run_completion_rate`
- `verify_pass_rate`
- `median_time_to_done`
- `rework_rate`
- `cost_per_done_run`
- `master_responsiveness_p95_ms` (while workers run)
- `delegation_success_rate`
- `subagent_retry_rate`
- `delegation_queue_depth_p95`
- `worker_event_lag_p95_ms`
- `trigger_cooldown_block_rate`
- `duplicate_side_effect_rate` (target: `0`)
- `idempotency_replay_block_rate`
- `gmail_task_success_rate`
- `gmail_send_approval_compliance_rate` (target: `100%`)
- `reminder_fire_success_rate`
- `capability_growth_cycle_time` (request -> approved connector)
- `tool_forge_success_rate`
- `tool_forge_global_adoption_rate`
- `workspace_isolation_violation_block_rate`
- `learning_cycle_success_rate`
- `learning_cycle_duration_p95_ms`
- `approval_wait_time_p95_ms`
- `unsafe_action_block_rate`

### Metric Targets (Initial SLOs)

- `master_responsiveness_p95_ms <= 1200`
- `worker_event_lag_p95_ms <= 3000`
- `duplicate_side_effect_rate = 0`
- `gmail_send_approval_compliance_rate = 100%`
- `unsafe_action_block_rate > 0` (must prove guardrails are active)

---

## Workstreams (Estimates + Dependencies)

| WS    | Outcome                                                                               | Estimate | Depends On                      |
| ----- | ------------------------------------------------------------------------------------- | -------- | ------------------------------- |
| WS1   | Master View in AppShell                                                               | S        | none                            |
| WS2   | Master data model + storage                                                           | M        | WS1                             |
| WS2b  | Persona workspace isolation + scope enforcement                                       | M        | WS2                             |
| WS3   | Master API (runs/actions)                                                             | M        | WS2, WS2b                       |
| WS4   | Master lifecycle engine                                                               | L        | WS3                             |
| WS5   | P0 Master UI (contract/controller/verify/result)                                      | M        | WS1, WS3, WS4                   |
| WS5b  | Subagent orchestration runtime (dispatcher/pool/inbox/aggregation)                    | L        | WS3, WS4                        |
| WS5c  | Delegation policy runtime (trigger registry + resource governor + recovery semantics) | M        | WS4, WS5b                       |
| WS5d  | Side-effect idempotency + action ledger (exactly-once)                                | M        | WS4, WS5b, WS5c                 |
| WS6   | Gmail connector (OAuth2 + read/search/draft/send)                                     | L        | WS3, WS4, WS5b, WS5c, WS5d, WS8 |
| WS6b  | Connector secret lifecycle (encrypt/rotate/revoke/audit)                              | M        | WS6                             |
| WS7   | Notes + reminders + cron integration                                                  | M        | WS3, WS4, WS5b                  |
| WS8   | System management guardrails                                                          | M        | WS4, WS5b                       |
| WS9   | Capability inventory + confidence scoring                                             | M        | WS4                             |
| WS10  | Tool Forge MVP (create/test/sandbox/approval/activate)                                | L        | WS8, WS9, WS5d                  |
| WS10b | Connector apprenticeship loop (on-demand)                                             | M        | WS10                            |
| WS11  | Learning loop + feedback policy tuning                                                | M        | WS4, WS8, WS9, WS5b, WS10       |
| WS12  | Observability + docs + runbooks                                                       | S        | WS5, WS6b, WS10b, WS11          |

Legend: `S` 1-2 days, `M` 3-5 days, `L` 6-10 days.

---

## Dependency Graph

- Core product path: `WS1 -> WS2 -> WS2b -> WS3 -> WS4 -> WS5`
- Delegation path: `WS3 + WS4 -> WS5b -> WS5c -> WS5d -> WS6 -> WS6b + WS7`
- Safety + learning path: `WS4 + WS5b + WS5c -> WS8`, `WS4 -> WS9 -> WS10 -> WS10b`, then `WS11 -> WS12`

Critical path: `WS1, WS2, WS2b, WS3, WS4, WS5b, WS5c, WS5d, WS8, WS6`.

---

## Iteration Plan

### Iteration 1 (MVP Utility)

Includes: `WS1, WS2, WS2b, WS3, WS4, WS5, WS5b, WS5c, WS5d, WS8, WS9, WS10`

Exit criteria:

- Master run lifecycle works end-to-end.
- Delegation to at least one subagent works with result aggregation.
- Master stays responsive while subagent executes.
- Trigger/cooldown/concurrency policies prevent delegation storms.
- Side-effect actions are exactly-once safe via action ledger/idempotency.
- Tool Forge can produce one internal tool end-to-end in sandbox and await approval.
- Approval mode supports `approve_once`, `approve_always`, and `deny`.
- Runs pause deterministically in `AWAITING_APPROVAL` until decision arrives.
- Verify gate blocks invalid completion.
- Result bundle is exportable.

### Iteration 2 (Delegation Features)

Includes: `WS6, WS6b, WS7`

Exit criteria:

- Gmail read/search/draft/send works with approvals (`send` always approval-gated).
- Notes/reminders/cron workflows are usable.
- Token lifecycle (encrypt/rotate/revoke/audit) works for connectors.

### Iteration 3 (Self-Expansion + Learning)

Includes: `WS10b, WS11, WS12`

Exit criteria:

- Capability inventory/confidence is visible.
- Apprenticeship flow can produce on-demand connector proposal and tooling path for any justified missing capability.
- Learning loop executes once daily at `03:00` server time.
- Feedback and learning influence policy recommendations.

---

## Detailed TDD Task Plan

### Task 1: Architecture Guards (Master separated)

**Files:**

- Create: `tests/unit/master/master-architecture-guards.test.ts`
- Modify: `tests/unit/components/agent-room-detail-header.test.ts`

**Estimate:** S
**Depends On:** none

**Step 1: Write the failing test**

- Assert Agent Room view mapping remains unchanged.
- Assert no Master controls in Agent Room header.

**Step 2: Run test to verify it fails**

- Run: `npm test -- tests/unit/master/master-architecture-guards.test.ts tests/unit/components/agent-room-detail-header.test.ts`

**Step 3: Write minimal implementation**

- Deferred to Task 2.

**Step 4: Run test to verify pass**

- Re-run same command.

### Task 2: Add Master View Routing

**Files:**

- Modify: `src/shared/domain/types.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/modules/app-shell/components/AppShellViewContent.tsx`
- Create: `src/modules/master/components/MasterView.tsx`
- Test: `tests/unit/master/master-view-routing.test.ts`

**Estimate:** S
**Depends On:** Task 1

**Step 1: Write the failing test**

- Verify `View.MASTER` routing and sidebar visibility.

**Step 2: Run test to verify it fails**

- Run: `npm test -- tests/unit/master/master-view-routing.test.ts`

**Step 3: Write minimal implementation**

- Add `Master` view enum + UI entry + placeholder.

**Step 4: Run test to verify pass**

- Re-run same command.

### Task 2b: Persona Workspace Isolation Guards

**Files:**

- Create: `src/server/master/workspaceScope.ts`
- Create: `tests/unit/master/master-workspace-isolation.test.ts`
- Modify: `app/api/master/runs/route.ts`

**Estimate:** M
**Depends On:** Task 2

**Step 1: Write the failing test**

- Master run creation requires persona workspace binding.
- Cross-workspace access attempts are denied and audited.

**Step 2: Run test to verify it fails**

- Run: `npm test -- tests/unit/master/master-workspace-isolation.test.ts`

**Step 3: Write minimal implementation**

- Add workspace scope resolver and per-request scope guard.
- Enforce workspace-scoped repository reads/writes.

**Step 4: Run test to verify pass**

- Re-run same command.

### Task 3: Master Storage + Domain

**Files:**

- Create: `src/server/master/types.ts`
- Create: `src/server/master/repository.ts`
- Create: `src/server/master/sqliteMasterRepository.ts`
- Create: `src/server/master/migrations.ts`
- Test: `tests/unit/master/master-repository.test.ts`

**Estimate:** M
**Depends On:** Task 2

**Step 1: Write the failing test**

- CRUD for runs/steps/feedback.
- Validate contract, verification, trajectory persistence.

**Step 2: Run test to verify it fails**

- Run: `npm test -- tests/unit/master/master-repository.test.ts`

**Step 3: Write minimal implementation**

- Add `master_runs`, `master_steps`, `master_feedback`, `master_notes`, `master_reminders`, `master_subagent_jobs`, `master_subagent_events`.

**Step 4: Run test to verify pass**

- Re-run same command.

### Task 4: Master API Surface

**Files:**

- Create: `app/api/master/runs/route.ts`
- Create: `app/api/master/runs/[id]/route.ts`
- Create: `app/api/master/runs/[id]/actions/route.ts`
- Create: `app/api/master/runs/[id]/delegations/route.ts`
- Create: `app/api/master/notes/route.ts`
- Create: `app/api/master/reminders/route.ts`
- Test: `tests/integration/master/master-runs-route.test.ts`

**Estimate:** M
**Depends On:** Task 3

**Step 1: Write the failing test**

- Run CRUD/actions/delegations + notes/reminders endpoints.

**Step 2: Run test to verify it fails**

- Run: `npm test -- tests/integration/master/master-runs-route.test.ts`

**Step 3: Write minimal implementation**

- Add validation + auth scoping + action contracts.
- Add approval-decision contract enum (`approve_once`, `approve_always`, `deny`) for all approval-required actions.

**Step 4: Run test to verify pass**

- Re-run same command.

### Task 5: Master Lifecycle Engine

**Files:**

- Create: `src/server/master/lifecycle.ts`
- Create: `src/server/master/orchestrator.ts`
- Create: `src/server/master/runtime.ts`
- Test: `tests/unit/master/master-orchestrator.test.ts`

**Estimate:** L
**Depends On:** Task 4

**Step 1: Write the failing test**

- Verify lifecycle ordering and verify gate behavior.

**Step 2: Run test to verify it fails**

- Run: `npm test -- tests/unit/master/master-orchestrator.test.ts`

**Step 3: Write minimal implementation**

- Deterministic state machine with retry/timeout.

**Step 4: Run test to verify pass**

- Re-run same command.

### Task 5b: Subagent Delegation Runtime

**Files:**

- Create: `src/server/master/delegation/dispatcher.ts`
- Create: `src/server/master/delegation/subagentPool.ts`
- Create: `src/server/master/delegation/inbox.ts`
- Create: `src/server/master/delegation/aggregator.ts`
- Test: `tests/unit/master/master-delegation-runtime.test.ts`

**Estimate:** L
**Depends On:** Task 5

**Step 1: Write the failing test**

- Master delegates task chunks to subagents and remains responsive to user actions.
- Subagent events/results are persisted and reloaded after restart.
- Aggregator validates subagent outputs before merge into run state.

**Step 2: Run test to verify it fails**

- Run: `npm test -- tests/unit/master/master-delegation-runtime.test.ts`

**Step 3: Write minimal implementation**

- Add dispatcher + worker pool with timeout/budget limits.
- Add persistent inbox/event stream for progress and results.
- Add aggregation contract (`accepted`, `needs_rework`, `rejected`).

**Step 4: Run test to verify pass**

- Re-run same command.

### Task 5c: Delegation Policy + Resource Governance

**Files:**

- Create: `src/server/master/delegation/triggerPolicy.ts`
- Create: `src/server/master/delegation/resourceGovernor.ts`
- Create: `src/server/master/delegation/recovery.ts`
- Test: `tests/unit/master/master-delegation-policy.test.ts`

**Estimate:** M
**Depends On:** Task 5b

**Step 1: Write the failing test**

- Trigger policy enforces `cooldown`, `maxConcurrent`, `maxPerCapability`, `timeoutMs`.
- Recovery restores queued/running jobs after process restart without losing Master responsiveness.
- Policy returns explicit deny reasons for observability (`cooldown_active`, `capacity_exhausted`, `budget_exceeded`).

**Step 2: Run test to verify it fails**

- Run: `npm test -- tests/unit/master/master-delegation-policy.test.ts`

**Step 3: Write minimal implementation**

- Add policy evaluator + slot accounting + timeout cleanup.
- Add restart recovery routine for in-flight delegations.
- Persist policy decisions as delegation events.

**Step 4: Run test to verify pass**

- Re-run same command.

### Task 5d: Exactly-Once Side Effects (Action Ledger)

**Files:**

- Create: `src/server/master/execution/actionLedger.ts`
- Create: `src/server/master/execution/idempotency.ts`
- Modify: `src/server/master/orchestrator.ts`
- Modify: `src/server/master/sqliteMasterRepository.ts`
- Test: `tests/unit/master/master-idempotency-ledger.test.ts`

**Estimate:** M
**Depends On:** Task 5c

**Step 1: Write the failing test**

- Retry/restart cannot duplicate side-effect actions (gmail send, cron create, process start).
- Replayed action with same idempotency key returns prior committed result.
- Stale worker commit is rejected if superseded by newer attempt.

**Step 2: Run test to verify it fails**

- Run: `npm test -- tests/unit/master/master-idempotency-ledger.test.ts`

**Step 3: Write minimal implementation**

- Add `master_action_ledger` persistence and reconciliation APIs.
- Enforce `planned -> started -> committed|rolled_back|failed` transitions.
- Gate side-effect execution through idempotency middleware.

**Step 4: Run test to verify pass**

- Re-run same command.

### Task 6: Gmail Connector Integration

**Files:**

- Create: `src/server/master/connectors/gmail/types.ts`
- Create: `src/server/master/connectors/gmail/oauth.ts`
- Create: `src/server/master/connectors/gmail/client.ts`
- Create: `src/server/master/connectors/gmail/actions.ts`
- Create: `app/api/master/gmail/route.ts`
- Test: `tests/unit/master/gmail-connector.test.ts`
- Test: `tests/integration/master/master-gmail-route.test.ts`

**Estimate:** L
**Depends On:** Task 5, Task 5b, Task 5c, Task 5d, Task 8

**Step 1: Write the failing test**

- OAuth token handling + read/search/draft/send action contracts.
- `send` action is always approval-required.
- `send` uses idempotency key and cannot be double-committed after retry.

**Step 2: Run test to verify it fails**

- Run: `npm test -- tests/unit/master/gmail-connector.test.ts tests/integration/master/master-gmail-route.test.ts`

**Step 3: Write minimal implementation**

- Gmail adapter with scope-limited access and approval gates.

**Step 4: Run test to verify pass**

- Re-run same command.

### Task 6b: Connector Secret Lifecycle

**Files:**

- Create: `src/server/master/connectors/secretStore.ts`
- Create: `src/server/master/connectors/secretPolicies.ts`
- Create: `tests/unit/master/master-connector-secret-lifecycle.test.ts`

**Estimate:** M
**Depends On:** Task 6

**Step 1: Write the failing test**

- Secrets are encrypted at rest and never returned in plaintext APIs.
- Rotation and revocation flows invalidate stale tokens.
- Every secret access is audit-logged with actor/run context.

**Step 2: Run test to verify it fails**

- Run: `npm test -- tests/unit/master/master-connector-secret-lifecycle.test.ts`

**Step 3: Write minimal implementation**

- Add encrypted store + token metadata (`issuedAt`, `expiresAt`, `revokedAt`).
- Add rotate/revoke APIs and policy checks.

**Step 4: Run test to verify pass**

- Re-run same command.

### Task 7: Notes + Reminders + Cron Delegation

**Files:**

- Create: `src/server/master/notes.ts`
- Create: `src/server/master/reminders.ts`
- Create: `src/server/master/cronBridge.ts`
- Test: `tests/unit/master/master-notes-reminders-cron.test.ts`

**Estimate:** M
**Depends On:** Task 5, Task 5b, Task 5c, Task 5d

**Step 1: Write the failing test**

- note CRUD, reminder triggers, cron bridge action behavior.

**Step 2: Run test to verify it fails**

- Run: `npm test -- tests/unit/master/master-notes-reminders-cron.test.ts`

**Step 3: Write minimal implementation**

- Add notes/reminders and connect to existing automation endpoints.

**Step 4: Run test to verify pass**

- Re-run same command.

### Task 8: System Management Safety Layer

**Files:**

- Create: `src/server/master/safety.ts`
- Create: `src/server/master/systemOps.ts`
- Modify: `src/server/channels/messages/service/toolManager.ts` (shared hook points only)
- Test: `tests/unit/master/master-system-safety.test.ts`

**Estimate:** M
**Depends On:** Task 5, Task 5b, Task 5c, Task 5d

**Step 1: Write the failing test**

- enforce forbidden actions, dry-run-first, approval-required for risky ops.
- system-changing actions are rejected without explicit approval.
- verify approval policy modes (`approve_once`, `approve_always`, `deny`) and `AWAITING_APPROVAL` pause behavior.

**Step 2: Run test to verify it fails**

- Run: `npm test -- tests/unit/master/master-system-safety.test.ts`

**Step 3: Write minimal implementation**

- apply policy evaluator + audit event emission.

**Step 4: Run test to verify pass**

- Re-run same command.

### Task 9: Capability Inventory + Understanding Loop

**Files:**

- Create: `src/server/master/capabilities/inventory.ts`
- Create: `src/server/master/capabilities/understandingLoop.ts`
- Test: `tests/unit/master/master-capability-inventory.test.ts`

**Estimate:** M
**Depends On:** Task 8

**Step 1: Write the failing test**

- inventory discovery and confidence scoring updates.

**Step 2: Run test to verify it fails**

- Run: `npm test -- tests/unit/master/master-capability-inventory.test.ts`

**Step 3: Write minimal implementation**

- schedule inventory/benchmark cycle once daily at `03:00` server time.
- enforce per-cycle runtime/cost limits and score persistence.

**Step 4: Run test to verify pass**

- Re-run same command.

### Task 10: Tool Forge MVP (On-Demand)

**Files:**

- Create: `src/server/master/toolforge/pipeline.ts`
- Create: `src/server/master/toolforge/validator.ts`
- Create: `src/server/master/toolforge/sandboxRunner.ts`
- Create (historical plan item; route removed in current baseline): `app/api/master/toolforge/route.ts`
- Test: `tests/unit/master/master-toolforge.test.ts`

**Estimate:** L
**Depends On:** Task 5d, Task 8, Task 9

**Step 1: Write the failing test**

- missing capability triggers tool-forge pipeline.
- pipeline enforces `spec -> scaffold -> tests -> sandbox -> approval -> activate`.
- activation is blocked without explicit approval and fallback plan is attached.
- approved tools are publishable to a global shared registry/catalog.

**Step 2: Run test to verify it fails**

- Run: `npm test -- tests/unit/master/master-toolforge.test.ts`

**Step 3: Write minimal implementation**

- generate tool bundle package (manifest, code, tests, risk report) and hold for approval.
- on approval, publish tool metadata/artifact to global shared catalog.

**Step 4: Run test to verify pass**

- Re-run same command.

### Task 10b: Connector Apprenticeship Loop

**Files:**

- Create: `src/server/master/capabilities/apprenticeship.ts`
- Create: `src/server/master/capabilities/proposalTemplate.ts`
- Create (historical plan item; route removed in current baseline): `app/api/master/capabilities/route.ts`
- Test: `tests/unit/master/master-apprenticeship.test.ts`

**Estimate:** M
**Depends On:** Task 10

**Step 1: Write the failing test**

- missing external capability creates proposal with API/auth/scopes/rate-limit/ToS.
- proposal includes tool-forge execution path and explicit fallback if denied.

**Step 2: Run test to verify it fails**

- Run: `npm test -- tests/unit/master/master-apprenticeship.test.ts`

**Step 3: Write minimal implementation**

- add connector proposal generator and approval-state machine.

**Step 4: Run test to verify pass**

- Re-run same command.

### Task 11: Learning + Feedback Policy Loop

**Files:**

- Create: `src/server/master/learning.ts`
- Create: `src/modules/master/components/MasterLearningPanel.tsx`
- Test: `tests/unit/master/master-learning.test.ts`

**Estimate:** M
**Depends On:** Task 10b

**Step 1: Write the failing test**

- trajectory retention, failure signatures, policy recommendation from feedback.
- scheduler runs one learning cycle per day at `03:00` server time.

**Step 2: Run test to verify it fails**

- Run: `npm test -- tests/unit/master/master-learning.test.ts`

**Step 3: Write minimal implementation**

- add feedback-driven recommendation (`safe`, `balanced`, `fast`).

**Step 4: Run test to verify pass**

- Re-run same command.

### Task 12: Observability + Docs + Full Verification

**Files:**

- Create: `docs/MASTER_AGENT_SYSTEM.md`
- Modify: `docs/CORE_HANDBOOK.md`
- Modify: `.agent/CONTINUITY.md`

**Estimate:** S
**Depends On:** Task 11

**Step 1: Write metric contract checks**

- add checks for metric payload shape where applicable.

**Step 2: Run full verification**

- Run: `npm run typecheck`
- Run: `npm run lint`
- Run: `npm run build`
- Run: `npm test -- tests/unit/master tests/integration/master`

**Step 3: Document outcomes**

- update runbook, architecture docs, continuity.

---

## Risks and Mitigations

- Risk: autonomous connector creation breaks policy/compliance.
  - Mitigation: apprenticeship proposals require approval before activation.
- Risk: runaway delegation (too many subagents / cost explosion / long queues).
  - Mitigation: hard concurrency caps, per-run budgets, queue backpressure, circuit breaker.
- Risk: trigger storms from repeated user intents create noisy/duplicate delegation.
  - Mitigation: trigger cooldowns, dedupe keys, reason-coded rejections, and policy telemetry panels.
- Risk: duplicate side effects during retries/restarts (e.g., duplicate Gmail send).
  - Mitigation: action ledger + idempotency keys + replay protection.
- Risk: Gmail misuse/privacy exposure.
  - Mitigation: minimal OAuth scopes, encrypted token store, audit trail, and mandatory approval for every `send`.
- Risk: unsafe system operations.
  - Mitigation: dry-run-first, deny-list, budget/timeout kill-switches, explicit approval gate for any system-changing action.
- Risk: approval configuration drift or ambiguity causes unsafe implicit behavior.
  - Mitigation: strict approval mode enum (`approve_once`, `approve_always`, `deny`), auditable decision history, and deterministic pause on undecided actions.
- Risk: cross-workspace data/action leakage.
  - Mitigation: persona workspace isolation enforced at API/repository/tool execution layers.
- Risk: learning loop interferes with live user workloads.
  - Mitigation: fixed daily run at `03:00` server time, strict runtime budget, and preemption by user runs.

---

## Out of Scope (V8)

- Automatic production activation of newly learned external connectors.
- Multi-master orchestration and distributed planner swarms.
- Bypassing platform ToS or non-official APIs for social platforms.
- Permanent default integration for specific platforms (e.g. Instagram) without explicit task justification.

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-02-27-autonomous-agent-loop-implementation.md`.

Two execution options:

1. Subagent-Driven (this session) - task-by-task with review gates.
2. Parallel Session (separate) - execute with `executing-plans` in a fresh session.
