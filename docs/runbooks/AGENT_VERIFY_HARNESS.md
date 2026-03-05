# Agent Verify Harness Runbook

## Zweck

Deterministischer Verify-Pfad fuer Mission Control + Chat mit reproduzierbaren Artefakten.

## Ausfuehrung

```bash
node --import tsx scripts/harness/agent-verify.mjs
```

Optional nur einzelne Szenarien:

```bash
node --import tsx scripts/harness/agent-verify.mjs --scenario chat-stream --scenario persona-switch
```

## Enthaltene Szenarien

1. `chat-stream` → `tests/e2e/browser/chat-smoke.spec.ts`
2. `persona-switch` → `tests/e2e/browser/chat-queue-and-persona.spec.ts`
3. `master-run-feedback` → `tests/e2e/browser/mission-control-run-feedback.spec.ts`

## Artefakte

Output unter `.local/harness/<timestamp>/`:

- `commands.log`
- `test-results/`
- `playwright-report/`

## Fehlerbehandlung

1. Harness-Fehler blockieren den lokalen Verify-Status fuer agentische PRs.
2. Async-Fehler in Browser-/Live-Lanes bekommen einen Follow-up-Task (24h SLA).
