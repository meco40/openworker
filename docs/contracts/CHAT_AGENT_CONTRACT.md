# Chat Agent Contract

## Metadata

- Purpose: Verbindliche Regeln fuer agentische Änderungen im Chat-/Omnichannel-Pfad.
- Scope: `src/modules/chat`, `app/api/channels`, `src/server/channels/messages`, relevante Gateway-Methoden.
- Source of Truth: Diese Datei ist der verbindliche Vertrag fuer Chat-Agent-Arbeit.
- Last Reviewed: 2026-03-04

---

## Invarianten

1. Chat-Streaming muss deterministische `done`-Frames liefern.
2. Persona-Isolation und Nutzerkontext duerfen nicht aufweichen.
3. Tool-Execution und Command-Routing bleiben durch Policy-Checks abgesichert.

## Erlaubte Änderungsflächen

1. `src/modules/chat/*` fuer UI/UX und lokale State-Logik.
2. `app/api/channels/*` fuer HTTP-Entrypoints.
3. `src/server/channels/messages/*` fuer Routing, Recall, Dispatch und Attachments.

## Verbotene Muster

1. Infrastrukturzugriffe direkt in React-Komponenten.
2. Bypassing von Auth-/Scope-Guards in API-Routen.
3. Nicht deterministische Queue-/Abort-Logik ohne Tests.

## Pflicht-Tests

1. `tests/e2e/chat/*` fuer Stream-, Abort-, Queue- und Persona-Pfade.
2. `tests/unit/chat/*` fuer UI- und Utility-Verhalten.
3. `tests/integration/channels/*` fuer API- und Sicherheitsverträge.
