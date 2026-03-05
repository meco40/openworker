# Ops Observability System

## Metadata

- Purpose: Verbindliche Referenz fuer operative Steuerung, Diagnose und Observability-APIs.
- Scope: Ops-Endpunkte, Config-API, Health/Doctor, Control-Plane-Metriken, Logs, Stats, Master-Metriken.
- Source of Truth: This is the active system documentation for this domain and overrides archived documents on conflicts.
- Last Reviewed: 2026-03-05
- Related Runbooks: docs/runbooks/gateway-config-production-rollout.md, docs/runbooks/chat-cli-smoke-approval.md

---

## 1. Aktueller IST-Zustand

Der operative Runtime-Zugriff erfolgt ueber `ops`, `config`, `health`, `doctor`, `control-plane`, `logs` und `stats`.

- Kein aktiver Worker-Runtime-API-Stack unter `/api/worker/*`
- Operative Mutationen laufen ueber `POST /api/ops/nodes`
- Diagnostik und Monitoring sind read-first mit expliziten Auth-Checks

## 2. API-Flaechen

### 2.1 Config

| Methode | Pfad          | Zweck                                                          |
| ------- | ------------- | -------------------------------------------------------------- |
| GET     | `/api/config` | Gateway-Config laden (redacted + revision + warnings)          |
| PUT     | `/api/config` | Gateway-Config speichern (optimistische Revision erforderlich) |

Quellen: `app/api/config/route.ts`, `src/server/config/gatewayConfig.ts`

### 2.2 Ops

| Methode | Pfad                 | Zweck                                                                        |
| ------- | -------------------- | ---------------------------------------------------------------------------- |
| GET     | `/api/ops/nodes`     | Health, Doctor, Channels, Personas, Automation, Exec-Approvals               |
| POST    | `/api/ops/nodes`     | Operative Aktionen (z. B. `exec.approve`, Pairing, Binding, Secret-Rotation) |
| GET     | `/api/ops/sessions`  | Sessionsuche/-filterung (q, activeMinutes, includeUnknown, includeGlobal)    |
| GET     | `/api/ops/instances` | WebSocket-Connection-Instanzen pro User + global                             |

Quellen: `app/api/ops/*`, `src/modules/ops/types.ts`

### 2.3 Health und Diagnose

| Methode | Pfad                    | Zweck                                                               |
| ------- | ----------------------- | ------------------------------------------------------------------- |
| GET     | `/api/health`           | Laufzeit-Healthreport (`runHealthCommand`)                          |
| GET     | `/api/health/scheduler` | Scheduler-Heartbeat-Health via Lease (`automation_scheduler_lease`) |
| GET     | `/api/doctor`           | Diagnostikreport (`runDoctorCommand`)                               |

Quellen: `app/api/health/route.ts`, `app/api/health/scheduler/route.ts`, `app/api/doctor/route.ts`

### 2.4 Control Plane Metrics

| Methode | Pfad                         | Zweck                                                                    |
| ------- | ---------------------------- | ------------------------------------------------------------------------ |
| GET     | `/api/control-plane/metrics` | Aggregierte Runtime-Metriken (WS, Tokens, Memory, Automation, Knowledge) |

Quelle: `app/api/control-plane/metrics/route.ts`

### 2.5 Logs

| Methode | Pfad               | Zweck                                                                                     |
| ------- | ------------------ | ----------------------------------------------------------------------------------------- |
| GET     | `/api/logs`        | Historische Logs mit Filtern (`level`, `source`, `category`, `search`, `before`, `limit`) |
| DELETE  | `/api/logs`        | Logs loeschen                                                                             |
| POST    | `/api/logs/ingest` | Clientseitiges Event als Log persistieren (`type`, `message`)                             |

Quellen: `app/api/logs/route.ts`, `app/api/logs/ingest/route.ts`

### 2.6 Stats

| Methode | Pfad                     | Zweck                                          |
| ------- | ------------------------ | ---------------------------------------------- |
| GET     | `/api/stats/engineering` | Engineering-KPIs (7/30 Tage, Harness-Delivery) |
| GET     | `/api/stats`             | Token-Nutzung, Uptime, optional Session-Lens   |
| GET     | `/api/stats/prompt-logs` | Prompt-Dispatch-Logs, Summary, Diagnostics     |
| DELETE  | `/api/stats/prompt-logs` | Prompt-Logs + Token-Usage zuruecksetzen        |

