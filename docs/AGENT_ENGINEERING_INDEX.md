# Agent Engineering Index

## Metadata

- Purpose: Zentrales Einstiegspunkt-Dokument fuer Harness-Engineering, Agent-Legibility und Delivery-Standards.
- Scope: Main-only Betriebsmodell, Agent-Harness, Domänenverträge, Governance und Betriebsmodell fuer alle aktiven Domänen.
- Source of Truth: Diese Seite verweist auf die verbindlichen Agent-Engineering-Dokumente fuer den gesamten aktiven System-Scope.
- Last Reviewed: 2026-10-08

---

## Verbindliche Referenzen

- `docs/contracts/*_AGENT_CONTRACT.md` (alle aktiven Domain-Contracts)
- `docs/contracts/DOMAIN_REGISTRY.json`
- `docs/contracts/DOMAIN_SCENARIO_MATRIX.json`
- `config/harness-rollout-gates.json` (veraltet, siehe Governance-Regel 7)
- `docs/ENGINEERING_OPERATING_MODEL.md`
- `docs/runbooks/AGENT_VERIFY_HARNESS.md`
- `docs/runbooks/HARNESS_INCIDENT_TRIAGE.md`
- `docs/TECH_DEBT_REGISTER.md`

## Governance-Regeln

1. Jede aktive Domäne im Registry-SoR benoetigt genau einen gueltigen Contract.
2. `Last Reviewed` in allen Contract-Dokumenten darf maximal 30 Tage alt sein.
3. Blocking Gates in `.github/workflows/ci.yml` sind fuer `main` verbindlich, inklusive `Main Policy`.
4. Async Gates und SLA-Follow-up laufen in `.github/workflows/async-quality.yml` und `.github/workflows/async-sla-audit.yml`.
5. Kritische Blocking-Fails auf `main` werden durch `.github/workflows/main-guardian.yml` post-push abgesichert.
6. Engineering-Observability wird ueber `GET /api/stats/engineering` inklusive Domain-/Scenario-/Worktree-Metriken ausgewertet.
7. Rollout-Exit-Gates und Go/No-Go sind seit 2026-10-09 entfernt (keine Workflows mehr). `config/harness-rollout-gates.json` ist veraltet: Phasenfenster seit 2026-04-05 abgelaufen. Die Datei bleibt nur, weil `GET /api/stats/engineering` sie ueber `src/server/stats/harnessRollout.ts` liest.

## Operator Entry Points

1. API:

- `GET /api/stats/engineering`
- `POST /api/internal/stats/engineering/snapshots`
