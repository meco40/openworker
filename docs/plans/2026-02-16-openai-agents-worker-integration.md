# OpenAI Agents Worker Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current Worker execution core with an OpenAI Agents SDK runtime while preserving existing Kanban UX, task states, and WebSocket status updates.

**Architecture:** Keep the existing Next.js + Gateway + Worker repository as the control plane. Introduce a Python sidecar service (`services/openai_worker`) that runs OpenAI Agents sessions (tools, subagents, HITL checkpoints), and connect it to the TypeScript worker via a strict HTTP event bridge. The TS side remains source of truth for task state, activities, and frontend events.

**Tech Stack:** TypeScript (existing app/gateway/worker), Python 3.11+ (`openai-agents`, FastAPI, uvicorn, pytest), WebSocket gateway events, Vitest integration tests.

---

### Task 0: Production Guardrails (Mandatory Before Runtime Switch)

**Files:**

- Create: `services/openai_worker/app/event_store.py`
- Create: `services/openai_worker/app/state_store.py`
- Create: `services/openai_worker/app/queue_policy.py`
- Create: `services/openai_worker/app/telemetry.py`
- Create: `services/openai_worker/app/recovery.py`
- Create: `services/openai_worker/tests/test_event_idempotency.py`
- Create: `services/openai_worker/tests/test_recovery_resume.py`
- Create: `services/openai_worker/tests/test_queue_backpressure.py`
- Create: `services/openai_worker/tests/test_tool_sandbox.py`
- Create: `services/openai_worker/tests/test_schema_version_compat.py`
- Create: `tests/integration/worker/openai-event-ordering.test.ts`
- Create: `tests/integration/worker/openai-duplicate-events.test.ts`
- Create: `tests/integration/worker/openai-cancel-during-approval.test.ts`
- Create: `tests/integration/worker/openai-schema-version.test.ts`
- Modify: `src/server/worker/openai/types.ts`
- Create: `src/server/worker/openai/eventGuard.ts`
- Create: `src/server/worker/openai/eventSchemaVersion.ts`
- Modify: `src/server/config/gatewayConfig.ts`
- Create: `docs/runbooks/openai-worker-slos.md`

**Step 1: Write failing guardrail tests**

Add tests for:

- event idempotency (`eventId` + `runId`) and replay safety across retries
- strict per-run ordering (`seq`) with out-of-order event rejection
- process restart recovery (paused approval run, in-flight run resume)
- queue/backpressure limits (`maxConcurrentRuns`, `maxQueueDepth`, per-user caps)
- tool sandbox policy (path jail, denied commands, network egress allowlist)
- race path: cancel while approval pending
- schema compatibility (`schemaVersion`) across sidecar/gateway rolling updates

**Step 2: Run tests to verify they fail**

Run:

- `python -m pytest services/openai_worker/tests/test_event_idempotency.py services/openai_worker/tests/test_recovery_resume.py services/openai_worker/tests/test_queue_backpressure.py services/openai_worker/tests/test_tool_sandbox.py -q`
- `python -m pytest services/openai_worker/tests/test_schema_version_compat.py -q`
- `npm run test -- tests/integration/worker/openai-event-ordering.test.ts`
- `npm run test -- tests/integration/worker/openai-duplicate-events.test.ts`
- `npm run test -- tests/integration/worker/openai-cancel-during-approval.test.ts`
- `npm run test -- tests/integration/worker/openai-schema-version.test.ts`

Expected: FAIL (guardrails not implemented).

**Step 3: Write minimal implementation**

Implement:

- event envelope contract: `schemaVersion`, `eventId`, `runId`, `taskId`, `type`, `seq`, `emittedAt`, `attempt`, `signature`, `keyId`
- TS dedupe + ordering checks before state mutation (`applied`, `duplicate`, `rejected_out_of_order`)
- sidecar persistent run/checkpoint store (approval checkpoint + resume token durability)
- startup recovery worker to resume/mark stale runs deterministically
- signature verification with rotating keys (`keyId`) and replay window guards
- compatibility policy:
  - accept `N` and `N-1` schema versions
  - reject unknown major versions with explicit error telemetry
- hardened tool policy:
  - workspace path jail
  - command denylist + optional allowlist
  - network egress allowlist for external tools
