# Mission Control Agent Contract

## Metadata

- Purpose: Verbindliche Regeln fuer agentische Änderungen im Mission-Control-Bereich.
- Scope: `app/mission-control`, `app/api/master`, `app/api/tasks`, `src/modules/mission-control`, `src/server/master`.
- Source of Truth: Diese Datei und docs/contracts/DOMAIN_REGISTRY.json.
- Last Reviewed: 2026-03-05

---

## Invarianten

1. API-Routen bleiben thin und delegieren Fachlogik an `src/server/*`.
2. Statusübergänge fuer Runs und Tasks muessen explizit und testbar sein.
3. Approvals und sicherheitsrelevante Entscheidungen werden nie stillschweigend uebersprungen.

## Erlaubte Änderungsflächen

1. `app/api/master/*` fuer Request-Validierung und Delegation.
2. `src/server/master/*` fuer Orchestrierung, Repository-Logik, Verifikation.
3. `src/modules/mission-control/*` fuer UI-Interaktion ohne Infrastruktur-Execution.

## Verbotene Muster

1. Direkte SQL-Businesslogik in Mission-Control-UI-Komponenten.
2. Cross-domain Side-Effects ohne auditierten Ablauf (z. B. direkte Änderungen ausserhalb Scope).
3. Silent failure handling ohne Fehlerrueckgabe oder Audit-Eintrag.

## Pflicht-Tests

1. `tests/integration/master/*` fuer API-Vertrag und Laufzeitpfade.
2. `tests/integration/mission-control/*` fuer Missionsfluss und Task-Status.
3. `tests/unit/master/*` fuer Orchestrator-, Runtime- und Verifikationslogik.
