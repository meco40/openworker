# World Model Agent Contract

Stand: 2026-08-19

## Metadata

- Last Reviewed: 2026-08-19

## Zweck

Dieser Vertrag beschreibt das kanonische World Model als System of Record fuer
strukturierte Wahrheit und proaktives Verhalten der persoenlichen 24-Stunden-
Sekretaerin. Er definiert Zuständigkeiten, Invarianten und Eigentümerschaft
zwischen Raw Messages, World Model, Mission Control, SQLite Knowledge, Mem0 und
Graphiti. Er ist Teil der Zielarchitektur
(`docs/memory-knowledge-target-architecture.md`) und wird durch die Services
im Verzeichnis `src/server/world-model/` implementiert.

## Unverhandelbare Invarianten

| Invariante    | Verbindliche Regel                                                                |
| ------------- | --------------------------------------------------------------------------------- |
| Wahrheit      | Strukturierter Zustand wird ausschliesslich ueber World-Model-Services veraendert |
| Historie      | Korrekturen schliessen alte Gueltigkeit; sie loeschen keine Evidenz               |
| Zeit          | `valid_*` beschreibt die Welt, `known_*` den Wissensstand des Systems             |
| Scope         | Jeder Zugriff verwendet `user_id + persona_id + workspace_id`                     |
| Provenienz    | Jede Behauptung und Transition verweist auf mindestens eine Observation           |
| Idempotenz    | Replay derselben Quelle erzeugt keine Duplikate und keine zweite Aktion           |
| Aktionen      | `completed` oder `sent` erfordert ein reales Tool- oder Nutzerergebnis            |
| Retrieval     | Strukturierte aktive Wahrheit schlaegt semantische Aehnlichkeit                   |
| Projektionen  | Mem0, Graphiti und Embeddings sind vollstaendig neu aufbaubar                     |
| Proaktivitaet | Kein Versand ohne erneute Zustaende-, Ruhezeiten- und Budgetpruefung              |

## Eigentümer (Single Writer pro Domäne)

| Domaene                   | Autoritativer Service                      |
| ------------------------- | ------------------------------------------ |
| Observations              | `ObservationService`                       |
| Assertions                | `AssertionService`                         |
| Events                    | `EventService`                             |
| Entities und Relations    | `EntityService`                            |
| Tasks und Action Attempts | `CanonicalTaskService` und `ActionService` |
| Open Loops                | `OpenLoopService`                          |
| Standing Intents          | `StandingIntentService`                    |

Repositories duerfen keine fachlichen Statusuebergaenge nachbilden. API-Routen,
Knowledge-Ingestion, Tool-Runner und Scheduler verwenden dieselben Services.

## API- und Migrationsmatrix

Bestehende öffentliche Schnittstellen bleiben kompatibel. Neue kanonische
Zustände werden gespiegelt, bis der jeweilige Scope den Cutover-Gates genügt.

| Bestehender Pfad                       | Kanonische Verdrahtung                                                 | Übergangsregel                                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Eingehende Channel-Nachricht           | `handleInbound` → Knowledge-Ingestion → `ObservationService`/Projector | Raw Message bleibt erhalten; SQLite/Mem0 sind abgeleitete Projektionen bzw. Pending-Retry                                 |
| `POST /api/tasks` und Task-Statusroute | Mission-Control-Task-Mirror → `CanonicalTaskService`                   | Bestehende Task-API bleibt unverändert; Statusübergänge erzeugen scoped Outbox-/Transition-Evidenz                        |
| Master-Tool-Ausführung                 | `masterActionBridge`/`ActionService`                                   | Attempt und Receipt werden vor `succeeded` persistiert; externe Provider-ID bleibt optional, bis der Provider sie liefert |
| Scheduler/Open Loops                   | Lease → `proactive.question.requested` → Delivery Receipt              | `asked` erst nach bestätigter Zustellung; fehlende Kanalbindung bleibt sichtbar fehlgeschlagen                            |
| Knowledge-/Memory-Recall               | `retrieveContext` mit World-Model-Priorität                            | Legacy-Recall bleibt als Kompatibilitätspfad aktiv, bis Canonical-Parität und Audit nachgewiesen sind                     |
| Automation API                         | Bestehende Automation- und Run-Verträge                                | Keine stille Statusumstellung; Migration erfolgt über dokumentierte Outbox-/Task-Projektion                               |

## Rollout-Modi

`WORLD_MODEL_MODE` ist einer von `off | shadow | required | canonical`.

| Modus       | Verhalten                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------ |
| `off`       | Alter Pfad, World Model nicht beteiligt                                                    |
| `shadow`    | World Model wird fail-soft befuellt; Abweichungen werden gemessen                          |
| `required`  | Observation und kanonische Projektion muessen erfolgreich sein; alte Stores bleiben lesbar |
| `canonical` | PostgreSQL ist verbindlich; alte Stores werden ausschliesslich aus der Outbox projiziert   |

## Runtime-Credentials

Web/API und Scheduler verwenden getrennte PostgreSQL-URLs. `WORLD_MODEL_RUNTIME_ROLE=app`
wählt `WORLD_MODEL_APP_DATABASE_URL`; `WORLD_MODEL_RUNTIME_ROLE=worker` wählt
`WORLD_MODEL_WORKER_DATABASE_URL`. Diese URLs sollen auf die in Migration 006
angelegten Rollen `world_model_app` bzw. `world_model_worker` zeigen. Die bisherige
`CANONICAL_DATABASE_URL` bleibt ein lokaler Entwicklungs-/Migrationsfallback.

## Proaktive Zustellung (Phasen 7-9)

- Fällige Open Loops werden ueber `deliverDueOpenLoops` nach der Policy in
  `followUpPolicy.ts` geprueft (Ruhezeiten, Budget, Kanal, Nutzer-Aktivitaet).
- Die Zustellung passiert atomar als `proactive.question.requested`-Outbox-
  Event; `asked` wird erst nach bestaetigter Zustellung gesetzt.
- Standing Intents werden durch `matchStandingIntents` (prospectiveEngine)
  ausgewertet; ein Match stösst idempotent eine Folgeaktion ueber
  `dispatchStandingIntentAction` an (Outbox-Event `proactive.intent.fired`).
- Der Scheduler startet einen Prospective Runtime Takt, der die Zustellung und
  Heartbeat-Reconciliation anstösst (`runProspectiveRuntimeOnce`).
- Nutzerantworten werden ueber `correlateUserResponse` dem passenden Open
  Loop / Event / Task / Intent zugeordnet; bei Mehrdeutigkeit erzeugt
  `buildClarificationPrompt` eine Rueckfrage statt einer stillen Zuordnung.
- Kanaluebergreifende Benachrichtigungspolitik: `decideNotification`
  (Ruhezeiten, Tagesbudget, Kanalpraeferenz).

## Abnahmekriterien (Teilmenge)

- `Scheduler-Neustart` fuehrt weder zum Verlust noch zum Doppelversand einer
  Rueckfrage (Lease + Outbox + `asked` nach bestaetigter Zustellung).
- `Mike antwortet` loest genau eine Folgeaktion aus; derselbe eingehende
  Webhook kann beliebig oft replayt werden, ohne mehrfach zu feuern.
- Abgesagte Termine loesen keine Ergebnisfrage aus.
- Mehrdeutige Antworten veraendern keinen Weltzustand ohne Klärung.
- Notification Budget und Ruhezeiten gelten kanaluebergreifend.