- queue governance with explicit `429`/reject semantics and retry hints
- telemetry counters/histograms:
  - `worker_run_duration_ms`
  - `worker_approval_wait_ms`
  - `worker_event_duplicate_total`
  - `worker_run_fail_total`

**Step 4: Run tests to verify they pass**

Run:

- `python -m pytest services/openai_worker/tests/test_event_idempotency.py services/openai_worker/tests/test_recovery_resume.py services/openai_worker/tests/test_queue_backpressure.py services/openai_worker/tests/test_tool_sandbox.py -q`
- `python -m pytest services/openai_worker/tests/test_schema_version_compat.py -q`
- `npm run test -- tests/integration/worker/openai-event-ordering.test.ts`
- `npm run test -- tests/integration/worker/openai-duplicate-events.test.ts`
- `npm run test -- tests/integration/worker/openai-cancel-during-approval.test.ts`
- `npm run test -- tests/integration/worker/openai-schema-version.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add services/openai_worker/app/event_store.py services/openai_worker/app/state_store.py services/openai_worker/app/queue_policy.py services/openai_worker/app/telemetry.py services/openai_worker/app/recovery.py services/openai_worker/tests/test_event_idempotency.py services/openai_worker/tests/test_recovery_resume.py services/openai_worker/tests/test_queue_backpressure.py services/openai_worker/tests/test_tool_sandbox.py services/openai_worker/tests/test_schema_version_compat.py tests/integration/worker/openai-event-ordering.test.ts tests/integration/worker/openai-duplicate-events.test.ts tests/integration/worker/openai-cancel-during-approval.test.ts tests/integration/worker/openai-schema-version.test.ts src/server/worker/openai/types.ts src/server/worker/openai/eventGuard.ts src/server/worker/openai/eventSchemaVersion.ts src/server/config/gatewayConfig.ts docs/runbooks/openai-worker-slos.md
git commit -m "feat(worker): add production guardrails for openai runtime"
```

### Task 1: Freeze Contract And Feature Flag

**Files:**

- Modify: `src/server/worker/openai/types.ts`
- Create: `src/server/worker/openai/statusMapper.ts`
- Modify: `src/server/worker/workerTypes.ts`
- Modify: `src/server/worker/workerStateMachine.ts`
- Modify: `src/server/config/gatewayConfig.ts`
- Test: `tests/unit/worker/openai-status-mapper.test.ts`
- Test: `tests/unit/worker/worker-state-machine.test.ts`

**Step 1: Write the failing contract tests**

Add tests for:

- mapping OpenAI run states to Worker states (`planning`, `executing`, `waiting_approval`, `testing`, `review`, `completed`, `failed`)
- rejecting unknown external states

**Step 2: Run test to verify it fails**

Run: `npm run test -- tests/unit/worker/openai-status-mapper.test.ts`
Expected: FAIL (mapper not implemented).

**Step 3: Write minimal implementation**

Implement:

- typed sidecar event schema (`task.started`, `task.progress`, `task.approval_required`, `task.completed`, `task.failed`, `subagent.*`)
- status mapping function
- feature flag config key (`worker.runtime = "legacy" | "openai"`)

**Step 4: Run tests to verify they pass**

Run:

- `npm run test -- tests/unit/worker/openai-status-mapper.test.ts`
- `npm run test -- tests/unit/worker/worker-state-machine.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/worker/openai/types.ts src/server/worker/openai/statusMapper.ts src/server/worker/workerTypes.ts src/server/worker/workerStateMachine.ts src/server/config/gatewayConfig.ts tests/unit/worker/openai-status-mapper.test.ts tests/unit/worker/worker-state-machine.test.ts
git commit -m "feat(worker): add openai runtime contract and status mapping"
```

### Task 2: Add Python OpenAI Worker Service Skeleton

**Files:**

- Create: `services/openai_worker/pyproject.toml`
- Create: `services/openai_worker/app/main.py`
- Create: `services/openai_worker/app/config.py`
- Create: `services/openai_worker/app/models.py`
- Create: `services/openai_worker/tests/test_health.py`
- Create: `services/openai_worker/tests/test_contract_schema.py`

