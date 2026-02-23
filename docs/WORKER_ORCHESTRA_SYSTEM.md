# Worker Orchestra System

## Metadata

- Purpose: Verbindliche Referenz zum aktuellen Status der frueheren Worker-Orchestra-Funktion.
- Scope: Legacy-Status, aktive Nachfolger fuer Flow-Definition und Runtime-Ausfuehrung.
- Source of Truth: This is the active system documentation for this domain and overrides archived documents on conflicts.
- Last Reviewed: 2026-02-23
- Related Runbooks: docs/runbooks/gateway-config-production-rollout.md

---

## 1. Aktueller Status

Die fruehere Worker-Orchestra-API (`/api/worker/orchestra/*`) ist entfernt.
Es gibt keine aktive Rooms-Orchestrierung mehr in `src/server/rooms/*`.

Historische Detailsaetze liegen im Archiv unter `docs/archive/`.

---

## 2. Aktive Nachfolger

### 2.1 Flow-Definitionen fuer Automations

- `GET|PUT /api/automations/[id]/flow`
- Datenmodell und Validierung in:
  - `src/server/automation/flowTypes.ts`
  - `src/server/automation/flowValidator.ts`
  - `src/server/automation/flowCompiler.ts`

### 2.2 Laufzeit-Ausfuehrung

- Scheduler/Runtime:
  - `src/server/automation/runtime.ts`
  - `src/server/automation/cronEngine.ts`
  - `src/server/automation/executor.ts`
- Operative Einsicht/Steuerung:
  - `GET|POST /api/ops/nodes`
  - `GET /api/ops/agents`

---

## 3. Legacy-Hinweis

Nicht mehr aktive Pfade:

- `/api/worker/orchestra/*`
- `/api/worker/[id]/workflow`
- `/api/rooms/*`
- `src/server/rooms/*`

---

## 4. Verifikation

```bash
rg --files app/api | rg "worker/orchestra|rooms"
rg --files src/server | rg "rooms"
rg --files app/api/automations
rg --files src/server/automation
npm run typecheck
npm run lint
```

---

## 5. Siehe auch

- `docs/WORKER_SYSTEM.md`
- `docs/AUTOMATION_SYSTEM.md`
- `docs/API_REFERENCE.md`
- `docs/PROJECT_WORKSPACE_SYSTEM.md`
