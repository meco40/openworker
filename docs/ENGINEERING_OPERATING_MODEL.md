# Engineering Operating Model (Harness v4)

## Ziel

Dieses Modell legt fest, wie Mensch und Agent gemeinsam liefern:
main-only Delivery, harte post-push Sicherheits-Gates, asynchrone Qualitäts-Nachläufe und klare Eskalation.

## Rollen

1. Agent:

- implementiert innerhalb definierter Domänenverträge,
- liefert reproduzierbare Verifikation,
- dokumentiert Risiken, Rollback und Async-Follow-ups.

2. Mensch:

- entscheidet bei Architektur-, Security- und Datenmodelländerungen,
- priorisiert Risiken und Escalations,
- validiert Trade-offs bei grossen oder weitreichenden Änderungen.

## Main-Only Commit-Vertrag

Agentische main-Commits verwenden Trailer-Metadaten:

- `Agentic-Change: yes|no`
- `Harness-Scenario: <scenario-id>`
- `Harness-Evidence: <https-url>`
- `Risk-Class: low|medium|high`
- `Human-Approval: <user|none>`

Regeln:

1. `Agentic-Change: yes` erzwingt gueltiges Scenario + Evidence + Risk-Class.
2. High-risk-Pfade (Auth, Security, DB-Migration, Gateway, Memory-Core, Model-Hub-Dispatch) erzwingen `Human-Approval != none`.

## Gate-Model

1. Blocking Gates (Merge-blockierend):

- `typecheck`
- `lint`
- Unit/Integration
- `e2e:smoke`
- `Main Policy` (push auf `main`)

2. Async Gates (nicht merge-blockierend):

- Coverage
- Browser E2E
- Live E2E
- Flaky-Detection

Regel: Async-Fehler erzeugen innerhalb von 24h einen Follow-up-Task mit Owner.

3. Rollout Exit Gates (main-only Push Gate):

- `Rollout Exit Gates` (`.github/workflows/harness-rollout-gates.yml`)
- 4-Wochen-Phasenmodell via `config/harness-rollout-gates.json`
- im Enforcement-Modus blockiert ein roter Rollout-Gate-Status den Push-Check

## Guardian-Verhalten

Der `Main Guardian` reagiert auf fehlgeschlagene Blocking-Gates auf `main`:

1. Falls der fehlerhafte SHA noch aktueller `main`-Head ist: deterministischer Auto-Revert.
2. Falls `main` bereits weitergelaufen ist: kein Blind-Revert, stattdessen Incident-Issue.
3. Revert-Loop-Schutz: Guardian-Revert-Commits werden nicht erneut revertiert.

## Triage-Rhythmus

1. Täglich 15 Minuten:

- Async-Fehler sichten
- Owner + ETA setzen
- wiederkehrende Ausfälle priorisieren

2. Wöchentlich:

- Durchsatz- und Stabilitätsmetriken reviewen
- Top-3 Reibungspunkte mit klaren Gegenmassnahmen planen

3. Go/No-Go:

- `Harness Go No-Go` Workflow laeuft taeglich und entscheidet nur an den fixen Decision Dates.
- Empfehlung wird als dedupliziertes Decision-Issue dokumentiert (`go|hold|rollback-hardening`).

## Observability und Retention

1. Harness-Events sind OTel-kompatibel und enthalten `trace_id`, `span_id`, `domain`, `scenario`, `worktree_id`, `commit_sha`.
2. `GET /api/stats/engineering` liefert additiv:

- `domainCoverage`
- `scenarioSuccessRates`
- `worktreeHarness`
- `criticalFailAutoReverts`
- `rollout.phase`
- `rollout.exitGates`
- `rollout.recommendation`
- `rollout.baselineId`

3. Harness-Events werden mit 90-Tage-Retention gehalten und bei Ingest PII-sicher redigiert.

## Operator Entry Points

1. API:

- `GET /api/stats/engineering` (KPIs, Rollout-Status, Harness-Observability)
- `POST /api/internal/stats/engineering/snapshots` (internal ingest)

2. UI:

- `GET /mission-control/engineering-rollout` (kompaktes Live-Dashboard fuer Woche-1-4 und Go/No-Go)

## Flag-Matrix und Rollback

1. Flags:

- `ROLLOUT_GATES_ENFORCE` (`0|1`)
- `GO_NO_GO_ENFORCE` (`0|1`)
- `MAIN_GUARDIAN_AUTOREVERT_ENABLED` (`0|1`, Standard `1`)
- `ENGINEERING_INGEST_ENABLED` (`0|1`)
- `ASYNC_SLA_AUTOMATION_ENABLED` (`0|1`)
- `CLEANUP_DRAFT_PR_ENABLED` (`0|1`)
- `ENGINEERING_ALERTS_ENABLED` (`0|1`)

2. Rollout-Reihenfolge:

- Woche 1 report-only
- Woche 2-4 enforce

3. Rollback-Reihenfolge:

- `GO_NO_GO_ENFORCE=0`
- `ROLLOUT_GATES_ENFORCE=0`
- optional `MAIN_GUARDIAN_AUTOREVERT_ENABLED=0`