**Step 1: Write failing Python tests**

Add tests for:

- `GET /health` returns `{ ok: true }`
- event payload model validation rejects malformed events

**Step 2: Run test to verify it fails**

Run: `python -m pytest services/openai_worker/tests/test_health.py services/openai_worker/tests/test_contract_schema.py -q`
Expected: FAIL (service not implemented).

**Step 3: Write minimal implementation**

Implement FastAPI app with:

- `/health`
- strict Pydantic models for run requests and event payloads
- env config for API key, callback URL, timeout

**Step 4: Run tests to verify they pass**

Run: `python -m pytest services/openai_worker/tests/test_health.py services/openai_worker/tests/test_contract_schema.py -q`
Expected: PASS.

**Step 5: Commit**

```bash
git add services/openai_worker/pyproject.toml services/openai_worker/app/main.py services/openai_worker/app/config.py services/openai_worker/app/models.py services/openai_worker/tests/test_health.py services/openai_worker/tests/test_contract_schema.py
git commit -m "feat(openai-worker): scaffold python sidecar with strict contracts"
```

### Task 3: Implement OpenAI Agent Runner + Tools

**Files:**

- Create: `services/openai_worker/app/runner.py`
- Create: `services/openai_worker/app/tools/shell_tool.py`
- Create: `services/openai_worker/app/tools/browser_tool.py`
- Create: `services/openai_worker/app/tools/files_tool.py`
- Create: `services/openai_worker/app/tools/github_tool.py`
- Create: `services/openai_worker/app/tools/mcp_tool.py`
- Create: `services/openai_worker/app/tools/computer_use_tool.py`
- Modify: `services/openai_worker/app/main.py`
- Test: `services/openai_worker/tests/test_runner_smoke.py`
- Test: `services/openai_worker/tests/test_tool_registry.py`
- Test: `services/openai_worker/tests/test_mcp_tool.py`
- Test: `services/openai_worker/tests/test_computer_use_tool.py`

**Step 1: Write failing runner tests**

Add tests for:

- runner can execute one simple objective and produce final output
- tool registry exposes enabled tools from config
- MCP tool rejects unknown servers and enforces per-agent allowlist
- Computer Use tool requires explicit policy + HITL approval before action

**Step 2: Run test to verify it fails**

Run: `python -m pytest services/openai_worker/tests/test_runner_smoke.py services/openai_worker/tests/test_tool_registry.py services/openai_worker/tests/test_mcp_tool.py services/openai_worker/tests/test_computer_use_tool.py -q`
Expected: FAIL (runner/tool registry missing).

**Step 3: Write minimal implementation**

Implement:

- OpenAI Agents run wrapper
- tool registry with allowlist per task/persona
- minimal adapters for shell, browser fetch, file read/write, GitHub API
- MCP adapter with:
  - explicit server registry
  - per-agent/per-task allowlist
  - timeout and payload-size limits
- Computer Use adapter with:
  - explicit kill switch (`worker.tools.computerUse.enabled`)
  - mandatory HITL gating for destructive actions
  - session recording metadata for audit

**Step 4: Run tests to verify they pass**

Run: `python -m pytest services/openai_worker/tests/test_runner_smoke.py services/openai_worker/tests/test_tool_registry.py services/openai_worker/tests/test_mcp_tool.py services/openai_worker/tests/test_computer_use_tool.py -q`
Expected: PASS.

**Step 5: Commit**

```bash
git add services/openai_worker/app/runner.py services/openai_worker/app/tools/shell_tool.py services/openai_worker/app/tools/browser_tool.py services/openai_worker/app/tools/files_tool.py services/openai_worker/app/tools/github_tool.py services/openai_worker/app/tools/mcp_tool.py services/openai_worker/app/tools/computer_use_tool.py services/openai_worker/app/main.py services/openai_worker/tests/test_runner_smoke.py services/openai_worker/tests/test_tool_registry.py services/openai_worker/tests/test_mcp_tool.py services/openai_worker/tests/test_computer_use_tool.py
git commit -m "feat(openai-worker): add agents runner with mcp and computer use tooling"
```

### Task 4: Add Human-in-the-Loop Approval Flow

**Files:**

