# Security Agent Contract

## Metadata

- Purpose: Verbindliche Regeln fuer agentische Aenderungen im Bereich Security.
- Scope: "rust/crates/betaclaw-base/src/auth/**", "rust/crates/betaclaw-skills/src/security/**", "rust/crates/betaclaw-skills/src/net_guard/**", "rust/crates/betaclaw-skills/src/skills/exec_approval.rs", "rust/crates/betaclaw-master/src/master/safety.rs", "src/modules/security/**", "src/components/SecurityView.tsx".
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

Python-Ausführung benötigt dieselbe Policy/Freigabe wie Shell-Ausführung;
die Freigabeidentität enthält den Hash des exakten Codes. Direkte und
verschachtelte Aufrufe prüfen die Freigabe auch im Handler. Coding-Compat-Pfade
validieren reale Pfade und den existierenden Parent neuer Dateien. Diese
Prüfungen sind keine OS-Sandbox und schließen Symlink-Rennen nicht vollständig aus.
Sicherheitsanzeigen beschreiben HTTPS/WebCrypto und Command Policy, keine E2E-
Verschlüsselung oder Prozessisolation.

1. rust/crates/betaclaw-base/src/auth/policy.rs
2. rust/crates/betaclaw-skills/src/skills/exec_approval.rs
3. rust/crates/betaclaw-skills/src/skills/python_execute.rs
