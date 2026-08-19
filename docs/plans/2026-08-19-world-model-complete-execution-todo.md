# World Model – evidenzbasierter Umsetzungs- und Restplan

Stand: 2026-08-20 Europe/Berlin · Quelle: `docs/plans/2026-08-18-world-model-complete-implementation-plan.md`

Diese Datei ist der aktuelle Abnahmestatus. Ein Häkchen bedeutet: Code und der
zugehörige Nachweis wurden tatsächlich geprüft. `[~]` bedeutet: der Baustein
ist technisch vorhanden oder teilweise live geprüft, aber die im ursprünglichen
Plan geforderte vollständige Betriebsabnahme fehlt. `[ ]` bedeutet: offen.

## Release-Urteil

Der kanonische PostgreSQL-Pfad, die World-Model-Projektionen, die echte lokale
Embedding-Pipeline und die fünf gezielten Failure-Drills sind implementiert und
lokal verifiziert. Eine vollständige Planfreigabe liegt trotzdem noch nicht vor.

Aktueller lokaler Betriebsstand:

- `WORLD_MODEL_MODE=canonical` ist in `.env.local` gesetzt.
- Graphiti läuft lokal erreichbar. Der historische Rebuild wurde für alle drei
  bekannten Runtime-Scopes im semantischen Standardmodus chunkweise
  angenommen; rohe Chat-Observations werden nur mit
  `--include-observations` projiziert. Der Dienst verarbeitet die Jobs
  asynchron. Die letzten Logs zeigen bei 15 Restjobs keinen belegten
  Queue-Abschluss sowie wiederholte Provider-Fehler wegen
  `Output length exceeded max tokens 8192`. `GRAPHITI_PROJECTOR_ENABLED=false`
  bleibt bis zum belastbaren Recall-Gate gesetzt.
- Der aktuelle Rebuild-/Recall-Nachweis liegt in
  `docs/audits/world-model/rebuild-current-*-graphiti-semantic.json` und
  `docs/audits/world-model/graphiti-recall-drift-current.json`. Transport und
  Erreichbarkeit sind belegt; die Recall-/Precision-Schwelle ist aktuell nicht
  bestanden, daher lautet die Empfehlung weiterhin `shadow`.
- Der nachgelagerte Dependency-Audit ist aktuell sauber: `pnpm audit --json`
  meldet 0 Advisories bei 746 Abhängigkeiten.
- Der Runtime-Evidence-Report ist ausdrücklich synthetische Marker-Evidenz und
  kein Produktionsdaten-Nachweis.
- Der Canonical-Cutover für externe Provider, echte Channel-E2E und einen
  vollständigen Graphiti-Recall ist nicht freigegeben.

## Phase 0 – Verträge und Szenarien

- [x] Agent-Contract, Domain-Registry, Szenario-Matrix und API-/Migrationsmatrix
      sind synchronisiert.
- [x] Neun Szenario-Fixtures und deterministische Semantiktests sind vorhanden.
- [~] Die Szenario-Integration läuft gegen den World-Model-/PostgreSQL-Pfad,
  ist aber keine vollständige echte Channel-/Extractor-E2E-Abnahme. Direkte
  Repository-/Projector-Aufrufe ersetzen dort teilweise den realen Inboundpfad.
- [ ] Alle neun Szenarien über echte Channel-Nachricht, Extractor, Ingestion,
      Retrieval und – wo relevant – echte Zustellung abnehmen.

## Phasen 1–3 – Kanonischer Datenfluss

- [x] Migrationen 005–015, Scope, Historie, Idempotenz, Foreign Keys, RLS,
      Replay-Indizes und getrennte App-/Worker-Policies sind implementiert.
- [x] `world_model_app` und `world_model_worker` sind im lokalen Testsystem
      provisionierbar; die RLS-Prüfung ist mit 11/11 Checks bestanden.
- [x] Observation-Writer, Projector, Raw-Audit, Checkpoints, Outbox,
      Projection-Pending und retrybarer Worker sind verdrahtet.
- [x] Canonical-Factual-Mem0-Writes werden im Canonical-Modus blockiert.
- [~] `docs/audits/world-model/runtime-evidence.json` weist 21/21 synthetische
  Markerchecks inklusive Cleanup nach. `productionData=false`; daraus darf
  keine Produktionsdaten- oder Providerabnahme abgeleitet werden.
