# Auth Agent Contract

## Metadata

- Purpose: Verbindliche Regeln fuer agentische Aenderungen im Bereich Auth.
- Scope: "rust/crates/betaclaw-base/src/auth/**", "rust/crates/betaclaw-gateway/src/auth_gate.rs", "rust/crates/betaclaw-gateway/src/routes/**", "rust/crates/betaclaw-gateway/src/families/**", "app/login/**".
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

Der Rust-Gateway prüft HTTP-Requests (`auth_gate.rs`) und `/ws` (`ws.rs`) mit
derselben Session-Prüfung aus `betaclaw-base/src/auth/jwe.rs`: NextAuth-JWE,
sichere Cookie-Namen und Cookie-Chunks. Die Tests in `jwe.rs` laufen gegen eine
mit dem echten `next-auth@4.24.15` erzeugte Fixture; `pnpm run test:e2e:production`
prüft diese Grenze inklusive echter Anmeldung.

1. tests/e2e/browser/authentication.spec.ts
2. `rust/crates/betaclaw-base/src/auth/jwe.rs` (Session-Cookie-Fixture aus `next-auth@4.24.15`)
