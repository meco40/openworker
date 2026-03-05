# Harness Rollout Gates Runbook

## Purpose

Verbindliche Steuerung der 4-Wochen-Harness-Rollout-Phasen mit harten Exit-Gates im main-only Modell.

## Source of Truth

1. `config/harness-rollout-gates.json`
2. `.github/workflows/harness-rollout-gates.yml`
3. `.github/workflows/harness-go-no-go.yml`

## Baseline

1. Baseline-ID: `baseline-2026-02-07_2026-03-08`
2. Fenster: `2026-02-07T00:00:00Z` bis `2026-03-08T23:59:59Z`
3. Persistenz: `engineering_rollout_baselines`

## Flags

1. `ROLLOUT_GATES_ENFORCE` (`0|1`)
2. `GO_NO_GO_ENFORCE` (`0|1`)
3. `MAIN_GUARDIAN_AUTOREVERT_ENABLED` (`0|1`, default `1`)
4. `ROLLOUT_GATE_OWNER` (Issue-Owner)
5. `GO_NO_GO_OWNER` (Decision-/Follow-up-Owner)
6. `ROLLOUT_SLA_HOURS` (Default 24)

## Ingest prerequisites

1. App runtime:
   - `ENGINEERING_INGEST_ENABLED=1`
   - `ENGINEERING_INGEST_TOKEN=<shared-token>`
2. GitHub Actions secrets:
   - `ENGINEERING_INGEST_URL` (z. B. `https://<host>/api/internal/stats/engineering/snapshots`)
   - `ENGINEERING_INGEST_TOKEN` (muss dem Runtime-Token entsprechen)
3. Wenn URL oder Token fehlen, laufen Workflows report-only und posten keinen Snapshot-Ingest.

## Live dashboard

1. UI-Route: `/mission-control/engineering-rollout`
2. Datenquelle: `GET /api/stats/engineering`
3. Zweck: Woche-1-4 Exit-Gates, Baseline-Delta, KPI-Drift, Go/No-Go-Empfehlung.

## Weekly matrix

1. Woche 1 (`2026-03-09` bis `2026-03-15`): report-only
2. Woche 2 (`2026-03-16` bis `2026-03-22`): enforce
3. Woche 3 (`2026-03-23` bis `2026-03-29`): enforce
4. Woche 4 (`2026-03-30` bis `2026-04-05`): enforce + Go/No-Go

## Rollback order

1. `GO_NO_GO_ENFORCE=0`
2. `ROLLOUT_GATES_ENFORCE=0`
3. optional `MAIN_GUARDIAN_AUTOREVERT_ENABLED=0`

## Dedupe labels

1. Rollout gates: `harness-rollout:phase:<phase>`
2. Go/No-Go decision: `go-no-go:date:<yyyy-mm-dd>`
3. Go/No-Go follow-up: `go-no-go:gate:<gate-id>:date:<yyyy-mm-dd>`
