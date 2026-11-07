# Mission Control Agent Contract

## Metadata

- Purpose: Verbindliche Regeln fuer agentische Änderungen im Mission-Control-Bereich.
- Scope: "src/modules/master/**", "src/modules/app-shell/**", "src/modules/agent-room/**", "src/components/Sidebar.tsx", "src/lib/config.ts", "app/layout.tsx", "app/globals.css", "app/icon.svg", "src/components/Dashboard.tsx", "src/components/config/**", "src/components/shared/**", "src/shared/domain/types.ts", "rust/crates/betaclaw-gateway/src/routes/**", "rust/crates/betaclaw-gateway/src/families/**", "rust/crates/betaclaw-master/**".
- Source of Truth: Diese Datei und docs/contracts/DOMAIN_REGISTRY.json.
- Last Reviewed: 2026-11-07

---

## Invarianten

1. Gateway-Routen bleiben thin und delegieren Fachlogik an die Domain-Crates (`betaclaw-master`, `betaclaw-features`).
2. Statusübergänge fuer Runs und Tasks muessen explizit und testbar sein.
3. Approvals und sicherheitsrelevante Entscheidungen werden nie stillschweigend uebersprungen.

## Erlaubte Änderungsflächen

1. `rust/crates/betaclaw-gateway/src/families/master/*` fuer Request-Validierung und Delegation.
2. `rust/crates/betaclaw-master/src/master/*` fuer Orchestrierung, Repository-Logik, Verifikation.
3. `src/modules/master/*` fuer UI-Interaktion ohne Infrastruktur-Execution.
4. Die Shell-, Dashboard-, Konfigurations- und Planungsoberflächen aus `DOMAIN_REGISTRY.json` fuer lokale UI-Logik.

## Verbotene Muster

1. Direkte SQL-Businesslogik in Mission-Control-UI-Komponenten.
2. Cross-domain Side-Effects ohne auditierten Ablauf (z. B. direkte Änderungen ausserhalb Scope).
3. Silent failure handling ohne Fehlerrueckgabe oder Audit-Eintrag.

## Pflicht-Tests

1. `tests/e2e/browser/mission-control-run-feedback.spec.ts` fuer Missionsfluss und Run-Feedback.
2. `tests/unit/mission-control/*` fuer Task-Status.
3. `tests/unit/master/*` und die Rust-Tests in `betaclaw-master` fuer Orchestrator-, Runtime- und Verifikationslogik.