- Create: `services/openai_worker/app/approval.py`
- Modify: `services/openai_worker/app/runner.py`
- Modify: `src/server/gateway/methods/worker.ts`
- Modify: `src/server/gateway/events.ts`
- Modify: `src/server/worker/utils/broadcast.ts`
- Test: `services/openai_worker/tests/test_approval_pause_resume.py`
- Test: `tests/unit/gateway/worker-approval-method.test.ts`

**Step 1: Write failing approval tests**

Add tests for:

- sidecar pauses run when approval is required
- TS gateway can receive approval response and resume run
- `worker.approval.requested` event payload shape remains valid

**Step 2: Run test to verify it fails**

Run:

- `python -m pytest services/openai_worker/tests/test_approval_pause_resume.py -q`
- `npm run test -- tests/unit/gateway/worker-approval-method.test.ts`

Expected: FAIL.

**Step 3: Write minimal implementation**

Implement:

- sidecar checkpoint + resume token
- callback event `task.approval_required`
- TS RPC bridge from `worker.approval.respond` to sidecar resume endpoint

**Step 4: Run tests to verify they pass**

Run:

- `python -m pytest services/openai_worker/tests/test_approval_pause_resume.py -q`
- `npm run test -- tests/unit/gateway/worker-approval-method.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add services/openai_worker/app/approval.py services/openai_worker/app/runner.py src/server/gateway/methods/worker.ts src/server/gateway/events.ts src/server/worker/utils/broadcast.ts services/openai_worker/tests/test_approval_pause_resume.py tests/unit/gateway/worker-approval-method.test.ts
git commit -m "feat(worker): wire human-in-the-loop approval bridge for openai runtime"
```

### Task 5: Add Subagent And Multi-Agent Orchestration Bridge

**Files:**

- Create: `services/openai_worker/app/subagents.py`
- Modify: `services/openai_worker/app/runner.py`
- Modify: `src/server/worker/workerRepository.ts`
- Modify: `src/server/worker/orchestraRunner.ts`
- Modify: `app/api/worker/[id]/subagents/route.ts`
- Test: `services/openai_worker/tests/test_subagent_lifecycle.py`
- Test: `tests/integration/worker/orchestra-subagent-sessions.test.ts`

**Step 1: Write failing subagent tests**

Add tests for:

- child subagent session creation/update/finish
- persisted session metadata in `worker_subagent_sessions`

**Step 2: Run test to verify it fails**

Run:

- `python -m pytest services/openai_worker/tests/test_subagent_lifecycle.py -q`
- `npm run test -- tests/integration/worker/orchestra-subagent-sessions.test.ts`

Expected: FAIL.

**Step 3: Write minimal implementation**

Implement:

- sidecar subagent spawn API with depth and child limits
- TS persistence mapping to existing subagent session table
- subagent status updates via existing worker API route

**Step 4: Run tests to verify they pass**

Run:

- `python -m pytest services/openai_worker/tests/test_subagent_lifecycle.py -q`
- `npm run test -- tests/integration/worker/orchestra-subagent-sessions.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add services/openai_worker/app/subagents.py services/openai_worker/app/runner.py src/server/worker/workerRepository.ts src/server/worker/orchestraRunner.ts app/api/worker/[id]/subagents/route.ts services/openai_worker/tests/test_subagent_lifecycle.py tests/integration/worker/orchestra-subagent-sessions.test.ts
git commit -m "feat(worker): integrate subagent orchestration with openai sidecar"
```

### Task 6: Replace Legacy Standard Task Execution With Bridge Runtime

**Files:**

- Create: `src/server/worker/openai/openaiWorkerClient.ts`
- Create: `src/server/worker/openai/openaiWorkerRuntime.ts`
- Modify: `src/server/worker/phases/standardTaskPhase.ts`
- Modify: `src/server/worker/workerAgent.ts`
- Modify: `src/server/worker/workerPlanner.ts`
- Modify: `src/server/worker/workerExecutor.ts`
- Test: `tests/unit/worker/openai-worker-runtime.test.ts`
- Test: `tests/e2e/worker/task-lifecycle.e2e.test.ts`

**Step 1: Write failing bridge-runtime tests**

Add tests for:

