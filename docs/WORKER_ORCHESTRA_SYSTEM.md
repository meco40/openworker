# Worker Orchestra System

## Metadata

- Purpose: Verbindliche Referenz zum aktuellen Orchestrierungsstand nach Entfernung des frueheren Worker-Orchestra-API-Stacks.
- Scope: Migration von Worker-Orchestra auf Rooms-Orchestrator, aktive Runtime-Pfade, Statusmodelle, API-Mapping.
- Source of Truth: This is the active system documentation for this domain and overrides archived documents on conflicts.
- Last Reviewed: 2026-02-21
- Related Runbooks: docs/runbooks/gateway-config-production-rollout.md

---

## 1. Aktueller Status

Die fruehere graphbasierte Worker-Orchestra-API (`/api/worker/orchestra/*`) ist im aktuellen Code nicht mehr aktiv.

Aktive Orchestrierung erfolgt ueber das Rooms-Subsystem:

- Room-Lifecycle per `app/api/rooms/*`
- Laufzeit-Orchestrierung per `src/server/rooms/orchestrator.ts`
- Operative Uebersicht per `app/api/ops/agents` und `app/api/ops/nodes`

---

## 2. Aktive Architektur

### 2.1 Kernkomponenten

- `src/server/rooms/orchestrator.ts`
- `src/server/rooms/orchestratorInterval.ts`
- `src/server/rooms/orchestratorUtils.ts`
- `src/server/rooms/service.ts`
- `src/server/rooms/runtime.ts`
- `src/server/rooms/repositories/*`
- `app/api/rooms/*`
- `app/api/ops/agents/route.ts`
- `app/api/ops/nodes/route.ts`

### 2.2 Laufzeitmodell

- Lease-basierte Ausfuehrung pro aktivem Room-Run
- Round-Robin Persona-Speaker-Selection
- Tool Calls innerhalb Room-Zyklen ueber `executeRoomTool(...)`
- Model-Fallback via Model-Hub Dispatch

---

## 3. API-Referenz (Aktiv)

### 3.1 Room Orchestration API

| Methode | Pfad                       | Zweck                        |
| ------- | -------------------------- | ---------------------------- |
| POST    | `/api/rooms/[id]/start`    | Room-Run starten             |
| POST    | `/api/rooms/[id]/stop`     | Room-Run stoppen             |
| GET     | `/api/rooms/[id]/state`    | Room-Run-Status lesen        |
| GET     | `/api/rooms/[id]/messages` | Ergebnis-/Dialogverlauf      |
| POST    | `/api/rooms/[id]/messages` | User-Input an Orchestrierung |

### 3.2 Monitoring/Ops API

| Methode | Pfad              | Zweck                                                        |
| ------- | ----------------- | ------------------------------------------------------------ |
| GET     | `/api/ops/agents` | Persona-Aktivitaet + laufende Room-Snapshots                 |
| GET     | `/api/ops/nodes`  | Health/Doctor/Channels/Automation/Exec-Approvals/Room-Metrik |

---

## 4. Statusmodelle (Aktiver Code)

Aus `src/server/rooms/types.ts`:

### 4.1 Room Run State

- `stopped`
- `running`
- `degraded`

### 4.2 Member Runtime Status

- `idle`
- `busy`
- `interrupting`
- `interrupted`
- `error`
- `paused`

---

## 5. Legacy-Hinweis

Folgende frueheren Worker-Orchestra-Pfade sind nicht aktiv:

- (Legacy, entfernt) `/api/worker/orchestra/flows`
- (Legacy, entfernt) `/api/worker/orchestra/flows/[id]`
- (Legacy, entfernt) `/api/worker/orchestra/flows/[id]/publish`
- (Legacy, entfernt) `/api/worker/[id]/workflow`
- `src/server/worker/orchestra*.ts`

Historische Details liegen in archivierten oder alten Plan-Dokumenten.

---

## 6. Verifikation

```bash
rg --files app/api | rg "rooms|ops|worker/orchestra"
rg --files src/server/rooms
npm run typecheck
npm run lint
```

---

## 7. Siehe auch

- `docs/WORKER_SYSTEM.md`
- `docs/PERSONA_ROOMS_SYSTEM.md`
- `docs/SESSION_MANAGEMENT.md`
