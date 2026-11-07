# Model Hub Agent Contract

## Metadata

- Purpose: Verbindliche Regeln fuer agentische Aenderungen im Bereich Model Hub.
- Scope: "rust/crates/betaclaw-model-hub/**", "rust/crates/betaclaw-gateway/src/routes/**", "rust/crates/betaclaw-gateway/src/families/**", "src/components/model-hub/**", "src/shared/contracts/modelHub.ts".
- Source of Truth: Diese Datei und docs/contracts/DOMAIN_REGISTRY.json.
- Last Reviewed: 2026-11-07

---

## Invarianten

1. API/Runtime-Verhalten bleibt deterministisch und reproduzierbar.
2. Aenderungen bleiben innerhalb der freigegebenen Domain-Grenzen.
3. Sicherheits- und Datenintegritaetsregeln duerfen nicht abgeschwaecht werden.

## Erlaubte Aenderungsflaechen

1. Die in docs/contracts/DOMAIN_REGISTRY.json hinterlegten paths dieser Domain.
2. Domain-nahe Tests und Harness-Szenarien, die direkt dieser Domain zugeordnet sind.
3. Dokumentationsupdates in docs/\* fuer dieselbe Domain.

## Verbotene Muster

1. Cross-Domain Seiteneffekte ohne expliziten Contract- und Szenario-Bezug.
2. Implizite Side-Effects ohne deterministischen Fehlerpfad.
3. Aenderungen an High-Risk-Flaechen ohne erforderliche Human-Approval.

## Pflicht-Tests

1. rust/crates/betaclaw-model-hub/src/lib.rs
