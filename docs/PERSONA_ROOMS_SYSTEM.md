# Persona and Rooms System

Stand: 2026-02-13

## Scope

Diese Datei ist die aktive technische Referenz fuer Personas + Rooms.
Sie ersetzt den Mix aus Analysebericht, Implementierungsnotizen und Hardening-Rollout.
Historische Detailstaende liegen unter `docs/archive/rooms/` und `docs/archive/plans/completed/`.

## Systemueberblick

- Personas definieren Identitaet und Verhaltenskontext ueber Datei-Inhalte pro Persona.
- Rooms orchestrieren Multi-Persona-Diskussionen mit persisted state.
- Room-Zyklen laufen serverseitig ueber den Orchestrator.
- UI-Sync erfolgt ueber Gateway Events (`room.*`) via WebSocket.

## Hauptkomponenten

- Persona Domain:
  - `src/server/personas/personaRepository.ts`
  - `src/server/personas/personaTypes.ts`
- Rooms Domain:
  - `src/server/rooms/repository.ts`
  - `src/server/rooms/sqliteRoomRepository.ts`
  - `src/server/rooms/service.ts`
  - `src/server/rooms/orchestrator.ts`
  - `src/server/rooms/toolExecutor.ts`
  - `src/server/rooms/runtimeRole.ts`
- API:
  - `app/api/rooms/*`
  - `app/api/personas/*`
- Frontend:
  - `src/modules/rooms/*`
  - `components/PersonasView.tsx`

## Persistenz

Rooms speichern in `messages.db` (SQLite, `better-sqlite3`) u. a.:
- `rooms`
- `room_members`
- `room_runs`
- `room_messages`
- `room_message_sequences` (atomische Sequenzvergabe)
- `room_member_runtime`
- `room_persona_sessions`
- `room_persona_context`
- `room_interventions`
- `persona_permissions`

## Runtime und Scheduling

- Room-Zyklen werden durch den Orchestrator ausgefuehrt.
- Reentrancy-Guard verhindert ueberlappende `runOnce()` in derselben Instanz.
- Lease-Mechanik + Keepalive sichern Single-Owner-Verarbeitung je Room.
- Stop-Race-Schutz verhindert falsches Ueberschreiben von `stopped` nach `degraded`.
- `ROOMS_RUNNER` steuert, welche Runtime Rooms ausfuehrt (`web`, `scheduler`, `both`).

## Model-Routing und Ausfuehrung

Routing-Reihenfolge pro Mitglied:
1. Member `model_override` (wenn im aktiven Profil verfuegbar)
2. Room-Profil
3. Fallback-Profil `p1`

Pro Turn:
- Prompt-/Kontextaufbau
- optional Tool Calls (permission-checked)
- Antwortpersistenz + Broadcast
- Runtime-Status/Metriken aktualisieren

## Realtime Events

Der Server emittiert:
- `room.message`
- `room.member.status`
- `room.run.status`
- `room.intervention`
- `room.metrics`

Client-seitiger Sync:
- `src/modules/rooms/useRoomSync.ts`

## API Surface (wichtig)

- `GET/POST /api/rooms`
- `GET/DELETE /api/rooms/[id]`
- `POST /api/rooms/[id]/start`
- `POST /api/rooms/[id]/stop`
- `GET /api/rooms/[id]/state`
- `GET/POST /api/rooms/[id]/messages`
- `GET/POST /api/rooms/[id]/interventions`
- `POST /api/rooms/[id]/members`
- `DELETE /api/rooms/[id]/members/[personaId]`

## Verifikation

Relevante Testbereiche:
- `tests/unit/rooms/*`
- `tests/integration/rooms/*`
- `tests/integration/security/privileged-routes-auth.test.ts`

Empfohlener Check:
- `npm run test -- tests/unit/rooms tests/integration/rooms`
- `npm run lint`
- `npm run typecheck`

## Bekannte Grenzen

- SQLite-basierte Single-Node-Charakteristik fuer hohe horizontale Skalierung.
- Keine dedizierte Queue-Infrastruktur fuer Rooms-Orchestrierung (timer-basiert).
- UI-Timeline kann bei sehr langen Verlaeufen weiter optimiert werden (Pagination/Virtualisierung).

## Historie

Historische Rooms-Dokumente:
- `docs/archive/rooms/2026-02-12-rooms-stability-performance-analysis.md`
- `docs/archive/rooms/2026-02-12-rooms-system-maengel-analyse.md`
- `docs/archive/rooms/ROOMS_IMPLEMENTATION_NOTES.md`
- `docs/archive/plans/completed/2026-02-12-rooms-*.md`