- [ ] Inbound, Knowledge, Mission Control, Tool Runner, Gmail und Scheduler
      jeweils mit realer Runtime-Rolle und einem auditierbaren Source-/Receipt-Pfad
      auf einem freigegebenen Testscope abnehmen.

## Phasen 4–6 – Interpretation, Entitäten, Tasks und Aktionen

- [x] Event-Linker, Correction Resolver, bitemporale Assertions, Entities,
      Relations, Tasks, Action Attempts und Completion Evidence sind umgesetzt.
- [x] Mission-Control-Spiegelung und Tool-Receipt-Persistenz sind verdrahtet.
- [x] Gmail-Senden läuft über die World-Model-Action-Attempt-Brücke und fällt
      bei Bridge-Fehlern geschlossen aus; ein direkter unsicherer Fallback wurde
      entfernt.
- [ ] E-Mail-/Kalender-Provider mit Sandbox-Credentials, echten Provider-IDs,
      Statuskopplung, Retry und Delivery-Receipt abnehmen. Im geprüften lokalen
      Bestand waren keine entsprechenden Connector-Secrets vorhanden.

## Phasen 7–9 – Proaktivität und Antworten

- [x] Outbox, Lease, Retry-Backoff, `asked`-Semantik, Standing Intents,
      Heartbeat, Antwortkorrelation, Ruhezeiten, Budget und Deduplizierung sind
      im Code verdrahtet.
- [x] Kanalauflösung berücksichtigt persistierte Bindings und fällt nicht ohne
      Binding auf WebChat zurück.
- [x] Der Scheduler-/Outbox-Drill startet jetzt einen unabhängigen Child-Prozess,
      beendet ihn und prüft die Lease-Rückgewinnung nach TTL. Nachweis:
      `pnpm run world-model:drill -- --scenario scheduler-restart`.
- [ ] Echte Kanalzustellung, DLQ-/Restart-E2E, providerseitige Idempotency und
      kanalübergreifende Budgetabnahme mit realen Bindings durchführen.

## Phasen 10–11 – Retrieval und Embeddings

- [x] Typisierte strukturierte Retrieval-Aggregation, Query Planner, Scope,
      temporale Filter, Evidenzmodell, FTS, Vector Retrieval und Hybrid Ranking
      sind implementiert.
- [x] Die aktive Model-Hub-Pipeline `p1-embeddings` ist live verdrahtet:
      `qwen/qwen3-embedding-8b`, Dimension 4096, Version
      `c207448e-bb64-41bf-a485-bfb2913af0da`.
- [x] Der Live-Benchmark verwendet echte Provider-Embeddings, misst Ranking,
      Latenz und geschätzte Tokens und bestätigt Re-Embedding-Idempotenz in 3/3
      Szenarien. Nachweis: `docs/audits/world-model/embedding-benchmark-live.json`.
- [x] Rebuilds für die fünf bekannten lokalen Scopes wurden ohne synthetische
      Vektoren durchgeführt; ein temporärer Provider-Fehler führte korrekt zu
      einem nicht-grünen Lauf und wurde mit niedrigerer Parallelität erfolgreich
      wiederholt.
- [ ] Vollständige produktionsnahe Qualitätsgrenzen für den gesamten Bestand
      und wiederholbarer Restore-/Rebuild-Nachweis sind noch abzunehmen.

## Phase 12 – Graphiti und Konsolidierung

- [x] Authentifizierter Graphiti-Client, Timeout, Circuit Breaker, Healthcheck,
      sichere deterministische Group-ID, `/search`, scoped Clear und Outbox-
      Projector sind implementiert.
- [x] Lokaler Stack mit Neo4j 5.26.2 und reproduzierbar gepinntem Graphiti-
      Image ist erreichbar; Healthcheck und ein echter scoped Message/Search/
      Clear-Lauf bestehen in `tests/integration/world-model/graphiti-shadow-comparison.test.ts`.
- [x] Evaluator verwendet Live-Graphiti-Treffer und gibt bei Nichterreichbarkeit
      oder unzureichender Präzision `fallback`/`shadow` statt `enable` zurück.
