# Worker Orchestra V1 Rollout Runbook

## Scope
This runbook covers safe rollout, monitoring, and rollback for Worker Orchestra V1:
- Global `Orchestra` builder tab (draft + publish flow lifecycle)
- Task-level `Workflow` tab (live run graph)
- Orchestra runtime execution with fail-fast behavior
- Transparency layer (subagent sessions, activity log, deliverables)

## Feature Flags
Use these runtime flags to control exposure:
- `WORKER_ORCHESTRA_ENABLED`
- `WORKER_ORCHESTRA_BUILDER_WRITE_ENABLED`
- `WORKER_WORKFLOW_TAB_ENABLED`

Recommended operational settings:
- Staging warm-up:
  - `WORKER_ORCHESTRA_ENABLED=1`
  - `WORKER_ORCHESTRA_BUILDER_WRITE_ENABLED=1`
  - `WORKER_WORKFLOW_TAB_ENABLED=1`
- Production canary (safe default):
  - `WORKER_ORCHESTRA_ENABLED=1`
  - `WORKER_ORCHESTRA_BUILDER_WRITE_ENABLED=0`
  - `WORKER_WORKFLOW_TAB_ENABLED=1`

## Pre-Deploy Checklist
1. `npm run typecheck` passes.
2. `npm run lint` passes.
3. Worker/Rooms non-regression tests pass.
4. Orchestra-specific unit and integration tests pass.
5. `npm run build` passes.

## Staging Validation
Run these scenarios end-to-end on staging:
1. Research flow:
  - create draft, publish flow, execute task
  - verify workflow graph updates (`pending -> running -> completed`)
2. Fail-fast path:
  - inject a failing node
  - verify run and task move to `failed` immediately
  - verify remaining pending nodes are marked `skipped`
3. Transparency/export:
  - verify activities, subagent sessions, deliverables endpoints
  - verify export zip includes `deliverables.json` and `deliverables/*`

## Observability
Use `GET /api/control-plane/metrics` and watch:
- `metrics.orchestra.runCount`
- `metrics.orchestra.failFastAbortCount`
- `metrics.orchestra.activeSubagentSessions`

Operational expectations:
- `runCount` steadily increases with Orchestra-enabled executions.
- `failFastAbortCount` correlates with known failure tests and incident rate.
- `activeSubagentSessions` should return to near zero after load drains.

## Rollout Procedure (Production)
1. Deploy with code in place and verify health checks.
2. Enable:
  - `WORKER_ORCHESTRA_ENABLED=1`
  - `WORKER_WORKFLOW_TAB_ENABLED=1`
  - keep `WORKER_ORCHESTRA_BUILDER_WRITE_ENABLED=0`
3. Run 30-minute canary with internal traffic.
4. If stable, enable builder writes:
  - `WORKER_ORCHESTRA_BUILDER_WRITE_ENABLED=1`
5. Continue monitoring metrics and error logs for at least one release window.

## Rollback Procedure
Execute in order:
1. Disable workflow tab:
  - `WORKER_WORKFLOW_TAB_ENABLED=0`
2. Disable builder writes:
  - `WORKER_ORCHESTRA_BUILDER_WRITE_ENABLED=0`
3. Disable orchestra runtime:
  - `WORKER_ORCHESTRA_ENABLED=0`
4. If instability persists, redeploy previous known-good release.

## Incident Notes Template
- Date/time (UTC):
- Release version:
- Flags at incident start:
- Symptoms:
- Impacted endpoints:
- Key metric deltas:
- Mitigation steps:
- Final root cause:
- Follow-up actions:

