# World Model Rollout

> Stand: 2026-08-20 · Repo: `e:\web\clawtest`

## Zweck

PostgreSQL/pgvector ist die kanonische Weltmodell- und Memory-Schicht.
`world_model_memory_items` und seine Historie ersetzen Mem0 als
Anwendungssystem of Record. SQLite-Knowledge, Mem0 und Graphiti bleiben
wiederaufbaubare Projektionen bzw. explizite Kompatibilitätspfade.

## Bestandteile

| Datei                                                                  | Inhalt                                                                                                                                                                              |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/world-model/config.ts`                                     | Env-Konfiguration, `WORLD_MODEL_ENABLED` (default off)                                                                                                                              |
| `src/server/world-model/db.ts`                                         | Lazy-`pg.Pool`-Singleton, Advisory-Lock-Migrations-Runner und Transaktions-Helper                                                                                                   |
| `src/server/world-model/migrations/001_world_model.sql`                | Basisschema (Observations, Assertions bitemporal+Modalitaet, Events/Transitions, Tasks/Transitions, Entities/Relations, Open Loops, Standing Intents, Outbox, Embeddings, Volltext) |
| `src/server/world-model/migrations/016_canonical_memory.sql`           | Kanonische Memory-Items, Historie, RLS, Idempotenz, Soft Delete und aggregierter Count                                                                                              |
| `src/server/world-model/migrations/017_canonical_memory_integrity.sql` | Lifecycle-Constraint und Source-Observation-Index                                                                                                                                   |
| `src/server/world-model/migrations/002..004*.sql`                      | Shadow-Ledger, scoped Outbox-/Idempotenz-Nachruestung und workspace-scoped Assertions                                                                                               |
| `src/server/world-model/repositories/*`                                | Repositories pro Aggregat (roh-SQL, Transaktion via Client)                                                                                                                         |
| `src/server/world-model/services/eventService.ts`                      | Plan-/Aenderungs-Referenzfall (Kino/Essen)                                                                                                                                          |
| `src/server/world-model/services/prospectiveEngine.ts`                 | Open-Loop-Follow-ups, Standing-Intent-Matching, Heartbeat                                                                                                                           |
| `src/server/world-model/outboxDispatcher.ts`                           | Transactional-Outbox-Dispatch                                                                                                                                                       |
| `src/server/world-model/productionGuard.ts`                            | Prod-Guard (Canonical URL erforderlich, E2E in Prod verboten)                                                                                                                       |
| `docker-compose.postgres.yml`                                          | Kanonische `pgvector/pgvector:pg17`, Port 5434, DB `clawtest`                                                                                                                       |
| `.env.local.example`                                                   | `WORLD_MODEL_*`-Block                                                                                                                                                               |

## Aktivierung (lokal)

```powershell
docker compose -f docker-compose.postgres.yml up -d
# .env.local:
#   MEMORY_PROVIDER=postgres
#   WORLD_MODEL_ENABLED=true
#   WORLD_MODEL_MODE=canonical
#   CANONICAL_DATABASE_URL=postgresql://clawtest:clawtest@127.0.0.1:5434/clawtest
corepack pnpm run dev:scheduler
```

Der Scheduler ruft `startOutboxDispatcher()` auf, fuehrt Migrationen aus und
pollt die Outbox. Bei `WORLD_MODEL_ENABLED=false` startet der Dispatcher nicht.
Outbox-Events werden mit `FOR UPDATE SKIP LOCKED` geclaimt, geleast und mit
Backoff erneut versucht; Handler müssen deshalb idempotent sein.

## Integrationstest (optional, live PostgreSQL)

```powershell
$env:WORLD_MODEL_E2E='true' # nur lokal/CI, niemals NODE_ENV=production
corepack pnpm exec vitest run tests/integration/world-model
```

Der Kino/Essen-Referenzfall (`event-flow.test.ts`) prueft, dass ein abgesagter
Plan nicht mit einem unbestätigten neuen Plan verschmilzt und ein Event erst
durch explizite Bestaetigung `completed` wird.

## Unit-Tests (ohne DB)

```powershell
corepack pnpm exec vitest run tests/unit/world-model
```

## Abgrenzung

- Durable Workflows (pg-boss/Hatchet/Temporal) sind nicht erforderlich für die
  kanonische Memory-/World-Model-Funktion und bleiben separat.
- Graphiti ist als abgeleitete REST-/Neo4j-Projektion lokal angebunden. Die
  Projektion kann live aktiviert werden; Recall bleibt bis zum Qualitäts-Gate
  (`GRAPHITI_RECALL_ENABLED=false`) bewusst deaktiviert.

## Phase 2+3 (2026-08-19): Schreibpfade + Retrieval

- Der Live-Inbound- und -Outboundpfad ruft nach dem SQLite-Commit
  `bridgeStoredChatMessage()` auf. Die persistierte Nachrichten-ID wird als
  stabile `sourceId` verwendet; Backfill und `world-model:rekey-chat-sources`
  nutzen dieselbe Identität. Der Legacy-Knowledge-Window-Pfad bleibt als
  kompatibler, fail-soft Backfill-/Batchpfad bestehen.
- `WORLD_MODEL_DISPATCH_SCOPES` kann zusätzliche scheduler-only Scopes
  enthalten. Für Chat-Scopes entdeckt der Dispatcher die Scopes aus SQLite und
  führt jeden Outbox-Batch unter dem passenden RLS-Kontext aus.
- Phase 3: `retrieveContext()` (world-model/retrieval/) priorisiert strukturierte
  Zustandsabfragen -> PG-Volltext -> pgvector (spaeter). Strukturierte Wahrheit hat
  Vorrang vor semantischer Aehnlichkeit.

## Graphiti-Projektion und Recall-Gate

- `GRAPHITI_PROJECTOR_ENABLED=true` registriert den Live-Projektor am
  transactional Outbox; PostgreSQL bleibt auch dann die Quelle der Wahrheit.
- `GRAPHITI_SHADOW_ENABLED=true` aktiviert zusätzlich das lokale Shadow-Ledger
  für Drift-/Transportmessung.
- `GRAPHITI_RECALL_ENABLED=true` ist ein separater Schalter. Er darf erst nach
  `world-model:graphiti-evaluate -- --require-quality` aktiviert werden. Die
  Runtime verwendet denselben lokalen Reranker und Relevanzfilter wie der
  Evaluator und fällt bei Graphiti-Fehlern auf PostgreSQL zurück.
- Im kanonischen PostgreSQL-Modus ist Mem0 nicht für Runtime-CRUD oder Recall
  erforderlich. `WORLD_MODEL_MEM0_PREFERENCES_ONLY=true` bleibt nur für einen
  ausdrücklich aktivierten Mem0-Legacy-Provider relevant.

## Kanonische Memory-Migration

Mem0-Daten werden vor dem Abschalten des Legacy-Containers über den
idempotenten Backfill importiert:

```powershell
pnpm run memory:migrate-to-postgres -- --scope all --apply --output docs/audits/world-model/memory-migration-current.json
pnpm run memory:migrate-to-postgres -- --scope all --output docs/audits/world-model/memory-migration-verify.json
```

Der Bericht weist die bekannten Scopes, Quellmenge, importierte Datensätze und
Fehler aus. Der lokale Mem0-Container bietet für einen providerweiten
Factual-Audit zusätzlich `GET /admin/memories`; externe Mem0-Provider ohne
diesen Endpoint bleiben ausdrücklich scope-begrenzt. Erst wenn der Verify-Lauf
ohne Fehler ist, der providerweite Audit (falls verfügbar) abgeschlossen ist
und `MEMORY_PROVIDER=postgres` aktiv ist, darf Mem0 aus dem Normalbetrieb
entfernt werden.

## Phase 7-9 (2026-08-18): Proaktive Sekretärin

Die proaktive Zustellung ist über Outbox-Events und Services umgesetzt und im
Scheduler verdrahtet. Der Modus wird über `WORLD_MODEL_MODE`
(`off | shadow | required | canonical`) gesteuert; die Legacy-Booleans bleiben
während der Migration kompatibel.

### Neue Bestandteile

| Datei                                                           | Inhalt                                                                                        |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------ | -------- | ---------------------------------- |
| `src/server/world-model/mode.ts`                                | Rollout-Modi `off                                                                             | shadow | required | canonical` + Legacy-Flag-Ableitung |
| `src/server/world-model/services/followUpPolicy.ts`             | Reine Zustell-Policy für Open Loops (Status, Attempts, Ruhezeiten, Budget, Kanal, Aktivitaet) |
| `src/server/world-model/services/openLoopService.ts`            | `deliverDueOpenLoops`, atomare Outbox-Enqueue, `resolveOpenLoopAsAnswered`                    |
| `src/server/world-model/services/standingIntentCompiler.ts`     | NL -> validierter Standing Intent (Template `Wenn X antwortet`)                               |
| `src/server/world-model/services/standingIntentDispatcher.ts`   | Match -> idempotente Folgeaktion (`proactive.intent.fired`)                                   |
| `src/server/world-model/runtime/heartbeatRuntime.ts`            | Reconciliation-Herzschlag (overdue Open Loops)                                                |
| `src/server/world-model/runtime/prospectiveRuntime.ts`          | Scheduler-Takt: Zustellung + Heartbeat                                                        |
| `src/server/world-model/services/notificationPolicy.ts`         | Kanalübergreifende Benachrichtigungspolitik (Ruhezeiten, Budget, Kanalpraeferenz)             |
| `src/server/world-model/services/responseCorrelationService.ts` | Antwort -> Kandidat (Kanal/Konversation/Zeitfenster)                                          |
| `src/server/world-model/services/clarificationService.ts`       | Rueckfrage bei Mehrdeutigkeit statt stiller Zuordnung                                         |

### Verhalten

- Der Scheduler nimmt `WORLD_MODEL_PROSPECTIVE_INTERVAL_MS` (Default 60000) als
  Takt für `runProspectiveRuntimeOnce()` auf. Der Takt ist `unref()`-ed und
  wird beim Shutdown gestoppt.
- `outboxDispatcher` registriert den `proactive.intent.fired`-Handler, damit
  gefeuerte Standing-Intents als Aktion bestätigt werden.
- Env-Variablen `WORLD_MODEL_MODE`, `WORLD_MODEL_PROSPECTIVE_INTERVAL_MS` und
  `WORLD_MODEL_USER_ACTIVE_WINDOW_MS` sind in `.env.local.example` dokumentiert.

### Absicherung

- `Scheduler-Neustart`: Open-Loop-Zustellung läuft über Lease (`SKIP LOCKED`) +
  Outbox; `asked` wird erst nach bestaetigter Zustellung gesetzt. Kein
  Doppelversand bei erneutem Tick.
- `Standing Intent`: `matchStandingIntents` stösst beim Match eine idempotente
  Folgeaktion über die Outbox an; `fire_count` wird in derselben Transaktion
  erhöht. Replay derselben Observation feuert nicht doppelt.
- `Mehrdeutigkeit`: `correlateUserResponse` verlangt ein deterministisches
  Kanal-/Konversations-Signal; bei mehreren Kandidaten erzeugt
  `buildClarificationPrompt` eine Rueckfrage.

### Env-Schnellstart

```powershell
# .env.local
WORLD_MODEL_ENABLED=true
WORLD_MODEL_MODE=shadow
WORLD_MODEL_PROSPECTIVE_INTERVAL_MS=60000
```

## Rebuild-, Reconcile- und Betriebsnachweise

Live-Rebuilds werden immer scoped ausgeführt, damit RLS keinen unscoped Lauf
fälschlich als Erfolg erscheinen lässt:

```powershell
pnpm run world-model:reconcile -- --scope all --output docs/audits/world-model/reconcile-current-all-final.json
pnpm run world-model:rebuild-projections -- --type embeddings --scope <user:persona:workspace> --batch-size 25
pnpm run world-model:rebuild-projections -- --type graphiti --scope <user:persona:workspace> --batch-size 25
pnpm run world-model:graphiti-evaluate -- --scope all --output docs/audits/world-model/graphiti-recall-drift-current.json
```

Der Reconcile-Lauf verwendet einen Source-Snapshot. Der Graphiti-Rebuild ist
transportseitig wiederaufbaubar, aber Graphiti-Recall bleibt Shadow, bis der
separate Recall-/Precision-Report die Schwellenwerte erfüllt. Der Embedding-
Worker läuft im Scheduler pro entdecktem Runtime-Scope und verarbeitet die
kanonischen Zieltypen fair. Export/Restore des kanonischen Scopes ist lokal
manifest-gehasht; externe Provider müssen ihren eigenen Lösch-/Restore-
Nachweis liefern.
