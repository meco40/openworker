# Persona and Rooms System

## Metadata

- Purpose: Verbindliche Referenz fuer Persona- und Room-Orchestrierung.
- Scope: Room-Lifecycle, Member-Management, Orchestrator-Steuerung, Runtime-Rollen.
- Source of Truth: This is the active system documentation for this domain and overrides archived documents on conflicts.
- Last Reviewed: 2026-02-21
- Related Runbooks: docs/runbooks/gateway-config-production-rollout.md

---

## 1. Funktionserläuterung

Das Persona-/Rooms-System orchestriert Multi-Persona-Konversationen in persistenten Rooms mit gesteuertem Turn-Zyklus.

### Kernkonzepte

- **Persona**: Konfigurierbare Identität inkl. dateibasiertem Kontext
- **Room**: Laufender Multi-Persona-Container
- **Member**: Persona-Zuordnung mit Status/Model-Overrides
- **Orchestrator**: Turn-Ausführung, Lease/Keepalive, Dispatch
- **Runtime Role**: Ausführungsmodus `web`, `scheduler`, `both`

---

## 2. Architektur

### 2.1 Komponenten

- `src/server/personas/personaRepository.ts`
- `src/server/rooms/service.ts`
- `src/server/rooms/orchestrator.ts`
- `src/server/rooms/orchestratorInterval.ts`
- `src/server/rooms/runtimeRole.ts`
- `src/server/rooms/sqliteRoomRepository.ts`
- `app/api/rooms/*`
- `app/api/personas/*`

### 2.2 Lease- und Runtime-Modell

Rooms verwenden Lease-Mechanik, um parallele Verarbeitung zu verhindern. Der aktive Runner wird über `ROOMS_RUNNER` gesteuert.

---

## 3. API-Referenz

### 3.1 Rooms

| Methode | Pfad                                  | Zweck                  |
| ------- | ------------------------------------- | ---------------------- |
| GET     | `/api/rooms`                          | Rooms listen           |
| POST    | `/api/rooms`                          | Room erstellen         |
| GET     | `/api/rooms/[id]`                     | Room laden             |
| DELETE  | `/api/rooms/[id]`                     | Room löschen           |
| POST    | `/api/rooms/[id]/start`               | Room starten           |
| POST    | `/api/rooms/[id]/stop`                | Room stoppen           |
| GET     | `/api/rooms/[id]/state`               | Room-State laden       |
| GET     | `/api/rooms/[id]/messages`            | Room-Nachrichten laden |
| POST    | `/api/rooms/[id]/messages`            | Room-Nachricht senden  |
| GET     | `/api/rooms/[id]/interventions`       | Interventionen laden   |
| POST    | `/api/rooms/[id]/interventions`       | Intervention erstellen |
| POST    | `/api/rooms/[id]/members`             | Member hinzufügen      |
| PATCH   | `/api/rooms/[id]/members/[personaId]` | Member aktualisieren   |
| DELETE  | `/api/rooms/[id]/members/[personaId]` | Member entfernen       |
| GET     | `/api/rooms/membership-counts`        | Membership-Kennzahlen  |

### 3.2 Personas

| Methode | Pfad                                  | Zweck                   |
| ------- | ------------------------------------- | ----------------------- |
| GET     | `/api/personas`                       | Personas listen         |
| POST    | `/api/personas`                       | Persona erstellen       |
| GET     | `/api/personas/[id]`                  | Persona laden           |
| PUT     | `/api/personas/[id]`                  | Persona aktualisieren   |
| DELETE  | `/api/personas/[id]`                  | Persona löschen         |
| GET     | `/api/personas/[id]/files/[filename]` | Persona-Datei lesen     |
| PUT     | `/api/personas/[id]/files/[filename]` | Persona-Datei schreiben |
| GET     | `/api/personas/templates`             | Templates laden         |

---

## 4. Realtime-Events (Auswahl)

- `room.message`
- `room.member.status`
- `room.run.status`
- `room.intervention`
- `room.metrics`

---

## 5. Verifikation

```bash
npm run test -- tests/unit/rooms
npm run test -- tests/integration/rooms
npm run typecheck
npm run lint
```

---

## 6. Siehe auch

- `docs/SESSION_MANAGEMENT.md`
- `docs/MEMORY_SYSTEM.md`
- `docs/API_REFERENCE.md`
