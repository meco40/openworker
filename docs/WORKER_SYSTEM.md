# Worker System

## Metadata

- Purpose: Verbindliche Referenz zum aktuellen Status der Worker-Funktionalitaet und ihrer Nachfolger im Runtime-Stack.
- Scope: Ist-Zustand, entfernte Worker-Routen, ersetzende Ops-/Rooms-Mechanik, relevante Code-Module.
- Source of Truth: This is the active system documentation for this domain and overrides archived documents on conflicts.
- Last Reviewed: 2026-02-21
- Related Runbooks: docs/runbooks/chat-cli-smoke-approval.md, docs/runbooks/gateway-config-production-rollout.md

---

## 1. Aktueller Status

Der fruehere dedizierte Worker-Runtime-Stack (`/api/worker/*`) ist im aktuellen Code **nicht mehr aktiv**.

Der effektive Policy-Snapshot fuehrt das System im Modus:

- `runtime.mode = main-chat-only`
- `runtime.workerRemoved = true`

Quelle: `src/server/security/policyExplain.ts`

---

## 2. Was ersetzt den frueheren Worker-Stack

### 2.1 Operative Steuerung (Ops API)

Statt Worker-Task-Endpoints werden operativen Funktionen ueber `ops` bereitgestellt:

- `GET /api/ops/nodes` - Knoten-/Systemstatus, Channel-Zustaende, Automationsmetriken, Room-Metriken
- `POST /api/ops/nodes` - Steueraktionen (z. B. Pairing, Exec-Approval, Binding-Aktionen)
- `GET /api/ops/agents` - Persona- und laufende Room-Snapshots
- `GET /api/ops/sessions` - Sessionsuche/-filterung
- `GET /api/ops/instances` - Gateway-Verbindungsinstanzen

Quellen:

- `app/api/ops/nodes/route.ts`
- `app/api/ops/agents/route.ts`
- `app/api/ops/sessions/route.ts`
- `app/api/ops/instances/route.ts`

### 2.2 Laufende Orchestrierung (Rooms)

Fortlaufende agentische Multi-Persona-Ausfuehrung liegt in der Rooms-Orchestrierung:

- `src/server/rooms/orchestrator.ts`
- `src/server/rooms/service.ts`
- `src/server/rooms/runtime.ts`
- `src/server/rooms/repositories/*`

### 2.3 Tool-Ausfuehrung im Chat-Runtime

Tool-/Subagent-Flows laufen im aktiven Chat-Stack:

- Skill-Execution: `src/server/skills/executeSkill.ts`
- Skill-Registry: `src/server/skills/skillRepository.ts`
- Chat-Service inkl. Shell/Subagent-Routing: `src/server/channels/messages/service.ts`

---

## 3. API-Referenz (Aktive Worker-Nachfolger)

### 3.1 Ops

| Methode | Pfad                 | Zweck                                           |
| ------- | -------------------- | ----------------------------------------------- |
| GET     | `/api/ops/nodes`     | System-/Channel-/Automation-/Room-Metriken      |
| POST    | `/api/ops/nodes`     | Operative Mutationen (Pairing, Approvals, etc.) |
| GET     | `/api/ops/agents`    | Persona- und Run-Snapshots                      |
| GET     | `/api/ops/sessions`  | Session-Listing mit Filtern                     |
| GET     | `/api/ops/instances` | Gateway-Connection-Instanzen                    |

### 3.2 Rooms

| Methode | Pfad                                  | Zweck                         |
| ------- | ------------------------------------- | ----------------------------- |
| GET     | `/api/rooms`                          | Rooms listen                  |
| POST    | `/api/rooms`                          | Room erstellen                |
| GET     | `/api/rooms/[id]`                     | Room laden                    |
| DELETE  | `/api/rooms/[id]`                     | Room loeschen                 |
| POST    | `/api/rooms/[id]/start`               | Room-Ausfuehrung starten      |
| POST    | `/api/rooms/[id]/stop`                | Room-Ausfuehrung stoppen      |
| GET     | `/api/rooms/[id]/state`               | Laufzeitstatus lesen          |
| GET     | `/api/rooms/[id]/messages`            | Room-Nachrichten laden        |
| POST    | `/api/rooms/[id]/messages`            | User-Nachricht an Room senden |
| GET     | `/api/rooms/[id]/interventions`       | Interventionen lesen          |
| POST    | `/api/rooms/[id]/interventions`       | Intervention erstellen        |
| POST    | `/api/rooms/[id]/members`             | Persona-Member hinzufuegen    |
| PATCH   | `/api/rooms/[id]/members/[personaId]` | Member aktualisieren          |
| DELETE  | `/api/rooms/[id]/members/[personaId]` | Member entfernen              |
| GET     | `/api/rooms/membership-counts`        | Membership-Kennzahlen         |

---

## 4. Explizit entfernte Worker-Routen

Diese Endpoints sind im aktuellen `app/api`-Stand nicht vorhanden:

- (Legacy, entfernt) `/api/worker`
- (Legacy, entfernt) `/api/worker/[id]`
- (Legacy, entfernt) `/api/worker/[id]/planning`
- (Legacy, entfernt) `/api/worker/[id]/planning/answer`
- (Legacy, entfernt) `/api/worker/[id]/files`
- (Legacy, entfernt) `/api/worker/[id]/subagents`
- (Legacy, entfernt) `/api/worker/[id]/deliverables`
- (Legacy, entfernt) `/api/worker/[id]/workflow`
- (Legacy, entfernt) `/api/worker/orchestra/flows/*`
- (Legacy, entfernt) `/api/worker/settings`

---

## 5. Verifikation

```bash
rg --files app/api | rg "ops|rooms|worker"
rg -n "workerRemoved|main-chat-only" src/server/security/policyExplain.ts
npm run typecheck
npm run lint
```

---

## 6. Siehe auch

- `docs/WORKER_ORCHESTRA_SYSTEM.md`
- `docs/PERSONA_ROOMS_SYSTEM.md`
- `docs/OMNICHANNEL_GATEWAY_SYSTEM.md`
- `docs/API_REFERENCE.md`
