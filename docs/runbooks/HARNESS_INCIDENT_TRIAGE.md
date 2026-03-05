# Harness Incident Triage

## Purpose

Deterministische Behandlung von Harness- und Guardian-Incidents im main-only Modell.

## Trigger

1. `Async SLA Audit` markiert ein Issue mit `sla-breached`.
2. `Main Guardian` erstellt ein Incident-Issue (`harness-guardian`).
3. `GET /api/stats/engineering` zeigt `asyncFailureSlaBreaches > 0` oder `criticalFailAutoReverts > 0`.

## Daily Triage (15 min)

1. Offene `async-failure` und `harness-guardian` Issues sichten.
2. Owner, ETA und naechsten konkreten Fix-Schritt im Issue dokumentieren.
3. Wiederkehrende Fehler als Flaky-Kandidat markieren.

## Escalation Rules

1. `critical-incident` Label oder `main_head_advanced` Guardian-Fall => sofortige menschliche Uebernahme.
2. Zwei aufeinanderfolgende Blocking-Fails => Incident statt Routine-Follow-up.
3. Revert ohne klares Root-Cause-Update innerhalb eines Arbeitstags => Security/Architektur-Review.

## Data Handling

1. Harness-Events werden max. 90 Tage gehalten.
2. Ingest redigiert `run_url` (keine Query/Hash/Credentials) und normalisiert `error_kind`.
3. Keine Secrets oder Personenbezug in Evidence-Links oder Error-Feldern hinterlegen.
