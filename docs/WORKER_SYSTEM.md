# Worker System (Legacy)

> **Status:** ⚠️ **ARCHIV-REIF** - Dieses Dokument beschreibt entfernte Legacy-Systeme. Zur Aufbewahrung historischer Kontexte belassen, jedoch nicht mehr als aktive Referenz verwenden.
>
> **Empfohlene Nachfolger:** `docs/AUTOMATION_SYSTEM.md`, `docs/MASTER_AGENT_SYSTEM.md`, `docs/OPS_OBSERVABILITY_SYSTEM.md`

## Metadata

- Purpose: Historische Referenz zum Worker-Status (entfernt 2026-02).
- Scope: Dokumentiert entfernte Worker-/Rooms-Runtimes und aktive Nachfolge-Pfade.
- Source of Truth: **ARCHIVED** - Dieses System ist nicht mehr in der Runtime vorhanden. Siehe Nachfolger oben.
- Last Reviewed: 2026-03-03 (als Legacy markiert)
- Related Runbooks: docs/runbooks/chat-cli-smoke-approval.md, docs/runbooks/gateway-config-production-rollout.md

---

## 1. Aktueller Status

Der fruehere dedizierte Worker-Stack (`/api/worker/*`) ist aus der aktiven Runtime entfernt.
Das gilt ebenso fuer das fruehere Rooms-Subsystem (`/api/rooms/*`, `src/server/rooms/*`).

Der aktuelle Policy-Snapshot bleibt:

- `runtime.mode = main-chat-only`
- `runtime.workerRemoved = true`

Quelle: `src/server/security/policyExplain.ts`

---

## 2. Aktive Nachfolger

### 2.1 Ops API (operative Steuerung)

- `GET /api/ops/nodes`
- `POST /api/ops/nodes`
- `GET /api/ops/sessions`
- `GET /api/ops/instances`

Quellen:

- `app/api/ops/nodes/route.ts`
- `app/api/ops/sessions/route.ts`
- `app/api/ops/instances/route.ts`

### 2.2 Automation API (geplante Ausfuehrung)

- `GET|POST /api/automations`
- `DELETE|GET|PATCH /api/automations/[id]`
- `GET|PUT /api/automations/[id]/flow`
- `POST /api/automations/[id]/run`
- `GET /api/automations/[id]/runs`
- `GET /api/automations/metrics`

Quellen:

- `app/api/automations/route.ts`
- `app/api/automations/[id]/route.ts`
- `app/api/automations/[id]/flow/route.ts`
- `app/api/automations/[id]/run/route.ts`
- `app/api/automations/[id]/runs/route.ts`
- `app/api/automations/metrics/route.ts`

### 2.3 Tool- und Subagent-Ausfuehrung im Chat-Runtime

- `src/server/channels/messages/service/index.ts`
- `src/server/channels/messages/service/toolManager.ts`
- `src/server/skills/executeSkill.ts`

---

## 3. Explizit entfernte Legacy-Pfade

- `/api/worker/*`
- `/api/worker/orchestra/*`
- `/api/rooms/*`
- `src/server/rooms/*`

---

## 4. Verifikation

```bash
rg --files app/api | rg "worker|rooms"
rg --files src/server | rg "rooms"
rg -n "runtime.mode|workerRemoved" src/server/security/policyExplain.ts
npm run typecheck
npm run lint
```

---

## 5. Siehe auch

- `docs/WORKER_ORCHESTRA_SYSTEM.md`
- `docs/AUTOMATION_SYSTEM.md`
- `docs/OMNICHANNEL_GATEWAY_SYSTEM.md`
- `docs/API_REFERENCE.md`
