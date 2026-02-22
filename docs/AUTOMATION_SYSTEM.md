# Automation System

## Metadata

- Purpose: Verbindliche Referenz fuer zeitgesteuerte Automations im System.
- Scope: Cron-Regeln, Scheduler-Lease, Run-Queue, Retry/Dead-Letter, Triggerquellen.
- Source of Truth: This is the active system documentation for this domain and overrides archived documents on conflicts.
- Last Reviewed: 2026-02-22
- Related Runbooks: N/A

---

## 1. Funktionserläuterung

Das Automation-System plant und führt Cron-basierte Regeln aus. Ausführungen werden als Runs persistiert, mit Retry/Dead-Letter abgesichert und über Lease-Mechanik singleton-fähig betrieben.

### Kernkonzepte

- **Automation Rule**: Zeitgesteuerte Regel (`cronExpression`, `timezone`, `prompt`)
- **Flow Graph**: Visuelles Rule-Modell (`flowGraph`) zur strukturierten Rule-Bearbeitung
- **Run**: Einzelne Ausführung mit Status (`queued`, `running`, `succeeded`, ...)
- **Trigger Source**: `cron` oder `manual`
- **Lease**: Scheduler-Singleton für Tick-Verarbeitung
- **Backoff/Retry**: Wiederholungen mit Dead-Letter-Übergang

---

## 2. Architektur

### 2.1 Komponenten

- `src/server/automation/types.ts`
- `src/server/automation/service.ts`
- `src/server/automation/runtime.ts`
- `src/server/automation/sqliteAutomationRepository.ts`
- `src/server/automation/flowTypes.ts`
- `src/server/automation/flowValidator.ts`
- `src/server/automation/flowCompiler.ts`
- `src/server/automation/cronEngine.ts`
- `src/server/automation/executor.ts`
- `src/server/automation/httpAuth.ts`
- `app/api/automations/*`
- `scheduler.ts`

### 2.2 Scheduler-Verhalten

Pro Tick werden fällige Rules enqueued und queued Runs verarbeitet. Bei Fehlern greift Retry-Backoff; nach maximalen Versuchen wandert der Run in `dead_letter`.

---

## 3. API-Referenz

| Methode | Pfad                         | Zweck                                          |
| ------- | ---------------------------- | ---------------------------------------------- |
| GET     | `/api/automations`           | Rules listen                                   |
| POST    | `/api/automations`           | Rule erstellen                                 |
| GET     | `/api/automations/[id]`      | Rule laden                                     |
| PATCH   | `/api/automations/[id]`      | Rule aktualisieren                             |
| DELETE  | `/api/automations/[id]`      | Rule löschen                                   |
| GET     | `/api/automations/[id]/flow` | `flowGraph` einer Rule laden                   |
| PUT     | `/api/automations/[id]/flow` | `flowGraph` validieren, kompilieren, speichern |
| POST    | `/api/automations/[id]/run`  | Manuellen Run erzeugen                         |
| GET     | `/api/automations/[id]/runs` | Runs zu Rule laden                             |
| GET     | `/api/automations/metrics`   | Scheduler-Metriken und Lease-Status abrufen    |

### 3.1 Flow-Builder Integration

- `flowGraph` wird als Teil der Rule persistiert.
- Beim Speichern (`PUT /api/automations/[id]/flow`) wird serverseitig validiert und in bestehende Rule-Felder kompiliert.
- Die Runtime bleibt unveraendert cron-/rule-basiert; der Flow-Builder ist eine Authoring-Schicht.

---

## 4. Scheduler-Konfiguration

| Variable                      | Standard      | Beschreibung                 |
| ----------------------------- | ------------- | ---------------------------- |
| `SCHEDULER_INSTANCE_ID`       | `scheduler-1` | Eindeutige Scheduler-Instanz |
| `AUTOMATION_TICK_INTERVAL_MS` | `15000`       | Tick-Intervall               |
| `AUTOMATION_LEASE_TTL_MS`     | `30000`       | Lease-TTL                    |

---

## 5. Verifikation

```bash
npm run dev:scheduler
npm run test -- tests/unit/automation
npm run test -- tests/integration/automation
npm run typecheck
npm run lint
```

---

## 6. Siehe auch

- `docs/WORKER_SYSTEM.md`
- `docs/API_REFERENCE.md`
- `docs/DEPLOYMENT_OPERATIONS.md`
