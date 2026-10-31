# Mission Control Agent Contract

## Metadata

- Purpose: Verbindliche Regeln fuer agentische Änderungen im Mission-Control-Bereich.
- Scope: "src/modules/mission-control/**", "app/mission-control/**", "src/components/Sidebar.tsx", "src/lib/config.ts", "src/modules/app-shell/**", "app/layout.tsx", "app/globals.css", "app/icon.svg", "src/components/Dashboard.tsx", "src/components/DeliverablesList.tsx", "src/components/config/**", "src/components/planning/**", "src/lib/planning-utils.ts", "src/shared/domain/types.ts", "app/api/master/**", "src/server/master/**", "src/components/shared/**", "src/modules/agent-room/**".
- Source of Truth: Diese Datei und docs/contracts/DOMAIN_REGISTRY.json.
- Last Reviewed: 2026-10-09

---

## Invarianten

1. API-Routen bleiben thin und delegieren Fachlogik an `src/server/*`.
2. Statusübergänge fuer Runs und Tasks muessen explizit und testbar sein.
3. Approvals und sicherheitsrelevante Entscheidungen werden nie stillschweigend uebersprungen.

## Erlaubte Änderungsflächen

1. `app/api/master/*` fuer Request-Validierung und Delegation.
2. `src/server/master/*` fuer Orchestrierung, Repository-Logik, Verifikation.
3. `src/modules/mission-control/*` fuer UI-Interaktion ohne Infrastruktur-Execution.
4. Die Shell-, Dashboard-, Konfigurations- und Planungsoberflächen aus `DOMAIN_REGISTRY.json` fuer lokale UI-Logik.

## Verbotene Muster

1. Direkte SQL-Businesslogik in Mission-Control-UI-Komponenten.
2. Cross-domain Side-Effects ohne auditierten Ablauf (z. B. direkte Änderungen ausserhalb Scope).
3. Silent failure handling ohne Fehlerrueckgabe oder Audit-Eintrag.

## Pflicht-Tests

1. `tests/integration/master/*` fuer API-Vertrag und Laufzeitpfade.
2. `tests/integration/mission-control/*` fuer Missionsfluss und Task-Status.
3. `tests/unit/master/*` fuer Orchestrator-, Runtime- und Verifikationslogik.
