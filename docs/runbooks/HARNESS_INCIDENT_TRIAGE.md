# Harness Incident Triage

## Purpose

Deterministische Behandlung von Harness- und Guardian-Incidents im main-only Modell.

## Trigger

1. `Async SLA Audit` markiert ein Issue mit `sla-breached`.
2. `Main Guardian` erstellt ein Incident-Issue (`harness-guardian`).
3. `GET /api/stats/engineering` zeigt `asyncFailureSlaBreaches > 0` oder `criticalFailAutoReverts > 0`.
4. `Rollout Exit Gates` erzeugt/aktualisiert `harness-rollout` Issues.
5. `Harness Go No-Go` erzeugt Decision-Issues und `go-no-go` Follow-up-Issues.

## Daily Triage (15 min)

1. Offene `async-failure`, `harness-guardian`, `harness-rollout` und `go-no-go` Issues sichten.
2. Owner, ETA und naechsten konkreten Fix-Schritt im Issue dokumentieren.
3. Wiederkehrende Fehler als Flaky-Kandidat markieren.

## Escalation Rules

1. `critical-incident` Label oder `main_head_advanced` Guardian-Fall => sofortige menschliche Uebernahme.
2. Zwei aufeinanderfolgende Blocking-Fails => Incident statt Routine-Follow-up.
3. Revert ohne klares Root-Cause-Update innerhalb eines Arbeitstags => Security/Architektur-Review.

## Rollback Toggles (hart)

1. Sofortmassnahme bei anhaltenden Fehlalarmen:

- `GO_NO_GO_ENFORCE=0`
- `ROLLOUT_GATES_ENFORCE=0`

2. Nur bei anhaltender Fehl-Revert-Kaskade:

- `MAIN_GUARDIAN_AUTOREVERT_ENABLED=0`

## Data Handling

1. Harness-Events werden max. 90 Tage gehalten.
2. Ingest redigiert `run_url` (keine Query/Hash/Credentials) und normalisiert `error_kind`.
3. Keine Secrets oder Personenbezug in Evidence-Links oder Error-Feldern hinterlegen.