Quellen: `app/api/stats/engineering/route.ts`, `app/api/stats/route.ts`, `app/api/stats/prompt-logs/route.ts`

`/api/stats/engineering` liefert fuer Harness-v4 additiv:

- Snapshot-Quelle und Frische: `source`, `snapshotAgeHours`, `isFallback`
- Rollout-Zustand: `rollout.phase`, `rollout.exitGates`, `rollout.recommendation`, `rollout.baselineId`
- Harness-Observability: `domainCoverage`, `scenarioSuccessRates`, `worktreeHarness`, `criticalFailAutoReverts`

### 2.7 Mission Control Rollout Dashboard

| Typ | Pfad                                   | Zweck                                                             |
| --- | -------------------------------------- | ----------------------------------------------------------------- |
| UI  | `/mission-control/engineering-rollout` | Kompakte Live-Sicht fuer Woche-1-4-Gates, KPI-Status und Go/No-Go |

Quellen: `app/mission-control/engineering-rollout/page.tsx`, `src/components/stats/EngineeringRolloutDashboard.tsx`

### 2.8 Master Metrics

| Methode | Pfad                  | Zweck                                                   |
| ------- | --------------------- | ------------------------------------------------------- |
| GET     | `/api/master/metrics` | Master-Agent-Metriken (Runs, Delegations, Capabilities) |

Metriken-Details:

- `totalRuns`: Alle Runs insgesamt
- `activeRuns`: Aktuell laufende Runs
- `completedRuns`: Erfolgreich abgeschlossene Runs
- `failedRuns`: Fehlgeschlagene Runs
- `pendingApprovals`: Ausstehende Approval-Entscheidungen
- `totalDelegations`: Alle Delegations an Subagenten
- `capabilitiesByType`: Capabilities nach Typ gruppiert
- `learningLoopStatus`: Status des Learning-Loops (naechster Run, letzte Ausfuehrung)

Quelle: `app/api/master/metrics/route.ts`, `src/server/master/metrics.ts`

## 3. Auth und Zugriff

Die oben genannten Endpunkte sind ueber `withUserContext(...)` oder `withResolvedUserContext(...)` abgesichert und liefern bei fehlendem Kontext `401` (bzw. optionalen Kontext, wo fachlich vorgesehen).

- Resolver: `src/server/auth/userContext.ts`
- Route-Wrapper: `app/api/_shared/withUserContext.ts`
- Standard-Unauthorized-Response: `src/server/http/unauthorized.ts`

`/api/ops/sessions` beachtet zusaetzlich `includeGlobalApplied` nur fuer nicht-authentisierte Kontexte.

### 3.1 Internal Ingest (Engineering Snapshots)

- Internal Route: `POST /api/internal/stats/engineering/snapshots`
- Route ist token-geschuetzt und nur aktiv mit `ENGINEERING_INGEST_ENABLED=1`.
- Benoetigte Header:
  - `x-engineering-ingest-token`
  - `x-engineering-ingest-timestamp`
  - `x-engineering-ingest-idempotency-key`
- Workflow-seitig benoetigt:
  - Secret `ENGINEERING_INGEST_URL`
  - Secret `ENGINEERING_INGEST_TOKEN`

## 4. Verifikation

```bash
rg --files app/api | rg "ops|config|health|doctor|control-plane|logs|stats"
rg -n "withUserContext|withResolvedUserContext" app/api/ops app/api/config app/api/health app/api/doctor app/api/control-plane app/api/logs app/api/stats
npm run typecheck
npm run lint
```

## 5. Siehe auch

- `docs/WORKER_SYSTEM.md` (Legacy)
- `docs/MASTER_AGENT_SYSTEM.md` - Master Agent Metriken und Runtime
- `docs/OMNICHANNEL_GATEWAY_SYSTEM.md`
- `docs/DEPLOYMENT_OPERATIONS.md`
- `docs/API_REFERENCE.md`
- `docs/TASKS_SYSTEM.md` - Task-Management und Workspace-Artifakte