- [~] Der historische Rebuild wurde für alle drei bekannten Scopes im
  semantischen Standardmodus mit Batchgröße 25, scoped RLS-Kontext und
  maschinenlesbaren Reports angenommen. Rohe Observations sind bewusst
  optional (`--include-observations`), weil sie das Provider-Kontextlimit
  belasten. Die Queue wird asynchron verarbeitet; der letzte beobachtete
  Stand blieb bei 15 Restjobs und zeigte Provider-Output-Limit-Fehler.
- [ ] Recall-/Precision-Gate mit belastbarer Trefferquote bestehen und erst
      danach Graphiti für Recall aktivieren. Der aktuelle Report weist die
      Empfehlung `shadow` aus.

## Phasen 13–14 – Backfill, Reconciliation und Mem0-Demotion

- [x] Backfill unterstützt Dry-Run, Scopes, Batchgröße, Resume, idempotente
      Source-IDs sowie getrennte Message-, Knowledge-, Task- und Tool-Phasen.
- [x] Dry-Run-Nachweis: 587 Messages, 11 Knowledge-Episoden/-Ledger-Einträge,
      3 Tool-Aktionen ausgewählt; keine Writes.
- [x] Erster Live-Backfill: 587 Observations, 78 Assertions, 20 Events,
      13 Entities, 10 Task-Spiegel und 3 Tool-Aktionen, 0 Fehler. Danach wurden
      8 + 2 + 4 weitere live eingegangene Messages idempotent ergänzt; die Reports
      liegen unter `docs/audits/world-model/backfill-*.json`.
- [x] Resume ohne neue Daten warf keine Fehler und schrieb keine Duplikate.
- [x] Reconcile behandelt Count-, Scope-, Status-, Embedding- und Pending-
      Differenzen nicht mehr als fälschlich `ok`; Exit-Code 1 wird bei nicht-
      `ok` geliefert und Reports enthalten Snapshot-/Hash-Metadaten.
- [x] Fünf bekannte lokale Scopes wurden einzeln mit identischen Observation-
      und Embedding-Beständen reconciled; die Reports liegen unter
      `docs/audits/world-model/reconcile-live-*.json`.
- [x] All-Scope-Reconcile verwendet einen festen SQLite-Source-Snapshot und
      denselben Cutoff in PostgreSQL. Der aktuelle Lauf ist ohne Differenz:
      697/697 Chat-Observations, 759/759 Embeddings, Pending/Failed 0 und
      Outbox pending/failed 0. Nachweis:
      `docs/audits/world-model/reconcile-current-all-final.json`.
- [x] Mem0-Factual-Audit für vier bekannte lokale Scopes ergab jeweils 0
      faktische Memories; Canonical-Factual-Recall/Writes sind blockiert.
- [~] Providerweiter Mem0-Inventar für unbekannte Scopes, Präferenzmigration,
  Export/Restore und vollständige externe Retention abnehmen; der lokale
  Audit weist die drei bekannten Runtime-Scopes mit 0 faktischen Memories
  nach, besitzt aber bewusst keinen providerweiten List-Endpunkt.
- [x] Persona-Löschung löscht World-Model-, Mem0-, Knowledge- und bei aktivem
      Graphiti-Backend die scoped Graphiti-Gruppe; Graphiti-Fehler brechen die
      Löschung vor dem finalen Persona-Delete ab. Migration 015 erlaubt der App-
      Rolle die scoped Outbox-Löschung.
- [~] Einen vollständigen externen Provider-Lösch-/Restore-Nachweis mit realen
  Daten und wiederholbarer Auditkette durchführen.
  Der kanonische Scope-Export/-Restore ist lokal mit Manifest-Hash und
  Replace-Lauf belegt; externe Mem0-/Graphiti-Daten bleiben ohne Provider-
  Inventar bzw. freigegebene Testdaten offen.

## Phase 15 – Betrieb und Cutover

- [x] Health-Route, Write-Health, Metriken, Lifecycle-Code, Rollen-
      Provisionierung, Incident-Runbook und Failure-Drill-Script sind vorhanden.
