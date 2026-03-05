# Agent Verify Harness Runbook

## Zweck

Deterministischer Verify-Pfad fuer alle aktiven Domänen mit reproduzierbaren Artefakten.

## Ausfuehrung

```bash
node --import tsx scripts/harness/agent-verify.mjs
```

Optional nur einzelne Szenarien:

```bash
node --import tsx scripts/harness/agent-verify.mjs --scenario chat-stream --scenario persona-switch
```

Alle erlaubten Szenarien sind in `docs/contracts/DOMAIN_SCENARIO_MATRIX.json` definiert.
`agent-verify` verwendet diese Matrix als Source of Truth.

## Harness-Bootfolge (deterministisch)

1. Isolierter Worktree (optional) und isolierte DB-/Pfad-Umgebung.
2. Build-Prerequisite (`pnpm run build`) falls keine `.next` Artefakte vorhanden sind.
3. Scheduler-Start (`node --import tsx scheduler.ts`).
4. Deterministische E2E-Smoke-Lane (`pnpm run test:e2e:smoke`).
5. Domain-Szenarien aus der Scenario-Matrix.

## Enthaltene Kernszenarien

1. `chat-stream` → `tests/e2e/browser/chat-smoke.spec.ts`
2. `persona-switch` → `tests/e2e/browser/chat-queue-and-persona.spec.ts`
3. `master-run-feedback` → `tests/e2e/browser/mission-control-run-feedback.spec.ts`

## Artefakte

Output unter `.local/harness/<timestamp>/`:

- `commands.log`
- `test-results/`
- `playwright-report/`
- `scenario-matrix.json`
- `run-summary.json`

## Fehlerbehandlung

1. Harness-Fehler blockieren den lokalen Verify-Status fuer agentische PRs.
2. Async-Fehler in Browser-/Live-Lanes bekommen einen Follow-up-Task (24h SLA).
3. Jeder agentische main-Commit muss mindestens ein betroffenes Domänenszenario als Evidence nachweisen.
4. `run-summary.json` enthaelt `exitReason`, `worktreeId`, `commitSha` und pro Szenario den Status.