- `standardTaskPhase` delegates to OpenAI runtime when feature flag is enabled
- legacy path still works when flag is disabled

**Step 2: Run test to verify it fails**

Run:

- `npm run test -- tests/unit/worker/openai-worker-runtime.test.ts`
- `npm run test -- tests/e2e/worker/task-lifecycle.e2e.test.ts`

Expected: FAIL.

**Step 3: Write minimal implementation**

Implement:

- sidecar client (`startRun`, `cancelRun`, `submitApproval`)
- phase adapter that updates existing status/activity/checkpoints from sidecar events
- keep legacy planner/executor behind flag for rollback

**Step 4: Run tests to verify they pass**

Run:

- `npm run test -- tests/unit/worker/openai-worker-runtime.test.ts`
- `npm run test -- tests/e2e/worker/task-lifecycle.e2e.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/worker/openai/openaiWorkerClient.ts src/server/worker/openai/openaiWorkerRuntime.ts src/server/worker/phases/standardTaskPhase.ts src/server/worker/workerAgent.ts src/server/worker/workerPlanner.ts src/server/worker/workerExecutor.ts tests/unit/worker/openai-worker-runtime.test.ts tests/e2e/worker/task-lifecycle.e2e.test.ts
git commit -m "feat(worker): route task execution through openai sidecar runtime"
```

### Task 7: Preserve WebSocket/Kanban UX Contract

**Files:**

- Modify: `src/server/worker/utils/broadcast.ts`
- Modify: `src/server/gateway/events.ts`
- Modify: `src/modules/worker/hooks/useWorkerWorkflow.ts`
- Modify: `components/worker/WorkerKanbanBoard.tsx`
- Test: `tests/unit/worker/orchestra-event-payload.test.ts`
- Test: `tests/unit/worker/worker-workflow-tab.test.ts`

**Step 1: Write failing UI contract tests**

Add tests for:

- no regressions in `worker.status` payload shape
- new OpenAI progress events map to existing Kanban columns

**Step 2: Run test to verify it fails**

Run:

- `npm run test -- tests/unit/worker/orchestra-event-payload.test.ts`
- `npm run test -- tests/unit/worker/worker-workflow-tab.test.ts`

Expected: FAIL.

**Step 3: Write minimal implementation**

Implement:

- event adapter on server side (normalize sidecar events into current gateway event names)
- frontend receives same status keys and renders unchanged board columns

**Step 4: Run tests to verify they pass**

Run:

- `npm run test -- tests/unit/worker/orchestra-event-payload.test.ts`
- `npm run test -- tests/unit/worker/worker-workflow-tab.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/worker/utils/broadcast.ts src/server/gateway/events.ts src/modules/worker/hooks/useWorkerWorkflow.ts components/worker/WorkerKanbanBoard.tsx tests/unit/worker/orchestra-event-payload.test.ts tests/unit/worker/worker-workflow-tab.test.ts
git commit -m "feat(worker): preserve kanban websocket contract on openai runtime"
```

### Task 8: Add Operations, Security, Governance, And Failure Controls

**Files:**

- Create: `services/openai_worker/app/security.py`
- Create: `services/openai_worker/app/retries.py`
- Create: `services/openai_worker/app/budget.py`
- Create: `services/openai_worker/app/rate_limit.py`
- Create: `services/openai_worker/app/redaction.py`
- Create: `services/openai_worker/app/retention.py`
- Create: `services/openai_worker/app/ha_lock.py`
- Modify: `src/server/worker/workerCallback.ts`
- Modify: `src/server/config/gatewayConfig.ts`
- Create: `tests/integration/worker/openai-runtime-failover.test.ts`
- Test: `services/openai_worker/tests/test_security_policy.py`
- Test: `services/openai_worker/tests/test_budget_limits.py`
- Test: `services/openai_worker/tests/test_rate_limit.py`
- Test: `services/openai_worker/tests/test_redaction.py`
- Test: `services/openai_worker/tests/test_retention_ttl.py`
- Test: `services/openai_worker/tests/test_ha_single_leader.py`
- Create: `tests/integration/worker/openai-budget-enforcement.test.ts`
- Create: `tests/integration/worker/openai-rate-limit.test.ts`

**Step 1: Write failing reliability tests**

Add tests for:

- sidecar timeout -> Worker task goes to `interrupted` or `failed` deterministically
- tool allowlist deny behavior
- rollback to legacy runtime via feature flag
- cost and token budget enforcement per run/per user/per day
- request rate limiting with deterministic error responses
- PII redaction in logs/events and retention TTL cleanup
- HA single-leader processing semantics (no double-run on multi-replica)

**Step 2: Run test to verify it fails**

Run:

- `python -m pytest services/openai_worker/tests/test_security_policy.py -q`
- `python -m pytest services/openai_worker/tests/test_budget_limits.py services/openai_worker/tests/test_rate_limit.py services/openai_worker/tests/test_redaction.py services/openai_worker/tests/test_retention_ttl.py services/openai_worker/tests/test_ha_single_leader.py -q`
- `npm run test -- tests/integration/worker/openai-runtime-failover.test.ts`
- `npm run test -- tests/integration/worker/openai-budget-enforcement.test.ts`
- `npm run test -- tests/integration/worker/openai-rate-limit.test.ts`

Expected: FAIL.

**Step 3: Write minimal implementation**

Implement:

- sidecar auth token validation
- retry/backoff for callback delivery
- TS failover path + explicit operator log messages
- budget enforcement:
  - `maxTokensPerRun`
  - `maxCostUsdPerRun`
  - `maxCostUsdPerUserPerDay`
- rate limits:
  - sidecar API request limits per user/task
  - deterministic `429` payload with retry hints
- data governance:
  - PII redaction before logging/telemetry
  - retention TTL jobs for checkpoints/event logs
  - explicit delete path for run/session artifacts
- HA mode:
  - leader election/lock (DB or Redis lock)
  - only leader may dequeue/process runs
  - followers stay hot-standby

**Step 4: Run tests to verify they pass**

Run:

- `python -m pytest services/openai_worker/tests/test_security_policy.py -q`
- `python -m pytest services/openai_worker/tests/test_budget_limits.py services/openai_worker/tests/test_rate_limit.py services/openai_worker/tests/test_redaction.py services/openai_worker/tests/test_retention_ttl.py services/openai_worker/tests/test_ha_single_leader.py -q`
- `npm run test -- tests/integration/worker/openai-runtime-failover.test.ts`
- `npm run test -- tests/integration/worker/openai-budget-enforcement.test.ts`
- `npm run test -- tests/integration/worker/openai-rate-limit.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add services/openai_worker/app/security.py services/openai_worker/app/retries.py services/openai_worker/app/budget.py services/openai_worker/app/rate_limit.py services/openai_worker/app/redaction.py services/openai_worker/app/retention.py services/openai_worker/app/ha_lock.py src/server/worker/workerCallback.ts src/server/config/gatewayConfig.ts tests/integration/worker/openai-runtime-failover.test.ts tests/integration/worker/openai-budget-enforcement.test.ts tests/integration/worker/openai-rate-limit.test.ts services/openai_worker/tests/test_security_policy.py services/openai_worker/tests/test_budget_limits.py services/openai_worker/tests/test_rate_limit.py services/openai_worker/tests/test_redaction.py services/openai_worker/tests/test_retention_ttl.py services/openai_worker/tests/test_ha_single_leader.py
git commit -m "feat(worker): enforce security, budget, governance, and ha controls"
```

### Task 9: End-to-End Verification And Runbooks

**Files:**

- Create: `docs/runbooks/openai-worker-local-runbook.md`
- Create: `docs/runbooks/openai-worker-rollout.md`
- Create: `docs/runbooks/openai-worker-data-governance.md`
- Create: `.github/workflows/openai-worker-ci.yml`
- Create: `tests/load/worker-openai-load.test.ts`
- Modify: `docs/openai-agents-sdk-vs-openclaw-tiefenanalyse.md`
- Modify: `package.json`
- Test: `tests/e2e/worker/orchestra-lifecycle.e2e.test.ts`

**Step 1: Write failing rollout checklist test (if needed)**

Add smoke test marker for OpenAI runtime mode in E2E bootstrap.

**Step 2: Run verification suite before docs finalize**

Run:

