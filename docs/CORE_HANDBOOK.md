# Core Handbook

Stand: 2026-02-13

## Zweck

Diese Datei ist die aktive technische Referenz fuer die aktuelle Codebasis.
Historische Analysen, Reviews und alte Planstaende liegen unter `docs/archive/`.

## Stack und Runtime

- Framework: Next.js App Router (`next` 16.1.6)
- UI: React 19.2.4
- Sprache: TypeScript strict
- Persistenz: SQLite ueber `better-sqlite3`
- Realtime: WebSocket Gateway (`ws`) auf `/ws`
- Auth: NextAuth v4 (JWT/Credentials)

Quelle:
- `package.json`
- `server.ts`
- `src/server/gateway/*`

## Projektstruktur

- `app/`: API Routes und Next entrypoints
- `src/modules/`: Frontend Feature-Module
- `src/server/`: Server-Domaenen (channels, rooms, worker, model-hub, skills, memory, gateway)
- `src/shared/`: geteilte Typen/Utilities
- `tests/`: unit/integration/contract

## Architekturregeln

1. UI-Komponenten enthalten keine Infrastruktur-Execution.
2. API-Routen parsen Requests und delegieren an Services/Use-Cases.
3. Business-Logik lebt in `src/server/*` bzw. Feature-Services.
4. `src/shared` darf von Modulen/Server genutzt werden, aber nicht umgekehrt.
5. Neue Aenderungen bleiben strict-typed und testbar.

## Realtime und Messaging

- Legacy-SSE fuer Chat/Logs wurde entfernt.
- Primarer Realtime-Kanal ist WebSocket mit RPC + Event-Frames.
- Channel- und Inbox-Operationen laufen serverseitig ueber `src/server/channels/*`.

## Rooms und Personas

- Kanonische Rooms-Doku: `docs/PERSONA_ROOMS_SYSTEM.md`
- Runtime-Rollensteuerung fuer Rooms: `ROOMS_RUNNER` (`web|scheduler|both`)

## Security

- User-Kontext und Auth-Checks auf privilegierten APIs.
- Command-Sicherheitsregeln fuer Skill-/Shell-nahe Pfade.
- Channel Webhook-Absicherung + Credential Store.

## Quality Gates

- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run build`

## Doku-Map

- Einstieg: `docs/README.md`
- Core: `docs/CORE_HANDBOOK.md`
- Rooms/Personas: `docs/PERSONA_ROOMS_SYSTEM.md`
- Omnichannel/Gateway Betrieb: `docs/OMNICHANNEL_GATEWAY_OPERATIONS.md`
- Session-Implementierung: `docs/SESSION_MANAGEMENT_IMPLEMENTATION.md`
- Provider-Matrix: `docs/architecture/model-hub-provider-matrix.md`
- Aktive Plaene: `docs/plans/README.md`
- Archiv: `docs/archive/README.md`