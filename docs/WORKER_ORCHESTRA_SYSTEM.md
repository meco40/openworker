# Worker Orchestra System (Legacy)

> **Status:** ⚠️ **ARCHIV-REIF** - Dieses Dokument beschreibt entfernte Legacy-Systeme. Zur Aufbewahrung historischer Kontexte belassen, jedoch nicht mehr als aktive Referenz verwenden.
>
> **Empfohlene Nachfolger:** `docs/AUTOMATION_SYSTEM.md`, `docs/MASTER_AGENT_SYSTEM.md`

## Metadata

- Purpose: Historische Referenz zur Worker-Orchestra-Funktion (entfernt 2026-02).
- Scope: Dokumentiert entfernte Orchestra-API und aktive Nachfolger.
- Source of Truth: **ARCHIVED** - Dieses System ist nicht mehr in der Runtime vorhanden. Siehe Nachfolger oben.
- Last Reviewed: 2026-03-03 (als Legacy markiert)
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