- `npm run typecheck`
- `npm run test -- tests/e2e/worker/task-lifecycle.e2e.test.ts`
- `npm run test -- tests/e2e/worker/orchestra-lifecycle.e2e.test.ts`
- `npm run test -- tests/load/worker-openai-load.test.ts`
- `python -m pytest services/openai_worker/tests -q`

Expected: all PASS.

**Step 3: Write minimal operational docs**

Document:

- how to start sidecar + gateway together
- required env vars (`OPENAI_API_KEY`, sidecar URL/token, runtime flag)
- rollback switch to legacy runtime
- retention/redaction policy and deletion workflow
- MCP/computer use governance and incident response playbook

**Step 4: Add scripts**

Add scripts like:

- `worker:openai:dev`
- `worker:openai:test`
- `dev:stack` (gateway + sidecar)
- `worker:openai:load`
- `worker:openai:ci`

**Step 5: Commit**

```bash
git add docs/runbooks/openai-worker-local-runbook.md docs/runbooks/openai-worker-rollout.md docs/runbooks/openai-worker-data-governance.md .github/workflows/openai-worker-ci.yml tests/load/worker-openai-load.test.ts docs/openai-agents-sdk-vs-openclaw-tiefenanalyse.md package.json tests/e2e/worker/orchestra-lifecycle.e2e.test.ts
git commit -m "docs(worker): finalize runbooks, ci, and load validation for openai runtime"
```

## Final Verification Gate

Run before merge:

```bash
npm run typecheck
npm run lint
npm run test -- tests/unit/worker/worker-state-machine.test.ts
npm run test -- tests/unit/worker/openai-worker-runtime.test.ts
npm run test -- tests/integration/worker/openai-event-ordering.test.ts
npm run test -- tests/integration/worker/openai-duplicate-events.test.ts
npm run test -- tests/integration/worker/openai-cancel-during-approval.test.ts
npm run test -- tests/integration/worker/openai-schema-version.test.ts
npm run test -- tests/integration/worker/openai-runtime-failover.test.ts
npm run test -- tests/integration/worker/openai-budget-enforcement.test.ts
npm run test -- tests/integration/worker/openai-rate-limit.test.ts
npm run test -- tests/e2e/worker/task-lifecycle.e2e.test.ts
npm run test -- tests/load/worker-openai-load.test.ts
python -m pytest services/openai_worker/tests/test_event_idempotency.py services/openai_worker/tests/test_recovery_resume.py services/openai_worker/tests/test_queue_backpressure.py services/openai_worker/tests/test_tool_sandbox.py -q
python -m pytest services/openai_worker/tests/test_schema_version_compat.py services/openai_worker/tests/test_mcp_tool.py services/openai_worker/tests/test_computer_use_tool.py services/openai_worker/tests/test_budget_limits.py services/openai_worker/tests/test_rate_limit.py services/openai_worker/tests/test_redaction.py services/openai_worker/tests/test_retention_ttl.py services/openai_worker/tests/test_ha_single_leader.py -q
python -m pytest services/openai_worker/tests -q
```

Expected: all checks PASS, no Kanban status regression, approvals/subagents functional.

## Rollout Exit Criteria

Go live only if all are true:

1. Shadow mode for 24h with `0` state-corruption incidents and `0` unrecoverable stuck runs.
2. Canary 10% for at least 4h with failure rate not worse than legacy by more than `+1%`.
3. P95 approval wait time < `120s` and P95 run completion latency within agreed baseline.
4. Duplicate event rate < `0.1%` and out-of-order rejection rate < `0.1%`.
5. Rollback drill validated: runtime flag switch to `legacy` restores processing within 5 minutes.
6. Cost guardrails hold in canary:
   - no run exceeds `maxCostUsdPerRun`
   - no user exceeds `maxCostUsdPerUserPerDay`
7. Rate-limit behavior is stable: `429` responses < `1%` under expected load profile and no queue collapse.
8. HA validation passed: failover between replicas without double-processing any run.
9. Data governance checks passed:
   - log redaction removes configured secrets/PII classes
   - retention job purges expired run/checkpoint data on schedule.
10. MCP/Computer Use safety checks passed:
    - only allowlisted MCP servers reachable
    - Computer Use requires HITL for destructive actions and can be globally disabled.