- [x] `world-model:drill -- --scenario all` besteht mit 5/5 gezielten
      injizierten Szenarien: Postgres-Verbindungsblockade, Scheduler-Lease,
      Graphiti-Fallback, Embedder-Fallback und Duplicate-Webhook.
- [x] Der Scheduler-Fall ist eine echte Child-Process-Restart-Abnahme mit
      Lease-Recovery; die übrigen vier lokalen Failure Drills bestehen ebenfalls.
- [~] Canary, Rollback, Wiederanlauf und Rebuild über echte Prozess-/Deploy-
  grenzen sowie externe Alerting-Integration praktisch abnehmen.
- [ ] Canonical für den vollständigen Produktivscope freigeben. Das lokale
      `WORLD_MODEL_MODE=canonical` ist eine Runtime-Konfiguration, kein Beweis für
      die Erfüllung der offenen Betriebs- und Provider-Gates.

## Relevante Nachweise

| Nachweis                                                           | Aussage                                                          | Status |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- | ------ |
| `docs/audits/world-model/runtime-evidence.json`                    | 21/21 synthetische Markerchecks, Cleanup, `productionData=false` | `[~]`  |
| `docs/audits/world-model/backfill-dry-run.json`                    | Dry-Run-Auswahl ohne Writes                                      | `[x]`  |
| `docs/audits/world-model/backfill-live.json` plus Resumes          | Live-Backfill und nachfolgende Dev-Live-Deltas                   | `[x]`  |
| `docs/audits/world-model/embedding-benchmark-live.json`            | Echter Provider, 4096 Dimensionen, 3/3 Szenarien, Re-Embedding   | `[x]`  |
| `docs/audits/world-model/reconcile-current-all-final.json`         | All-Scope-Snapshot: 697/697, 759/759, Pending/Outbox 0           | `[x]`  |
| `docs/audits/world-model/mem0-known-scope-audit-current.json`      | Drei bekannte Scope-Audits, jeweils 0 faktische Memories         | `[~]`  |
| `tests/integration/world-model/graphiti-shadow-comparison.test.ts` | Echte lokale Graphiti Message/Search/Clear-Evidenz               | `[x]`  |
| `docs/audits/world-model/rebuild-current-*-graphiti-semantic.json` | Drei scoped semantische Graphiti-Rebuilds, chunkweise            | `[~]`  |
| `docs/audits/world-model/graphiti-recall-drift-current.json`       | Erreichbarkeit/Recall/Precision; Aktivierung bleibt `shadow`     | `[~]`  |
| `scripts/world-model-failure-drill.ts -- --scenario all`           | 5/5 lokale Failure Drills inkl. Child-Process-Lease-Recovery     | `[x]`  |

## Verbindliche Restarbeiten vor Freigabe

1. Echte Channel-/Extractor-E2E der neun Szenarien ohne direkte Projector-
   Ersatzaufrufe.
2. Sandbox-Abnahme für E-Mail/Kalender/Kanalzustellung mit Provider-IDs und
   Receipts sowie echter Prozessgrenzen-Restartprüfung.
3. Graphiti-Providerlimit beheben oder ein geeignetes Modell/Chunking
   freigeben, die Queue vollständig abarbeiten lassen, danach den
   Recall-/Precision-Report erneut ausführen und erst bei bestandener Schwelle
   aktivieren.
4. Providerweiter Mem0-Audit sowie Export/Restore/Löschabnahme, soweit der
   Provider einen belastbaren Scope-List-/Delete-Nachweis bereitstellt.
5. Für einen externen/produktiven Scope einen eingefrorenen oder versionierten
   Source-Snapshot bereitstellen; anschließend Canary, Rollback und erst dann
   Release praktisch abnehmen.

## Fokussierte Abschlusschecks

Nach Änderungen am Quellcode sind nur die betroffenen Prüfungen sowie die
Repository-Gates auszuführen:

```powershell
pnpm run world-model:verify-rls
pnpm exec vitest run tests/unit/world-model/graphiti-client.test.ts tests/unit/world-model/outbox-dispatcher.test.ts tests/unit/master/gmail-route-world-model.test.ts
pnpm run check
pnpm run build
```

Die Browser-E2E ist für diese Korrekturen nicht erforderlich; sie wird nur bei
Änderungen am UI-, Routing- oder Browservertrag erneut gestartet.
