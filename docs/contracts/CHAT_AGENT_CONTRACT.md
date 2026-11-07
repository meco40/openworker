# Chat Agent Contract

## Metadata

- Purpose: Verbindliche Regeln fuer agentische Änderungen im Chat-/Omnichannel-Pfad.
- Scope: "src/modules/chat/**", "rust/crates/betaclaw-channels/src/channels/messages/**", "rust/crates/betaclaw-gateway/src/families/chat_runtime/**", "rust/crates/betaclaw-gateway/src/routes/messages.rs", "src/components/ChatInterface.tsx", "src/components/ConnectionStatus.tsx".
- Source of Truth: Diese Datei und docs/contracts/DOMAIN_REGISTRY.json.
- Last Reviewed: 2026-11-07

---

## Invarianten

1. Chat-Streaming muss deterministische `done`-Frames liefern.
2. Persona-Isolation und Nutzerkontext duerfen nicht aufweichen.
3. Tool-Execution und Command-Routing bleiben durch Policy-Checks abgesichert.

## Erlaubte Änderungsflächen

1. `src/modules/chat/*` fuer UI/UX und lokale State-Logik.
2. `rust/crates/betaclaw-gateway/src/routes/messages.rs` und `src/families/chat_runtime/*` fuer HTTP-/WS-Entrypoints.
3. `rust/crates/betaclaw-channels/src/channels/messages/*` fuer Routing, Recall, Dispatch und Attachments.
4. `src/components/ChatInterface.tsx` und `src/components/ConnectionStatus.tsx` fuer Chat- und Verbindungsanzeige.

## Verbotene Muster

1. Infrastrukturzugriffe direkt in React-Komponenten.
2. Bypassing von Auth-/Scope-Guards in API-Routen.
3. Nicht deterministische Queue-/Abort-Logik ohne Tests.

## Pflicht-Tests

1. `tests/e2e/chat/*` fuer Stream-, Abort-, Queue- und Persona-Pfade.
2. `tests/unit/chat/*` fuer UI- und Utility-Verhalten.
3. `tests/e2e/browser/chat-smoke.spec.ts` und die Rust-Tests in `betaclaw-channels` fuer API- und Sicherheitsverträge.
