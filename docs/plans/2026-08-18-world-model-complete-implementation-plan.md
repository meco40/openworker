# Vollständiger Umsetzungsplan für Memory, Knowledge und proaktive Personas

_Arbeitsplan für die vollständige Zielarchitektur der persönlichen 24-Stunden-Sekretärin · Evidenzabgleich 2026-08-20 · verbindlicher Restarbeitsplan, Canonical-Cutover offen_

---

## Aktueller Evidenzabgleich – 2026-08-20

Dieser Abschnitt superseded ältere Zwischenstände und Abschlussclaims in
diesem Dokument. Maßgeblich sind die maschinenlesbaren Reports und die aktuell
ausgeführten fokussierten Prüfungen, nicht frühere Checkboxen.

### Bestätigt

Der nachfolgende Delta-Audit wurde am 2026-08-20 ergänzt
und superseded die älteren Graphiti-/Scheduler-/Reconcile-Zwischenstände:

- Die stabile SQLite-Message-ID ist im Live-Inbound-/Outbound-Bridgepfad und
  im Backfill identisch verdrahtet. Drei bekannte lokale Scopes sind nach
  scoped Rekey ohne Observation-Differenz reconciled (697/697).
- Der Outbox-Dispatcher entdeckt Runtime-Scopes aus SQLite bzw. einer
  Allowlist und dispatcht unter RLS. Der Scheduler-Failure-Drill verwendet
  jetzt eine unabhängige Child-Process-Grenze und besteht nach Lease-TTL.
- Embeddings sind nach scoped RLS-korrektem Rebuild vollständig paritätisch
  (759/759). Der Graphiti-Rebuild wurde für alle drei bekannten Scopes mit
  Batch-/Content-Limits ausgeführt. Der Standardlauf projiziert bewusst nur
  semantische Assertions, Events und Relations; rohe Chat-Observations sind
  per `--include-observations` optional. Der aktuelle maschinenlesbare
  Recall-/Driftreport empfiehlt wegen nicht bestandener Trefferqualität
  weiterhin `shadow`.
- Die Dependency-Audit-Korrekturen sind konsistent installiert: `pnpm
install --frozen-lockfile --offline` lief erfolgreich, und `pnpm audit
--json` weist für 746 Abhängigkeiten 0 Advisories in allen Schweregraden
  aus.
- Der kanonische Export/Restore wurde lokal mit Manifest-Hash und Replace-
  Lauf geprüft. Externe Provider-Lösch-/Restore- und Channel-/Provider-
  Nachweise bleiben ohne freigegebene Credentials bzw. Testdaten offen.

- Der kanonische PostgreSQL-Pfad, die Projektions-/Retry-Logik, RLS und die
  getrennten Runtime-Rollen sind implementiert. `world-model-verify-rls` weist
  11/11 Checks nach.
- Der Backfill wurde tatsächlich lokal ausgeführt: 587 Messages im ersten
  Lauf, danach 8 + 2 + 4 weitere Dev-Live-Messages, jeweils ohne Fehler. Die
  Reports liegen unter `docs/audits/world-model/backfill-*.json`.
- Die Embedding-Pipeline nutzt live die Model-Hub-Pipeline `p1-embeddings`
  (`qwen/qwen3-embedding-8b`, 4096 Dimensionen). Der Live-Benchmark weist 3/3
  Szenarien und Re-Embedding-Idempotenz nach: `docs/audits/world-model/embedding-benchmark-live.json`.
- Fünf bekannte Scopes wurden einzeln reconciled; ein laufender Dev-Server kann
  einen unscoped All-Scope-Scan durch neue Messages zwischen Source-Snapshot
  und World-Model-Scan verändern. Die Reconcile meldet diese Differenz korrekt
  als Fehler statt sie als Parität zu behaupten.
- Ein echter lokaler Graphiti Message/Search/Clear-Lauf besteht. Der Graphiti-
  Evaluator verarbeitet Live-Treffer und fällt bei Fehlern zurück.
- Die fünf Failure-Drill-Szenarien bestehen mit gezielter lokaler Fehler-
  injektion; der Scheduler-Drill verwendet eine unabhängige Child-Process-
  Grenze und prüft Lease-Recovery nach Prozessende.

### Nicht als erledigt nachweisbar

- `docs/audits/world-model/runtime-evidence.json` ist synthetische
  Marker-Evidenz (`evidenceClass=synthetic-marker`, `productionData=false`).
  Sie belegt die Runtime-Mechanik und das Cleanup, nicht Produktionsdaten.
- Die neun Sekretärinnen-Szenarien sind keine vollständige Channel-/Extractor-
  E2E-Abnahme; direkte Repository-/Projector-Aufrufe ersetzen dort teilweise
  den echten Inboundpfad.
- Externe E-Mail-, Kalender- und Kanalprovider mit echten IDs, Zustellung und
  Receipts wurden mangels lokaler Connector-Secrets nicht abgenommen.
- Der historische Graphiti-Rebuild ist für die drei bekannten lokalen Scopes
  im semantischen Standardmodus mit begrenzten Chunks und Content-Limits
  angenommen. Der Dienst verarbeitet die Jobs asynchron; die letzten Logs
  zeigen wiederholte Provider-Fehler wegen `Output length exceeded max tokens
8192` und keinen belegten Queue-Abschluss. Der separate Recall-/Precision-
  Report bleibt unter der Aktivierungsschwelle und hält Graphiti deshalb
  Shadow-only.
- Ein providerweites Mem0-Inventar sowie vollständiger Export-/Restore-/Lösch-
  nachweis sind nicht belegt. Vier bekannte lokale Scopes enthielten jeweils
  keine faktischen Memories.
- Canary, Rollback, externer Alerting-Nachweis und ein echter Deploy-/Prozess-
  Restart mit externen Provider-Receipts sind offen. `WORLD_MODEL_MODE=canonical` in
  `.env.local` ist deshalb keine Freigabe des vollständigen Produktivscopes.

### Verbindlicher Reststatus

Der Code ist lokal belastbar, aber der Plan ist nicht vollständig abgenommen.
Die offene Freigabe hängt an R2 (echte Channel-/Provider-E2E), R4/R7
(providerweiter Mem0-/Lösch-/Restore-Nachweis), R6 (Recall-/Precision-
Schwelle nach einem belegten Queue-Abschluss), R8 (Deploy-Canary und
Rollback) sowie einem freigegebenen produktiven Snapshot. Die Dependency-
Audit-Warnungen sind dagegen aktuell vollständig bereinigt.

## 📋 Überblick

Dieser Plan schließt die Lücke zwischen dem bereits implementierten World-Model-Fundament und einer tatsächlich mitdenkenden, langfristig erinnernden und proaktiv handelnden Persona. Er baut auf der [Zielarchitektur](../memory-knowledge-target-architecture.md) und dem aktuellen [World-Model-Runbook](../runbooks/WORLD_MODEL_ROLLOUT.md) auf.

> 📌 **Kernziel:** PostgreSQL wird nicht nur konzeptionell, sondern im realen Nachrichten-, Knowledge-, Task-, Tool- und Proaktivitätsfluss die verbindliche Wahrheit. Mem0, SQLite Knowledge, pgvector und Graphiti sind danach kontrollierte Projektionen oder spezialisierte Retrieval-Schichten.

### Aktueller Gesamtstatus

| Bereich      | Bereits umgesetzt                                                                                                                                  | Noch erforderlich                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| PostgreSQL   | Migrationen 001–015, Transaktionen, Outbox, Scope, RLS, Replay-Indizes, Lease- und Projection-Policies; lokale Runtime-Rollen und 11/11 RLS-Checks | Produktions-Canary und Cutover                                                             |
| Ereignisse   | Statushistorie, Event-Linker, Kino-/Essen-Korrektur, Raw-Audit und Knowledge-Projector; marker-isolierte Integration grün                          | Echter Channel-/Extractor-E2E-Pfad und vollständiger Nachrichtenbestand                    |
| Fakten       | Bitemporale Assertions, Provenienz, Entity-/Alias-/Relation-Historie und atomare Projektion; All-Scope-Snapshot 697/697 reconciled                 | Freigegebener produktiver Snapshot ohne Dev-Live-Race                                      |
| Aufgaben     | Schema, Transition-Regeln, Action Attempts, Mission-Control-Mirror, Receipts und Gmail-World-Model-Brücke                                          | E-Mail-/Kalender-Provider, echte Provider-IDs und vollständige Statuskopplung              |
| Proaktivität | Open Loops, Standing Intents, Scheduler-Takt, Heartbeat, Policies, Lease, Outbox und Retry-Backoff                                                 | Echte Zustellung, DLQ-/Restart-E2E und Kanalpräferenzen mit Provider-Receipts              |
| Retrieval    | World-Model-Priorität, typisierte Aggregation, Volltext, Planner, Model-Hub-Embedding und Live-Benchmark                                           | Vollständige produktionsnahe Qualitäts-/Restore-Messung                                    |
| Graph        | Scopedes lokales Shadow-Ledger, REST-Client, Compose-Stack, bounded Projector/Evaluator, drei historische Rebuilds und Driftreport                 | Queue-Abschluss, Recall-Schwelle und kontrollierte Aktivierung                             |
| Mem0         | Preferences-only-Policy, Canonical-Factual-Guard; vier bekannte Scopes ohne faktische Memories auditiert                                           | Providerweites Inventar, Präferenzmigration, Export/Restore und faktischer Recall-Nachweis |
| Betrieb      | Guards, Metriken, Health-Route, Alerting-Code, Lifecycle-Code, Incident-Runbook und fünf gezielte lokale Drills                                    | Echte Prozessgrenzen, externe Löschkaskaden, Canary, Rollback und Canonical-Cutover        |

> ⚠️ **Release-Urteil:** Der Codekern und die lokalen Qualitätsgates sind belastbar. Der vollständige Canonical-Cutover bleibt gesperrt: echte Channel-/Provider-E2E, providerweite Mem0-/Lösch-/Restore-Nachweise, das noch nicht bestandene Graphiti-Recall-Gate sowie Canary und Rollback sind nicht vollständig belegt.

### Scope

Der Plan umfasst:

- kanonische Schreib- und Lesepfade,
- Ereignisse, Fakten, Entitäten, Beziehungen, Aufgaben und Tool-Ergebnisse,
- Open Loops, Standing Intents, dauerhafte Follow-ups und Heartbeat,
- zeitliches und semantisches Retrieval,
- pgvector und Graphiti,
- Mem0-Reduktion,
- Datenmigration, Reconciliation, Datenschutz, Observability und Rollout,
- Ende-zu-Ende-Abnahme anhand realistischer Sekretärinnen-Szenarien.

Nicht automatisch eingeführt werden `pg-boss`, Hatchet oder Temporal. Sie werden erst verwendet, wenn die in diesem Plan definierten Eskalationskriterien erfüllt sind. Graphiti bleibt eine abgeleitete Projektion und darf nie das System of Record werden.

## 📍 Aktueller Umsetzungsstand

### Statuslegende

| Status                    | Bedeutung                                                                 |
| ------------------------- | ------------------------------------------------------------------------- |
| Umgesetzt und verifiziert | Baustein ist produktionsnah implementiert und durch passende Tests belegt |
| Weitgehend umgesetzt      | Kern ist vorhanden; einzelne Betriebs- oder Integrationsschritte fehlen   |
| Teilweise umgesetzt       | Relevante Bausteine existieren, aber der reale End-to-End-Pfad fehlt      |
| Offen                     | Zielkomponente ist noch nicht implementiert                               |

Die Statusangaben bewerten nicht nur vorhandene Dateien. Entscheidend ist, ob der Baustein über den realen Nachrichten-, Knowledge-, Task-, Tool-, Scheduler- oder Channel-Pfad verwendet wird.

### Phasen 0 bis 6: Kanonischer Kern

| Phase | Status               | Bereits umgesetzt                                                                                                                                                     | Noch offen                                                                                       |
| ----: | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
|     0 | Weitgehend umgesetzt | Agent-Vertrag, Domain Registry, Szenario-Fixtures, Task-/Automation-Verträge und API-/Migrationsmatrix                                                                | Vollständige echte E2E-Abnahme aller neun Szenarien und öffentlicher UI-Migrationen              |
|     1 | Weitgehend umgesetzt | Migrationen 005–012; Workspace-Scope; historische Assertions; Foreign Keys; RLS; Replay-/Isolationstests; Rollen-Provisionierungsworkflow und Async-RLS-Scope-Kontext | Echte App-/Scheduler-Credentials, Produktions-Rollenprovisionierung und vollständiger Call-Audit |
|     2 | Weitgehend umgesetzt | Mode, Guard, atomarer Observation-/Outbox-Bridge, einziger Writer, `memory_pending`, Retry/Reconcile und Health                                                       | Canonical-Nachweis mit produktiven Daten und Rollen                                              |
|     3 | Weitgehend umgesetzt | Normalisierung/atomarer Projector für alle Artefakte, Raw-Audit, Replay, Checkpoint nach Commit und Legacy-Retry                                                      | Produktions-Fehler-/Replay-Abnahme und vollständiger Nachrichtenbestand                          |
|     4 | Weitgehend umgesetzt | Event-Linker, Correction Resolver, Statushistorie, Kandidaten-/Outcome-Semantik und Kino-/Essen-Integration                                                           | Echter Channel-E2E-Nachweis mit Mehrdeutigkeitsdialogen                                          |
|     5 | Weitgehend umgesetzt | Assertion-Service, bitemporale Historie, Entity-/Alias-/Disambiguation-Service und Relationshistorie                                                                  | Produktive Szenarioabnahme und vollständige Extraktor-Parität                                    |
|     6 | Teilweise umgesetzt  | Task-Transitionen, Action Attempts, Mission-Control-Mirror, Completion Evidence, Receipt-Schema und Gmail-World-Model-Brücke                                          | Externe E-Mail-/Kalender-Provider, echte Provider-IDs und vollständige Statuskopplung            |

### Phasen 7 bis 12: Proaktivität und Retrieval

| Phase | Status               | Bereits umgesetzt                                                                                                                                                    | Noch offen                                                               |
| ----: | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
|     7 | Teilweise umgesetzt  | Due-Loop-Scan, Scheduler-Takt, Notification Policy, idempotente Outbox-Absicht, Lease, Retry-Backoff, Binding-basierte Kanalauswahl und Child-Process-Lease-Recovery | Provider-Delivery, belastbare DLQ und externe Restart-E2E                |
|     8 | Weitgehend umgesetzt | Standing-Intent-Compiler, strukturierte Matcher, idempotenter Fire-Zähler, Folgeaktions-Dispatcher und Heartbeat-Reconciliation                                      | Echter Provider-Folgeaktionsnachweis und produktive Reconciliation       |
|     9 | Teilweise umgesetzt  | Korrelation, Klärung, atomare Observation-/Zustandsänderung, Ruhezeiten, Budget und Deduplizierung                                                                   | Kanalübergreifende unsichtbare Metadaten, Provider-E2E und Budgetabnahme |
|    10 | Weitgehend umgesetzt | Query Planner, typisierte Aggregation für Events/Assertions/Relations/Tasks/Open Loops, Scope, `as_of` und Evidenzmodell                                             | Echte historische Datenabnahme und Antwortqualitätsmessung               |
|    11 | Weitgehend umgesetzt | Embedding-Format, HNSW-/pgvector-Schema, Provider-Interface, Worker, Vector Retrieval, Hybrid-Ranking, Model-Hub-Live-Benchmark und scoped Rebuild                   | Produktionsqualitätsgrenzen und Restore-Abnahme                          |
|    12 | Weitgehend umgesetzt | Scopedes lokales Graphiti-Shadow-Ledger, offizieller REST-Client, Compose-Stack, bounded Projector, Evaluator, chunkweiser Rebuild und Recall-Report                 | Queue-Abschluss, Recall-/Precision-Schwelle und produktive Aktivierung   |

### Phasen 13 bis 15: Migration und Betrieb

| Phase | Status               | Bereits umgesetzt                                                                                                                                                | Noch offen                                                                     |
| ----: | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
|    13 | Weitgehend umgesetzt | Idempotente Backfill-/Reconcile-/Rebuild-Skripte mit Dry-Run, Scope, Batch, Resume, Snapshot-/Hash-Report und drei lokalen Graphiti-Rebuilds                     | Freigegebener Produktionssnapshot und externe Providerdaten                    |
|    14 | Teilweise umgesetzt  | Mem0-Typenpolicy, Canonical-Factual-Guard, Recall-Filter, bekannte Scope-Audit, kanonischer Export/Restore mit Manifest-Hash und SQLite als retrybare Projektion | Providerweites Inventar, Präferenzmigration und externe Lösch-/Restore-Abnahme |
|    15 | Weitgehend umgesetzt | Metriken, Alerting-Schwellen, Lifecycle-Code, Runtime-Policies, Health-Route, Runbook, 5/5 Failure Drills und scoped Rollout-Gate                                | Externe Alerting-/Deploy-Abnahme, Canary, Rollback und Cutover                 |

### Verifikation des aktuellen Arbeitsstands

Der folgende Stand wurde am 2026-08-19 nach den Korrekturen erneut geprüft. Der
frühere Auditstand 16:17 bleibt als historische Entwicklung nachvollziehbar,
ist aber durch den aktuellen Evidenzabgleich oben superseded:

| Nachweis                | Ergebnis                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| World-Model-Migrationen | 001–015 angewendet; Runtime-Rollen `world_model_app` und `world_model_worker` sind login-enabled                                                                                                        |
| World-Model-Fokussuite  | Gezielt betroffene Unit-/Graphiti-Tests bestanden; die 9 Szenarien bestehen weiterhin, verwenden aber teilweise direkte Observations/handgebaute Projektionen statt des echten Channel-/Extractor-Pfads |
| RLS- und Rollenprüfung  | `pnpm run world-model:verify-rls`: 11/11 Checks bestanden                                                                                                                                               |
| Vollständige Testsuite  | Frühere Volltests sind dokumentiert; für diese Korrektur sind gezielte Unit-Tests, `check` und `build` erneut grün. Ein erneuter Volltest ist für diese reine Status-/Gatekorrektur nicht erforderlich  |
| Repository-Check        | `pnpm run check`: Typecheck, Oxlint ohne Warnungen/Fehler, Prettier-Check grün                                                                                                                          |
| Production Build        | `pnpm run build` grün; Next.js-Routen inkl. `/api/health/world-model` erzeugt                                                                                                                           |
| Smoke E2E               | 7 Dateien/11 Tests bestanden                                                                                                                                                                            |
| Browser E2E             | 76/76 Tests auf frischem Server-Port 3011 bestanden                                                                                                                                                     |
| Backfill/Reconcile      | Erster Live-Backfill 587 Messages plus 8 + 2 + 4 Dev-Live-Deltas; aktueller All-Scope-Snapshot 697/697 Observations und 759/759 Embeddings, Pending/Outbox 0                                            |
| Embeddings              | Echter Model-Hub-Provider, 4096 Dimensionen, 3/3 Benchmark-Szenarien und Re-Embedding-Idempotenz; vollständige Produktionsqualitätsgrenze bleibt offen                                                  |
| Graphiti                | Lokaler Stack erreichbar; drei scoped historische Rebuilds und separater Recall-/Precision-Report. Empfehlung bleibt wegen nicht bestandener Schwelle `shadow`                                          |
| Failure Drills          | 5/5 gezielte lokale Injektionen grün; Scheduler-Recovery über unabhängigen Child-Prozess nach Lease-TTL                                                                                                 |

Diese Nachweise bestätigen die implementierten Bausteine und den lokalen
Release-Zustand. Sie ersetzen nicht den echten Channel-/Provider-Pfad,
providerweite Mem0-/Lösch-/Restore-Nachweise, die noch nicht bestandene
Graphiti-Recall-Schwelle oder den Canary-/Rollback-Cutover.

### Abgleich mit der nachgelagerten Execution-TODO

Die Datei `docs/plans/2026-08-19-world-model-complete-execution-todo.md` enthält zwar 62 gesetzte Checkboxen, mehrere davon beschreiben jedoch Behauptungen, die durch den Live-Audit nicht belegt sind. Für die weitere Arbeit gilt deshalb der folgende evidenzbasierte Status:

| TODO-Behauptung                                                           | Tatsächlicher Nachweis                                                                                                                                        | Weiterarbeit  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Neun Szenarien seien echter Channel-/Extractor-E2E                        | Die Suite schreibt direkte Observations und handgebaute Projektionen; sie läuft nicht durch den vollständigen Channel-/Extractor-Pfad                         | R2            |
| Runtime-Evidence und produktive Rollen-/Datenabnahme seien vollständig    | Der Report ist synthetische Marker-Evidenz (`productionData=false`); die Rollen-/RLS-Prüfung ist separat mit 11/11 grün, Produktionsdatenabnahme bleibt offen | R0, R1 und R3 |
| E-Mail-/Kalender-Provider und externe Receipts seien abgenommen           | `master_connector_secrets` ist leer; externe Provider-IDs und Receipts sind nicht verifiziert                                                                 | R2            |
| Embeddings, Re-Embedding und Qualitätsmetriken seien produktiv abgenommen | Live-Provider-Benchmark 3/3 und Re-Embedding-Idempotenz sind belegt; vollständige Produktionsqualitätsgrenze bleibt offen                                     | R5            |
| Graphiti sei historisch vollständig projiziert und im Recall freigegeben  | Semantische Rebuilds und ein aktueller Driftreport sind belegt; Queue-Abschluss, Provider-Output-Limit und Recall-Aktivierung bleiben offen                   | R6            |
| Backfill und Reconciliation seien vollständig und idempotent              | Live-Backfill und fünf Scope-Reconciles sind belegt; All-Scope braucht einen ruhigen/versionierten Snapshot                                                   | R0 und R3     |
| Löschkaskaden seien mit realen Projektionen nachgewiesen                  | Scoped Codepfad und lokaler Graphiti-Clear sind belegt; vollständiger externer Provider-/Restore-Nachweis bleibt offen                                        | R7            |
| Alle fünf Failure Drills seien reale Abnahmen                             | 5/5 lokale Fehler-Injektionen bestehen; echter Scheduler-Prozess-Restart und externe Recovery bleiben offen                                                   | R8            |
| `WORLD_MODEL_MODE=canonical` sei vollständig freigegeben                  | Lokal konfiguriert, aber R2/R4/R6/R7/R8-Gates sowie Canary/Rollback sind offen                                                                                | R9            |

## 🧭 Verbindlicher Restarbeitsplan für alle offenen Punkte

Dieser Abschnitt ersetzt die bisherige grobe Reihenfolge durch einen ausführbaren Plan. Die offenen Checkboxen in den Phasen 11–15 und in der Definition of Done werden erst nach den unten genannten Nachweisen gesetzt. Bestehende Unit-Tests, synthetische Marker und direkte Repository-/Projector-Aufrufe gelten nicht allein als Abnahme für den echten Runtime-Pfad.

### Arbeitsregeln und Abnahmestandard

1. Jeder Arbeitspaket-Start dokumentiert read-only den Ausgangszustand für User, Persona, Workspace, Datenbankrolle, Provider und Scope. Es gibt kein globales Truncate und keine unscoped Löschung.
2. Jeder Eingriff beginnt mit einem Dry-Run. Live-Abnahmen laufen zuerst in einem benannten Testscope mit realen App-/Worker-Credentials und erst danach auf ausdrücklich freigegebenen Daten.
3. Jede Evidenz enthält Zeitstempel, Scope, Rolle, Datenbankziel, Auswahlkriterien, Counts, Fehler, Hashes, verwendete Kommandos und den Report-Pfad. Secrets bleiben außerhalb von Repository und Dokumentation.
4. Eine Checkbox wird erst nach Code, fokussiertem Test, realem Integrationsnachweis und maschinenlesbarem Evidenzreport gesetzt.
5. Der Rollout folgt strikt `off` → `shadow` → `required` → `canonical`. Ungeklärte Reconciliation-, Scope-, Provider-, Lösch- oder Restore-Differenzen blockieren den nächsten Modus.

### R0 — Baseline, Reconciliation und Evidenz reparieren

- `scripts/world-model-reconcile.ts` so ändern, dass unerklärte Count-, Scope-, Status- oder Hash-Differenzen `warn`/`error` werden und der Prozess mit Exit-Code 1 endet. Die aktuelle Darstellung von SQLite 583 gegenüber World Model 22 als `ok` ist nicht akzeptabel.
- Die Reconciliation um eindeutige Scope-/Source-Coverage, aktive und superseded Assertions, Eventstatus, Tasks, Receipts sowie pending/failed Projection-Zustände erweitern. Old/New-Werte müssen dieselbe Datenbasis und denselben Scope vergleichen.
- `docs/audits/world-model/runtime-evidence.json` nur aus einem tatsächlich abgegrenzten Lauf erzeugen: Marker-Records müssen nach der Abnahme entfernt oder als exportierter Testscope nachweisbar sein. Canned Extraction bleibt auf Unit-Tests begrenzt.
- Reports müssen `generatedAt`, Rolle, DB-Ziel, Scope, Commands, Counts, Hashes und `ok=false` bei Parity-Fehlern enthalten.
- Abnahme: eine absichtlich fehlende Zeile lässt Reconcile fehlschlagen; ein Wiederholungslauf liefert `delta=0`; Marker-Cleanup oder Export ist nachprüfbar.

### R1 — Kanonischen Runtime- und Writer-Pfad abnehmen

- App-/Worker-URLs mit provisionierten Rollen verifizieren; Migrationen bleiben admin-only. Für Inbound, Knowledge, Mission Control, Tool Runner, Gmail, Scheduler und Outbox wird je ein Audit mit Scope, Source und Idempotency-Key geführt.
- Nachweisen, dass jeder relevante Write genau eine kanonische Observation/Projection erzeugt und Legacy-Writes nur noch abgeleitet werden. Der Nachweis beginnt im Shadow-Testscope und geht erst danach in `required`.
- `off`, `shadow`, Startzeitpunkt, Default-Scope-Verhalten und die verwendeten Rollen im Betriebsreport dokumentieren.
- Abnahme: identischer Input erzeugt genau einen identischen Zustand; ein erforderlicher Postgres-Ausfall blockiert Writes kontrolliert und erzeugt eine sichtbare Health-/Metrikmeldung.

### R2 — Echte Channel-, Provider- und Proactivity-E2E

- `tests/integration/world-model/secretary-scenarios-flow.test.ts` von direkten `recordObservation()`-/handgebauten `projectWindow()`-Aufrufen auf echte Channel-Nachricht, Extractor, Ingestion und Retrieval umstellen.
- Die neun bzw. zehn Szenarien mit Observation, Provenance, Historie und Open Loops prüfen. Tests dürfen nicht durch `describe.skipIf` einen aktivierten Lauf als produktive Abnahme tarnen.
- Für echte Provider-Bindings Provider-ID, Ziel, Kanal, Zeit, Retry, DLQ und Delivery-Receipt in Postgres festhalten. E-Mail-, Kalender- und Tool-Aktionen benötigen Sandbox-Credentials oder werden ausdrücklich als blockiert ausgewiesen.
- Scheduler-Restart über eine echte Prozessgrenze und Duplicate-Response nachweisen; pro Side Effect muss genau ein Receipt oder ein begründeter No-Receipt-Fehler vorliegen.
- Abnahme: Der Test enthält keine direkten Repository-/Projector-Aufrufe als Ersatz für Runtime-Verhalten und jede externe Nebenwirkung besitzt eine überprüfbare Receipt-Kette.

### R3 — Vollständiger Backfill und belastbare Datenparität

- Ein Dry-Run muss Auswahl, Scope, Zeitraum, Batch- und Rate-Limits sowie erwartete Live-Counts vorhersagen.
- Messages, Knowledge, Mission-Control-Tasks und Action-Ledger mit stabilen Source-IDs, Checkpoints, Provenance und Fehlerstatus importieren. Alle vier Quellen müssen im Report `selected`, `processed`, `skipped`, `failed` und Source-Coverage ausweisen.
- Den vollständigen Lauf auf dem benannten Testscope wiederholen. Der zweite Lauf muss `newWrites=0`, `errors=0`, unveränderte Counts/Hashes und keine Duplikate ergeben.
- Konflikte, fehlende Quellen und nicht erklärbare Abweichungen blockieren den Canonical-Cutover; Reconciliation darf nur bei `0` unerklärten Differenzen passieren.

### R4 — Mem0-Demotion und Factual-Audit

- Alle User-/Persona-Scopes inventarisieren; ein leerer oder einzelner lokaler Scope ist kein Migrationsnachweis.
- Präferenzen, Vermeidungen, Persönlichkeit und Workflow-Regeln getrennt klassifizieren. Nur belegte Präferenzen mit Source, Version und Scope migrieren.
- Factual Mem0-Recall und -Writes im Canonical-Modus blockieren; Präferenzen bleiben explizit scoped und auditierbar.
- SQLite als read-only Quelle behandeln sowie Export und Restore dokumentieren. Ein Mem0-Ausfall darf strukturierte Ingestion und Recall nicht brechen.
- Abnahme: Factual-Audit ist vollständig, Präferenzdaten sind nachvollziehbar, und kein Scope-Leak entsteht bei Provider-Ausfall oder Wiederholung.

### R5 — Embeddings, Re-Embedding und messbare Retrieval-Qualität

- Einen real erreichbaren P1-Embedding-Provider mit Test-Credential abnehmen und Modell, Version, Dimensionen, Text-Hash und Projection-Version speichern.
- Relevante Assertions, Events, Tasks, Entities und Episodes über einen Worker embedden; retryable Fehler, Backoff und dauerhafte Fehler müssen getrennt sichtbar sein.
- Re-Embedding bei Modell-, Text- oder Statusänderung implementieren und aus Postgres vollständig reproduzierbar machen.
- Für feste Testfragen Recall, Precision, Latenz, Token-/Provider-Kosten, Ranking und Suppression messen. Strukturierter Recall bleibt bei Provider-Ausfall verfügbar.
- Abnahme: `world_model_embeddings` ist nicht leer, alle Datensätze sind versioniert, Qualitätsgrenzen sind dokumentiert und ein Rebuild erzeugt denselben Bestand.

### R6 — Graphiti-Backend und Shadow-Vergleich

- Backend-, Graphiti-, Neo4j- und REST-Version sowie Group-/Scope-Strategie, Limits und Retention dokumentieren.
- Den Credential-Stack starten und Healthcheck, Message-, Entity-, Node- und Group-Responses mit echten IDs abnehmen.
- Ausschließlich aus der kanonischen Outbox projizieren; Scope, Validity, Known/Unknown, Source und Confidence müssen erhalten bleiben.
- Strukturierte und Vektor-Wahrheit gegen einen festen Fragenkatalog mit Drift-Report vergleichen. Graphiti bleibt Shadow, bis die Schwelle erreicht ist.
- Ausfall, Fallback, Rebuild und Resume testen; Recall erst nach bestandenem Shadow-Vergleich aktivieren und rücksetzbar halten.

### R7 — Export, Löschung und Retention Ende-zu-Ende

- `deleteWorldModelScope()` in den Persona-/User-Löschpfad integrieren; die Löschung muss vor dem finalen Repository-Delete scoped ausgeführt werden.
- Provider-spezifische Mem0- und Graphiti-Löschung implementieren. `externalProjectionCleanupRequired` darf nach erfolgreicher Löschung nicht ungelöst zurückbleiben.
- Canonical-Projektionen, Embeddings, SQLite, Mem0, Graphiti, Outbox, Receipts und Checkpoints in definierter Reihenfolge löschen und jeden Schritt auditieren.
- Scope-Export mit Hash und Restore-Test bereitstellen. Retention darf nur nichtaktuelle Daten betreffen und muss wiederholbar sowie fehlertolerant sein.
- Abnahme: Nach erfolgreicher Löschung verbleibt in keinem freigegebenen Provider ein Datensatz des Scopes; Wiederholung ist safe und auditierbar.

### R8 — Reale Failure Drills, Canary und Rollback

- Einen isolierten Postgres-Ausfall oder eine Netzwerkblockade für den Testscope durchführen. Im `required`-Modus müssen Writes kontrolliert blockieren und nach Recovery fortsetzen.
- Einen echten Scheduler-Prozess-Restart testen: Lease, Outbox, Follow-up und Recovery müssen genau einmal wirksam werden.
- Graphiti-Container stoppen und Fallback, pending/outbox-Verhalten, Rebuild und Resume prüfen.
- Einen echten Embedding-Timeout oder Provider-Ausfall auslösen; Pending-, Retry- und Structured-Recall-Verhalten müssen nachweisbar sein.
- Einen Duplicate-Webhook über zwei Requests beziehungsweise Prozessgrenzen ausführen und genau einen Side Effect mit Receipt nachweisen.
- Monitoring, Alerts, Runbook und Recovery-Zeit dokumentieren. Ein Drill muss bei deaktivierter Abhängigkeit `skipped` oder `blocked` melden, niemals fälschlich `passed`.
- Canary auf Testscope, Persona-Allowlist und Workspace begrenzen; Rollback auf `shadow`/`off`, Rebuild und Wiederanlauf praktisch durchführen.
- Abnahme: Alle fünf realen Ausfallklassen inklusive Recovery sind belegt und es bleiben keine unkontrollierten Testmarker oder Prozesse zurück.

### R9 — Finaler Canonical-Cutover und Abschlussabnahme

- R0–R8 müssen abgeschlossen oder mit einem expliziten, akzeptierten Blocker dokumentiert sein. Ein Blocker darf nicht als erledigtes DoD-Kriterium markiert werden.
- Canonical zunächst nur für Testscope mit echten Nachrichten, Tasks, Tools, Follow-ups und Retrieval aktivieren. Canary-, Rollback-, Rebuild-, Health- und Evidenzartefakte archivieren.
- Danach stufenweise nach Persona/Workspace erweitern und pro Stufe Counts, Fehler, Receipts, Reconciliation und Alerts prüfen.
- Erst am Ende die Checkboxen in den Phasen 11–15 und der Definition of Done aktualisieren und den Release-Verdict auf `canonical freigegeben` ändern.
- Abschlusskommandos:
  - `pnpm run check`
  - `pnpm run test`
  - `$env:WORLD_MODEL_E2E='true'; pnpm vitest run tests/integration/world-model/`
  - `pnpm run world-model:verify-rls`
  - `pnpm run world-model:reconcile -- --output docs/audits/world-model/reconcile-final.json`
  - `pnpm run world-model:drill -- --scenario all`
  - `pnpm run build`
  - `pnpm run test:e2e:smoke`
  - `CI=1 PLAYWRIGHT_PORT=3011 pnpm run test:e2e:browser`
- Abnahme: Für jede DoD-Zeile existiert ein aktueller Report, ein echter Test sowie ein Restore-/Rollback-Nachweis.

### Traceability der offenen Altplan-Punkte

| Offener Bereich im Altplan                                   | Verbindliches Arbeitspaket |
| ------------------------------------------------------------ | -------------------------- |
| Phase 11: Re-Embedding und Qualitätsmessung                  | R5                         |
| Phase 12: Graph-Backend, Shadow und Recall                   | R6                         |
| Phase 13: Präferenzen, Backfill und Null-Differenz-Reconcile | R3 und R4                  |
| Phase 14: Audit, Präferenzen und factual Recall              | R4                         |
| Phase 15: externe Löschung                                   | R7                         |
| Phase 15: Failure Drills                                     | R8                         |
| Phase 15: Rollout, Canary und Rollback                       | R1 und R8                  |
| DoD: Messages, Szenarien, Tasks, Retrieval und Operations    | R2 bis R9                  |

Die Umsetzung erfolgt strikt in der Reihenfolge R0 → R9. R1–R8 dürfen nur innerhalb eines isolierten Testscopes parallelisiert werden, wenn ihre Evidenz nicht gegenseitig verfälscht wird. R9 wartet auf alle Abhängigkeiten und ist der einzige Schritt, der den Canonical-Cutover freigibt.

## 🎯 Zielbild

### Verbindlicher Datenfluss

```mermaid
flowchart TB
    accTitle: Vollständiger World-Model-Umsetzungsweg
    accDescr: Der Plan führt vom bestehenden Fundament über kanonische Interpretation und proaktive Ausführung bis zum kontrollierten Produktivbetrieb mit abgeleiteten Retrieval- und Graph-Projektionen.

    baseline([📋 Bestehendes Fundament]) --> contracts[📝 Verträge und Invarianten]
    contracts --> schema[💾 Schema und Scope härten]
    schema --> projector[🧠 Kanonisch interpretieren]
    projector --> state[💾 Weltzustand aktualisieren]
    state --> proactive[🔄 Proaktiv ausführen]
    state --> retrieval[🔍 Hybrid abrufen]
    retrieval --> graph[🔗 Graphiti projizieren]
    proactive --> rollout[🚀 Kontrolliert migrieren]
    graph --> rollout
    rollout --> done([✅ Vollständig umgesetzt])

    classDef foundation fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#1e3a5f
    classDef runtime fill:#ede9fe,stroke:#7c3aed,stroke-width:2px,color:#3b0764
    classDef rollout_style fill:#fef9c3,stroke:#ca8a04,stroke-width:2px,color:#713f12
    classDef success fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#14532d

    class baseline,contracts,schema foundation
    class projector,state,proactive,retrieval,graph runtime
    class rollout rollout_style
    class done success
```

### Zielverhalten des Referenzfalls

Für die Aussagen:

1. `Ich gehe um 17 Uhr ins Kino.`
2. `Ich gehe doch nicht ins Kino. Ich gehe Essen.`
3. `Ja, ich war essen. Es war mit Mike.`
4. Eine Woche später: `Was habe ich letzte Woche gemacht?`

muss das System folgende Wahrheit erzeugen:

| Element      | Kanonischer Zustand                                            |
| ------------ | -------------------------------------------------------------- |
| Kino         | `planned → cancelled` mit beiden Quellnachrichten              |
| Essen        | `planned → completed` erst nach Bestätigung                    |
| Mike         | Beteiligte Person mit Evidenz aus der Bestätigung              |
| Rückblick    | Tatsächlich essen gewesen; Kino nur geplant und abgesagt       |
| Unsicherheit | Vor der Bestätigung bleibt Essen `planned`, nicht `completed`  |
| Follow-up    | Nur fragen, wenn das Ergebnis nach Terminende unbekannt bleibt |

### Unverhandelbare Invarianten

| Invariante   | Verbindliche Regel                                                             |
| ------------ | ------------------------------------------------------------------------------ |
| Wahrheit     | Strukturierter Zustand wird ausschließlich über World-Model-Services verändert |
| Historie     | Korrekturen schließen alte Gültigkeit; sie löschen keine Evidenz               |
| Zeit         | `valid_*` beschreibt die Welt, `known_*` den Wissensstand des Systems          |
| Scope        | Jeder Zugriff verwendet `user_id + persona_id + workspace_id`                  |
| Provenienz   | Jede Behauptung und Transition verweist auf mindestens eine Observation        |
| Idempotenz   | Replay derselben Quelle erzeugt keine Duplikate und keine zweite Aktion        |
| Aktionen     | `completed` oder `sent` erfordert ein reales Tool- oder Nutzerergebnis         |
| Retrieval    | Strukturierte aktive Wahrheit schlägt semantische Ähnlichkeit                  |
| Projektionen | Mem0, Graphiti und Embeddings sind vollständig neu aufbaubar                   |
| Proaktivität | Kein Versand ohne erneute Zustands-, Ruhezeit- und Budgetprüfung               |

## 📌 Verbindliche Architekturentscheidungen

### Rollout-Modi statt unabhängiger Booleans

Die bisherigen Schalter werden in einen eindeutigen Modus überführt:

```ts
type WorldModelMode = 'off' | 'shadow' | 'required' | 'canonical';
```

| Modus       | Verhalten                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------- |
| `off`       | Alter Pfad, World Model nicht beteiligt                                                   |
| `shadow`    | World Model wird fail-soft befüllt; Abweichungen werden gemessen                          |
| `required`  | Observation und kanonische Projektion müssen erfolgreich sein; alte Stores bleiben lesbar |
| `canonical` | PostgreSQL ist verbindlich; alte Stores werden ausschließlich aus der Outbox projiziert   |

`WORLD_MODEL_INGESTION_BRIDGE`, `WORLD_MODEL_MEM0_PREFERENCES_ONLY` und ähnliche Einzelschalter bleiben während der Migration kompatibel, werden danach aber durch den Modus und klar benannte Projektionsschalter ersetzt.

### Ein Writer pro Domäne

| Domäne                    | Autoritativer Service                      |
| ------------------------- | ------------------------------------------ |
| Observations              | `ObservationService`                       |
| Assertions                | `AssertionService`                         |
| Events                    | `EventService`                             |
| Entities und Relations    | `EntityService`                            |
| Tasks und Action Attempts | `CanonicalTaskService` und `ActionService` |
| Open Loops                | `OpenLoopService`                          |
| Standing Intents          | `StandingIntentService`                    |

Repositories dürfen keine fachlichen Statusübergänge nachbilden. API-Routen, Knowledge-Ingestion, Tool-Runner und Scheduler verwenden dieselben Services.

### Technologiegrenzen

- PostgreSQL und pgvector bleiben der kanonische Kern.
- Der bestehende Scheduler bleibt zunächst der Taktgeber.
- Outbox und Due-Claims verwenden PostgreSQL-Leases mit `SKIP LOCKED`.
- Graphiti wird als abgeleitete Shadow-Projektion angebunden; aktiver Recall
  bleibt bis zu vollständiger kanonischer Befüllung, Queue-Abschluss und
  bestandenem Recall-Gate gesperrt.
- `pg-boss` wird nur eingeführt, wenn allgemeine Queue-Funktionen außerhalb von Open Loops, Outbox und bestehendem Scheduler benötigt werden.
- Hatchet oder Temporal werden nur eingeführt, wenn Workflows über Deployments hinweg auf externe Ereignisse oder menschliche Freigaben warten und der bestehende Zustandsautomat nicht mehr ausreicht.

## 💾 Kanonische Grundlage und Schreibpfade

### Phase 0: Verträge und Baseline festschreiben

**Ziel:** Vor weiteren Änderungen werden Semantik, Zuständigkeiten und Abnahmeszenarien als ausführbare Verträge fixiert.

**Dateien:**

- Create: `docs/contracts/WORLD_MODEL_AGENT_CONTRACT.md`
- Modify: `docs/contracts/DOMAIN_REGISTRY.json`
- Modify: `docs/MEMORY_SYSTEM.md`
- Modify: `docs/KNOWLEDGE_BASE_SYSTEM.md`
- Modify: `docs/TASKS_SYSTEM.md`
- Modify: `docs/AUTOMATION_SYSTEM.md`
- Create: `tests/fixtures/world-model/secretary-scenarios.ts`

**Arbeiten:**

- [x] Definiere für jede Domäne erlaubte Zustände, Übergänge und Evidenzanforderungen.
- [x] Definiere Ownership zwischen Raw Messages, World Model, Mission Control, SQLite Knowledge, Mem0 und Graphiti.
- [x] Lege die Referenzszenarien Kino/Essen, Termin-Follow-up, Mike-Antwort, E-Mail-Versand und Aufgabenabschluss als Fixtures an.
- [x] Lege fest, welche Aussagen niemals ohne `observed` oder `confirmed` als geschehen ausgegeben werden dürfen.
- [x] Dokumentiere die Rückwärtskompatibilität der bestehenden Task-, Automation- und World-Model-Schnittstellen in der API-/Migrationsmatrix.
- [x] Ergänze die World-Model-Komponenten und Skriptpfade in der Domain Registry.

**Abnahme:**

- Jeder spätere Test kann auf dieselben Szenario-Fixtures zugreifen.
- Keine Domäne besitzt zwei konkurrierende Autoritäten.
- Jede bestehende öffentliche Schnittstelle hat eine dokumentierte Migrationsstrategie.

### Phase 1: Schema, Historie und Mandantenscope härten

**Ziel:** Das Datenmodell trägt echte Historie, identische wiederkehrende Fakten, Workspace-Isolation und sichere Worker-Claims.

**Dateien:**

- Create: `src/server/world-model/migrations/005_scope_history_and_identity.sql`
- Create: `src/server/world-model/migrations/006_rls_and_runtime_roles.sql`
- Modify: `src/server/world-model/types.ts`
- Modify: `src/server/world-model/db.ts`
- Modify: `src/server/world-model/repositories/*`
- Create: `src/server/world-model/scope.ts`
- Create: `tests/integration/world-model/scope-and-history.test.ts`
- Create: `tests/integration/world-model/rls.test.ts`

**Arbeiten:**

- [x] Ergänze `workspace_id` bei Entities, Relations, Action Attempts, Embeddings und allen Outbox-Ereignissen.
- [x] Ergänze stabile `idempotency_key`- oder `external_id`-Spalten bei Events, Tasks, Action Attempts und Projektionen.
- [x] Ersetze globale Assertion-Eindeutigkeit durch eine Regel, die nur gleichzeitig aktive Wahrheiten kollisionsfrei hält und historische Wiederholung erlaubt.
- [x] Ergänze Foreign Keys für `supersedes_*` und `source_observation_id`, wo sie derzeit nur als UUID vorliegen.
- [x] Ergänze `created_by`, `source_authority`, `confidence_reason` und optional `correlation_id` für Audit und Replay.
- [x] Implementiere einen verpflichtenden `WorldModelScope` mit `userId`, `personaId` und `workspaceId`.
- [x] Entferne ungescopte Repository-Lesezugriffe aus produktiven Exporten.
- [x] Aktiviere Row-Level Security für User-/Persona-Zugriffe.
- [x] Trenne App- und Scheduler-Datenbankrolle technisch per Runtime-URL und SQL-Policies; Provisionierung echter Credentials bleibt Rollout-Gate.
- [x] Definiere Lösch- und Retention-Verhalten für alle neuen kanonischen Tabellen.

**Abnahme:**

- Cross-Workspace-Reads liefern unabhängig vom Repository-Aufrufer keine Daten.
- Dieselbe historische Aussage kann nach Ablauf erneut gültig werden.
- Ein Source-Replay verändert weder Historie noch Zähler.
- Der Scheduler kann fällige Arbeit abholen, ohne allgemeine Nutzerabfragen zu umgehen.

### Phase 2: Kanonischen Modus und atomare Schreibgrenze einführen

**Ziel:** Der World-Model-Modus steuert eindeutig, ob ein Schreibfehler toleriert, sichtbar degradiert oder blockiert wird.

**Dateien:**

- Create: `src/server/world-model/mode.ts`
- Create: `src/server/world-model/services/observationService.ts`
- Modify: `src/server/world-model/config.ts`
- Modify: `src/server/world-model/productionGuard.ts`
- Modify: `src/server/world-model/bridge.ts`
- Modify: `src/server/channels/messages/service/*`
- Modify: `.env.local.example`
- Create: `tests/unit/world-model/mode.test.ts`
- Create: `tests/integration/world-model/message-write-boundary.test.ts`

**Arbeiten:**

- [x] Führe `WORLD_MODEL_MODE` mit den Zuständen `off|shadow|required|canonical` ein.
- [x] Mache `ObservationService.record()` zum einzigen produktiven Observation-Writer.
- [x] Verwende Message-ID, Conversation-ID und Sequenz als stabile Source-Identität.
- [x] Schreibe Observation und Outbox atomar in einer PostgreSQL-Transaktion.
- [x] Markiere eine lokal gespeicherte Nachricht sichtbar als `memory_pending`, falls der Required-Modus die Projektion noch nicht bestätigen kann.
- [x] Implementiere einen Reconciliation-Worker, der solche Nachrichten erneut projiziert.
- [x] Verhindere im Canonical-Modus direkte fachliche Writes nach Mem0 oder SQLite Knowledge.
- [x] Stelle sicher, dass ein Timeout nicht zu einer zweiten Observation oder doppelten Tool-Aktion führt.
- [x] Ergänze Health-Status `healthy|degraded|blocked` für den World-Model-Schreibpfad.

**Abnahme:**

- `shadow` lässt Chats weiterlaufen und protokolliert Abweichungen.
- `required` verliert keine zu erinnernde Nachricht und zeigt Pending-Zustände an.
- `canonical` schreibt zuerst PostgreSQL und erzeugt alle Altprojektionen ausschließlich aus der Outbox.

### Phase 3: Semantischen World-Model-Projector bauen

**Ziel:** Extrahierte Fakten, Ereignisse, Entitäten, Beziehungen, Aufgaben und Korrekturen werden in einem normalisierten Befehl atomar in PostgreSQL geschrieben.

**Dateien:**

- Create: `src/server/world-model/projector/types.ts`
- Create: `src/server/world-model/projector/normalizeExtraction.ts`
- Create: `src/server/world-model/projector/projectWindow.ts`
- Create: `src/server/world-model/projector/idempotency.ts`
- Modify: `src/server/knowledge/ingestion/messageProcessor.ts`
- Modify: `src/server/knowledge/ingestion/service.ts`
- Create: `tests/unit/world-model/projector.test.ts`
- Create: `tests/integration/world-model/knowledge-projection.test.ts`

**Arbeiten:**

- [x] Definiere `WorldModelProjection` mit Observations, Assertions, Events, Entities, Relations, Tasks, Open Loops und Confidence.
- [x] Überführe das bestehende Extraction-Ergebnis in diese Struktur, ohne beim Speichern erneut LLM-Ausgaben zu interpretieren.
- [x] Leite alle Artefakt-IDs deterministisch aus Scope, Source-Sequenzen und Inhalt ab.
- [x] Schreibe die gesamte Projektion und ihre Outbox-Ereignisse in einer Transaktion.
- [x] Setze den Ingestion-Checkpoint erst nach kanonischem Commit.
- [x] Erzeuge für zweifelhafte oder mehrdeutige Extraktionen einen Open Loop statt einer erzwungenen Wahrheit.
- [x] Speichere die unveränderte Extraktionsantwort für Audit und späteres Replay.
- [x] Mache Mem0- und SQLite-Schreibfehler nach dem kanonischen Commit zu Projektionsfehlern, nicht zu Ingestion-Blockern.

**Abnahme:**

- Eine Conversation-Window-Wiederholung erzeugt exakt denselben Weltzustand.
- Ein Mem0-Ausfall verhindert keine kanonische Knowledge-Ingestion.
- Jede erzeugte Assertion, jedes Event und jede Aufgabe ist bis zu Message-Sequenzen zurückverfolgbar.

## 🧠 Interpretation, Aufgaben und reale Aktionen

### Phase 4: Ereignisverknüpfung und Korrektursemantik automatisieren

**Ziel:** Natürliche Sprache ruft automatisch die richtigen Event-Transitions auf, ohne Pläne und tatsächliche Ereignisse zu vermischen.

**Dateien:**

- Create: `src/server/world-model/services/eventLinker.ts`
- Create: `src/server/world-model/services/correctionResolver.ts`
- Modify: `src/server/world-model/services/eventService.ts`
- Modify: `src/server/knowledge/correctionDetector.ts`
- Modify: `src/server/knowledge/eventExtractor.ts`
- Create: `tests/integration/world-model/cinema-dinner-language-flow.test.ts`

**Arbeiten:**

- [x] Klassifiziere Ereignisaussagen als Vorschlag, Plan, Änderung, Absage, Verlauf oder Ergebnisbestätigung.
- [x] Suche Kandidaten über Scope, Typ, Beteiligte, Ort, Zeitüberlappung und Conversation-Kontext.
- [x] Verwende deterministische Regeln für eindeutige Treffer und Confidence-basierte Rückfragen bei mehreren Kandidaten.
- [x] Trenne `Ich gehe essen` von `Ich war essen`; nur die zweite Form darf ohne weitere Rückfrage ein Outcome bestätigen.
- [x] Schließe beim Absagen oder Bestätigen automatisch den zugehörigen Event-Outcome-Open-Loop.
- [x] Erzeuge bei einem neuen Ersatzplan ein neues Event und verknüpfe es über `replaces_event_id` oder eine kanonische Relation.
- [x] Speichere Gründe und Source-Observation in jeder Transition.

**Abnahme:**

- Der Kino-/Essen-Fall funktioniert aus echten Chatnachrichten ohne direkte Service-Aufrufe im Test.
- Eine generische Rückfrage unterscheidet `planned`, `cancelled`, `completed` und `no_show`.
- Mehrdeutige Planänderungen erzeugen eine Rückfrage und keine stille Fehlzuordnung.

### Phase 5: Assertions, Entitäten und temporale Beziehungen vervollständigen

**Ziel:** Langfristige Fakten und Beziehungen werden bitemporal, quellengebunden und korrigierbar.

**Dateien:**

- Create: `src/server/world-model/repositories/assertionRepository.ts`
- Create: `src/server/world-model/services/assertionService.ts`
- Create: `src/server/world-model/services/entityService.ts`
- Modify: `src/server/world-model/repositories/entityRepository.ts`
- Modify: `src/server/knowledge/ingestion/entityExtractor.ts`
- Create: `tests/integration/world-model/assertion-history.test.ts`
- Create: `tests/integration/world-model/relation-history.test.ts`

**Arbeiten:**

- [x] Implementiere `assert`, `confirm`, `deny`, `supersede`, `retract` und `expire` als fachliche Operationen.
- [x] Schließe `known_to` der alten Assertion und füge eine neue Assertion hinzu, statt Werte zu überschreiben.
- [x] Verwende Modalität und Source Authority bei Konflikten; Nutzerbestätigung schlägt Inferenz.
- [x] Implementiere Entity Resolution mit Alias, Kategorie, Eigentümer, Scope und expliziter Disambiguation.
- [x] Verhindere automatisches Mergen gleichnamiger Personen ohne ausreichende Evidenz.
- [x] Führe Relationsänderungen mit `valid_*`, `known_*` und `supersedes_relation_id`.
- [x] Erzeuge Open Loops für ungeklärte Referenzen wie `Mike` oder `Christina`.

**Abnahme:**

- Historische Fragen können den damaligen Wissensstand und den heutigen Wissensstand getrennt beantworten.
- Korrigierte Fakten bleiben auditierbar, werden aber nicht als aktuelle Wahrheit retrieved.
- Zwei Personen mit demselben Namen bleiben getrennte Entitäten.

### Phase 6: Mission-Control-Tasks und Tool-Ergebnisse kanonisch anbinden

**Ziel:** Aufgaben und reale Aktionen besitzen einen einzigen Status, eine Transition History und überprüfbare Ergebnisse.

**Dateien:**

- Create: `src/server/world-model/repositories/taskRepository.ts`
- Create: `src/server/world-model/repositories/actionAttemptRepository.ts`
- Create: `src/server/world-model/services/canonicalTaskService.ts`
- Create: `src/server/world-model/services/actionService.ts`
- Modify: `src/server/tasks/taskService.ts`
- Modify: `src/server/tasks/dispatch/*`
- Modify: zentrale E-Mail-, Kalender- und Tool-Ausführungspfade
- Create: `tests/integration/world-model/task-action-lifecycle.test.ts`

**Arbeiten:**

- [x] Ergänze `origin`, `external_task_id`, `request_observation_id` und `completion_evidence_id`.
- [x] Mache den Canonical Task Service zum Statusautomaten für vorgeschlagen, geplant, laufend, wartend, erledigt, fehlgeschlagen und abgebrochen.
- [x] Spiegle bestehende Mission-Control-Aufgaben während der Migration über die Outbox.
- [x] Erzeuge vor jedem kanonisch gebundenen Tool-Aufruf einen idempotenten Action Attempt.
- [x] Speichere Tool-Receipt, Provider-ID, Ziel, Zeitstempel und Ergebnis vor dem Status `succeeded`.
- [x] Trenne E-Mail-Entwurf, Freigabe, Versandversuch und bestätigten Versand im kanonischen Zustandsmodell.
- [x] Verknüpfe aus E-Mails oder Meetings erkannte Action Items mit echten Tasks statt temporären `action-N`-Objekten.
- [x] Erzeuge einen Open Loop, wenn eine Aufgabe auf Nutzerantwort, Freigabe oder externes Ereignis wartet.

**Abnahme:**

- `Schreibe Mike eine E-Mail` ist nicht gleich `E-Mail wurde gesendet`.
- Ein Retry kann denselben externen Seiteneffekt nicht unbemerkt doppelt ausführen.
- Aufgabenstatus ist in Chat, Mission Control, Automation und World Model konsistent.

## 🔄 Proaktive Sekretärin und Prospective Memory

### Phase 7: Open Loops dauerhaft zustellen

**Ziel:** Fällige Rückfragen werden genau einmal, kontextsensitiv und über den richtigen Kanal zugestellt.

**Dateien:**

- Create: `src/server/world-model/runtime/prospectiveRuntime.ts`
- Create: `src/server/world-model/services/openLoopService.ts`
- Create: `src/server/world-model/services/followUpPolicy.ts`
- Modify: `src/server/world-model/repositories/prospectiveRepository.ts`
- Modify: `scheduler.ts`
- Create: `tests/integration/world-model/open-loop-delivery.test.ts`

**Arbeiten:**

- [x] Ergänze Lease-Felder für fällige Open Loops und claime sie mit `FOR UPDATE SKIP LOCKED`.
- [x] Starte den Prospective Runtime Loop im Scheduler mit sauberem Shutdown.
- [x] Prüfe unmittelbar vor Versand Eventstatus, bereits bekannte Antwort, Attempts, Ruhezeit, Kanalverfügbarkeit und Budget.
- [x] Erzeuge eine Outbox-Nachricht `proactive.question.requested` statt direkt im Claim-Prozess zu senden.
- [x] Markiere `asked` erst nach bestätigter Kanalzustellung.
- [x] Implementiere Retry, Backoff, Expiry/DLQ-Sichtbarkeit und manuelle Wiederaufnahme über den Outbox-/Projection-Pfad.
- [x] Storniere Follow-ups automatisch bei Absage, bereits bestätigtem Ergebnis oder gelöschtem Scope.

**Abnahme:**

- Scheduler-Neustart führt weder zum Verlust noch zum Doppelversand einer Rückfrage.
- Ein abgesagter Termin löst keine Ergebnisfrage aus.
- Zustellfehler bleiben sichtbar und wiederholbar.

### Phase 8: Standing Intents und Heartbeat handlungsfähig machen

**Ziel:** Ereignisabhängige Vorhaben lösen eine fachliche Aktion aus; der Heartbeat reconciliert, statt blind Nachrichten zu erzeugen.

**Dateien:**

- Create: `src/server/world-model/services/standingIntentCompiler.ts`
- Modify: `src/server/world-model/services/prospectiveEngine.ts`
- Create: `src/server/world-model/services/standingIntentDispatcher.ts`
- Create: `src/server/world-model/runtime/heartbeatRuntime.ts`
- Modify: `src/server/world-model/outboxDispatcher.ts`
- Create: `tests/integration/world-model/standing-intent-action.test.ts`
- Create: `tests/integration/world-model/heartbeat-reconciliation.test.ts`

**Arbeiten:**

- [x] Übersetze Aussagen wie `Wenn Mike antwortet, erinnere mich an das Angebot` in einen validierten Standing Intent.
- [x] Nutze strukturierte Triggerfelder; Textbegriffe bleiben nur ein Signal, nicht der einzige Matcher.
- [x] Erzeuge beim Match eine idempotente Intent-Fire-Entität und eine konkrete Folgeaktion.
- [x] Erhöhe `fire_count` erst innerhalb derselben Transaktion wie die Folgeaktion.
- [x] Respektiere Cooldown, Expiry, Max Fires, Channel-, Sender-, Subject- und Workspace-Scope.
- [x] Starte den Heartbeat als separaten Reconciliation-Takt.
- [x] Lasse den Heartbeat verpasste Due-Claims, hängende Action Attempts, überfällige Tasks und unbeantwortete Open Loops prüfen.
- [x] Lasse ihn still bleiben, wenn keine relevante Aktion vorliegt.

**Abnahme:**

- Eine Mike-Antwort löst genau eine Erinnerung oder Aufgabe aus.
- Derselbe eingehende Webhook kann beliebig oft replayt werden, ohne mehrfach zu feuern.
- Heartbeat-Ausfälle beeinträchtigen exakte Follow-up-Zeitpunkte nicht dauerhaft.

### Phase 9: Antwortkorrelation, Rückfragen und Benachrichtigungspolitik schließen

**Ziel:** Nutzerantworten werden sicher dem richtigen Open Loop, Event, Task oder Intent zugeordnet.

**Dateien:**

- Create: `src/server/world-model/services/responseCorrelationService.ts`
- Create: `src/server/world-model/services/clarificationService.ts`
- Create: `src/server/world-model/services/notificationPolicy.ts`
- Modify: zentrale eingehende Channel-Handler
- Modify: zentrale ausgehende Channel-Handler
- Create: `tests/integration/world-model/follow-up-response-correlation.test.ts`

**Arbeiten:**

- [x] Übertrage verfügbare `openLoopId`, `eventId`, `taskId` und `intentFireId`-Korrelationsdaten als Zustellmetadaten.
- [x] Nutze Thread-/Conversation-Bezug und Antwortzeitfenster als deterministische Sekundärsignale.
- [x] Verwende ein Modell nur bei verbleibender Mehrdeutigkeit und speichere dessen Confidence.
- [x] Frage nach, wenn mehrere offene Fragen zur Antwort passen.
- [x] Speichere jede Antwort zuerst als Observation und aktualisiere danach Event, Task, Assertions und Open Loop atomar.
- [x] Implementiere Ruhezeiten, Dringlichkeitsstufen, tägliches Notification Budget, Kanalpräferenzen und Snooze.
- [x] Verhindere proaktive Nachrichten bei laufender Nutzerinteraktion, wenn eine stille Kontextanreicherung genügt.

**Abnahme:**

- `Ja, ich war dort` wird dem richtigen zuvor gestellten Termin-Follow-up zugeordnet.
- Mehrdeutige Antworten verändern keinen Weltzustand ohne Klärung.
- Notification Budget und Ruhezeiten gelten kanalübergreifend.

## 🔍 Retrieval, pgvector, Graphiti und Konsolidierung

### Phase 10: Temporalen Query Planner und strukturiertes Retrieval vervollständigen

**Ziel:** Freie Fragen werden in strukturierte Zeit-, Status-, Entitäts- und Aufgabenkriterien übersetzt.

**Dateien:**

- Create: `src/server/world-model/retrieval/queryPlanner.ts`
- Create: `src/server/world-model/retrieval/assertions.ts`
- Create: `src/server/world-model/retrieval/tasks.ts`
- Create: `src/server/world-model/retrieval/relations.ts`
- Modify: `src/server/world-model/retrieval/structured.ts`
- Modify: `src/server/world-model/retrieval/index.ts`
- Modify: `src/server/channels/messages/service/recall/index.ts`
- Create: `tests/integration/world-model/temporal-retrieval.test.ts`

**Arbeiten:**

- [x] Verwende den bestehenden Knowledge Query Planner dort wieder, wo Zeit- und Entitätsauflösung bereits funktionieren.
- [x] Parse Zeiträume wie heute, gestern, letzte Woche, vor sechs Monaten und zwischen zwei Terminen.
- [x] Parse Intent wie `was gemacht`, `was geplant`, `was abgesagt`, `wer war dabei`, `was ist offen` und `was habe ich versprochen`.
- [x] Suche Events, Assertions, Tasks, Relations und Open Loops gemeinsam, aber mit typisierten Resultaten.
- [x] Liefere bei Rückblickfragen tatsächliche Ereignisse zuerst und abgesagte Pläne als klar getrennten Kontext.
- [x] Unterstütze `as_of_valid_time` und `as_of_known_time` für historische Fragen.
- [x] Scopiere jede Query auf User, Persona und Workspace.
- [x] Gib Evidenz-IDs und Confidence an den Prompt weiter.

**Abnahme:**

- `Was habe ich letzte Woche gemacht?` findet Essen, nennt das abgesagte Kino nur als früheren Plan und erfindet keinen Besuch.
- `Was wusste ich am Montag?` unterscheidet damaliges Wissen von späteren Korrekturen.
- Generische Fragen benötigen keinen exakten Eventtitel.

### Phase 11: pgvector und Hybrid Ranking produktiv machen

**Ziel:** Semantische Suche ergänzt strukturierte Wahrheit, ohne veraltete oder falsche Zustände hochzuranken.

**Dateien:**

- Create: `src/server/world-model/embeddings/embeddingWorker.ts`
- Create: `src/server/world-model/embeddings/embeddingText.ts`
- Create: `src/server/world-model/retrieval/vector.ts`
- Create: `src/server/world-model/retrieval/hybridRanker.ts`
- Create: `src/server/world-model/migrations/007_embeddings_indexes.sql`
- Modify: `src/server/world-model/outboxDispatcher.ts`
- Create: `tests/integration/world-model/hybrid-retrieval.test.ts`

**Arbeiten:**

- [x] Definiere ein versioniertes Embedding-Format für Assertions, Events, Tasks, Entitäten und Episodenzusammenfassungen.
- [x] Erzeuge Embeddings asynchron aus der Outbox.
- [x] Speichere Modell, Modellversion, Text-Hash und Projektion-Version.
- [x] Re-embedde gezielt bei Modellwechsel oder geändertem aktiven Zustand.
- [x] Ergänze passende HNSW-Indizes und scope-freundliche Filterstrategie.
- [x] Implementiere Ranking: strukturierter Treffer vor Volltext, Volltext vor Vector, aktuelle Wahrheit vor historischer Ähnlichkeit.
- [x] Unterdrücke superseded, retracted, cancelled oder nicht zum Query-Intent passende Resultate.
- [x] Messe Recall-Qualität, Latenz und Tokenkosten mit festen Szenarien. Der
      Live-Provider-Benchmark ist in `docs/audits/world-model/embedding-benchmark-live.json`
      dokumentiert; eine vollständige produktionsnahe Qualitätsgrenze bleibt offen.

**Abnahme:**

- Semantisch ähnliche, aber widerrufene Fakten überschreiben keine aktive Wahrheit.
- Embeddings können vollständig aus PostgreSQL neu aufgebaut werden.
- Ein Embedding-Ausfall beeinträchtigt strukturierte Antworten nicht.

### Phase 12: Graphiti real anbinden und sichere Konsolidierung ergänzen

**Ziel:** Graphiti verbessert mehrstufige Beziehungsfragen; Dreaming/Konsolidierung erzeugt abgeleitete Langzeitkontexte ohne Wahrheit zu überschreiben.

**Dateien:**

- Create: `src/server/world-model/graphiti/client.ts`
- Create: `src/server/world-model/graphiti/projector.ts`
- Create: `src/server/world-model/graphiti/rebuild.ts`
- Create: `src/server/world-model/graphiti/evaluator.ts`
- Create: `src/server/world-model/consolidation/service.ts`
- Create: `src/server/world-model/consolidation/policy.ts`
- Modify: `docker-compose.postgres.yml` oder Create: separates Graph-Compose
- Modify: `src/server/world-model/outboxDispatcher.ts`
- Create: `tests/integration/world-model/graphiti-shadow-comparison.test.ts`

**Arbeiten:**

- [x] Wähle und dokumentiere ein unterstütztes Graphiti-Backend für die Betriebsumgebung.
- [x] Implementiere authentifizierten Client, Timeouts, Circuit Breaker und Health Check.
- [x] Projiziere ausschließlich aus kanonischen Outbox-Ereignissen.
- [x] Mappe User, Persona und Workspace auf getrennte Graph-Segmente.
- [x] Übertrage gültige Zeit, ungültige Zeit, Source Observation und Confidence.
- [x] Implementiere vollständigen Rebuild aus PostgreSQL mit Checkpoint und Resume.
- [~] Betreibe Graphiti zunächst im Shadow Mode und vergleiche Live-Treffer
  gegen strukturierte Wahrheit. Der lokale Message/Search/Clear-Lauf, drei
  semantische historische Rebuilds und der maschinenlesbare Drift-/Recallreport
  sind nachgewiesen; die Qualitätswerte bleiben unter der Aktivierungsschwelle.
- [ ] Aktiviere Graphiti im Recall erst nach bestandenem historischem Rebuild,
      Driftreport und dokumentierter Recall-Schwelle.
- [x] Implementiere Konsolidierung als neue abgeleitete Summary/Preference mit Quellmenge und Version.
- [x] Verbiete Konsolidierung, Events oder bestätigte Fakten direkt zu überschreiben.

**Abnahme:**

- Verlust des Graph-Backends ist durch vollständigen Rebuild behebbar.
- Graphiti-Ausfall führt zu kontrolliertem Fallback auf PostgreSQL.
- Konsolidierte Erinnerungen sind bis zu ihren Observations zurückverfolgbar und widerrufbar.

## 🚀 Datenmigration, Betrieb und kontrollierter Rollout

### Phase 13: Backfill und Reconciliation implementieren

**Ziel:** Historische Nachrichten, SQLite Knowledge, bestehende Tasks und Mem0-Fakten werden reproduzierbar und auditierbar in das World Model überführt.

**Dateien:**

- Create: `scripts/world-model-backfill.ts`
- Create: `scripts/world-model-reconcile.ts`
- Create: `scripts/world-model-rebuild-projections.ts`
- Create: `src/server/world-model/backfill/*`
- Modify: `package.json`
- Create: `tests/integration/world-model/backfill.test.ts`

**Arbeiten:**

- [x] Unterstütze `--dry-run`, Scope-Filter, Batchgröße und Resume-Checkpoint; Zeitraum-/Rate-Limit-Abnahme bleibt offen.
- [x] Importiere zuerst Raw Messages als Observations.
- [x] Re-projiziere danach strukturierte Knowledge-Artefakte mit stabilen Source-IDs.
- [x] Importiere Tasks und Tool-Ergebnisse mit Origin-Verweis.
- [~] Importiere Mem0-Präferenzen getrennt von faktischen Memories. Der
  Canonical-Factual-Guard ist aktiv und vier bekannte lokale Scopes sind
  auditiert; ein providerweites Inventar und die Präferenzmigration sind offen.
- [x] Markiere nicht eindeutig zuordenbare Fakten als `inferred` oder offene Klärung, nicht als bestätigt.
- [x] Vergleiche Anzahl, Scope, Hashes, aktive Fakten, Eventstatus und offene Aufgaben zwischen Alt- und Neusystem.
- [x] Erzeuge einen maschinenlesbaren Abweichungsreport.
- [x] Erlaube gefahrloses Wiederholen des gesamten Backfills über stabile Checkpoints und Idempotenzschlüssel.

**Abnahme:**

- Zwei vollständige Backfill-Läufe erzeugen denselben kanonischen Zustand.
- Jede importierte Zeile hat eine Quelle und eine Backfill-Version.
- Ungeklärte Konflikte sind sichtbar und blockieren den Canonical-Cutover des betroffenen Scopes.

### Phase 14: Mem0 reduzieren und Altprojektionen entkoppeln

**Ziel:** Mem0 speichert nur Präferenzen, Stil und Gewohnheiten oder wird vollständig entfernt; SQLite Knowledge wird read-only und später archiviert.

**Dateien:**

- Modify: `src/server/world-model/mem0Policy.ts`
- Modify: `src/server/memory/operations/recall.ts`
- Modify: `src/server/knowledge/ingestion/*`
- Modify: `src/server/channels/messages/service/recall/index.ts`
- Create: `scripts/mem0-factual-memory-audit.ts`
- Create: `tests/integration/world-model/mem0-demotion.test.ts`

**Arbeiten:**

- [x] Stoppe im Canonical-Modus direkte Fakt-, Event- und Task-Writes nach Mem0.
- [x] Erlaube nur versionierte Memory-Typen `preference`, `avoidance`, `personality_trait` und `workflow_pattern`.
- [x] Entferne faktischen Mem0-Recall aus Antworten, sobald World-Model-Parität erreicht ist.
- [ ] Prüfe den vollständigen Mem0-Bestand und migriere nur belegte
      Präferenzen auf realen Bestandsdaten. Der aktuelle Audit deckt nur vier
      bekannte lokale Scopes ab.
- [x] Mache SQLite Knowledge zur abgeleiteten Kompatibilitätsprojektion.
- [x] Entferne diese Projektion erst nach dokumentierter UI-/API-Migration und Exportmöglichkeit.
- [x] Definiere Backout: World Model bleibt erhalten; nur die Recall-Quellenreihenfolge kann zurückgeschaltet werden.

**Abnahme:**

- Ein Mem0-Ausfall verhindert weder Fakt-Ingestion noch faktischen Recall.
- Keine aktuelle Antwort verwendet einen faktischen Mem0-Treffer als verbindliche Wahrheit.
- Nutzerpräferenzen bleiben erhalten und sind scope-sicher abrufbar.

### Phase 15: Observability, Datenschutz und Produktiv-Cutover abschließen

**Ziel:** Betrieb, Sicherheit, Datenschutz, Canary und Rollback sind vor vollständiger Aktivierung nachgewiesen.

**Dateien:**

- Modify: `app/api/control-plane/metrics/route.ts`
- Modify: `app/api/health/scheduler/route.ts`
- Create: `app/api/health/world-model/route.ts`
- Create: `src/server/world-model/metrics.ts`
- Create: `src/server/world-model/dataLifecycle.ts`
- Modify: `docs/runbooks/WORLD_MODEL_ROLLOUT.md`
- Create: `docs/runbooks/WORLD_MODEL_INCIDENTS.md`
- Create: `scripts/world-model-failure-drill.ts`

**Arbeiten:**

- [x] Metriken: Ingestion Lag, Pending Observations, Projection Lag, Outbox Age, Dead Letters, Due Loops, Duplicate Suppression, Retrieval Source, Graphiti Drift und Backfill Progress.
- [x] Health Gates: PostgreSQL, Migration-Version, Scheduler Lease, Outbox, Embeddings und optional Graphiti.
- [x] Alerting: zu alte Outbox, wachsende Pending-Menge, wiederholte Scope-Verstöße, Follow-up-Zustellfehler und Reconciliation Drift.
- [x] Implementiere Export, Löschung und Retention über World Model und alle kanonischen Projektionstabellen.
- [~] Lösche Graphiti-, Embedding- und Mem0-Projektionen bei Nutzer-/Persona-
  Löschung scoped und idempotent. Der Codepfad und der lokale Graphiti-
  Clear-Lauf sind geprüft; ein vollständiger externer Provider-Nachweis bleibt
  offen.
- [x] Dokumentiere Backup, Restore, Graph-Rebuild, Embedding-Rebuild, Backfill-Resume und Rollback.
- [x] Führe die fünf Failure-Drills mit gezielter lokaler Fehler-Injektion
      durch. 5/5 bestehen; der Scheduler-Fall verwendet eine unabhängige
      Child-Process-Grenze und prüft Lease-Recovery nach TTL.
- [ ] Rolle `off → shadow → required → canonical` über Testscope,
      Persona-Allowlist und Workspace aus; lokale Konfiguration allein ist keine
      Canary-/Rollback-Abnahme.
- [~] Mem0-Factual-Writes und -Recall sind im Canonical-Modus blockiert;
  Preferences-only ist für die vier bekannten lokalen Scopes geprüft, aber
  die vollständige Bestandsparität und Migration sind offen.

**Cutover-Gates:**

1. Shadow-Abweichungen sind erklärt oder behoben.
2. Backfill und Reconciliation sind für den Scope vollständig.
3. Alle Sekretärinnen-Szenarien bestehen auf kanonischen Daten.
4. Follow-ups werden nach Neustart exakt einmal zugestellt.
5. Rollback und Projection-Rebuild wurden praktisch durchgeführt.
6. Erst danach wird `WORLD_MODEL_MODE=canonical` gesetzt.

## ✅ Verifikation und Definition of Done

### Testpyramide pro Phase

Jede Phase folgt derselben Reihenfolge:

1. Fachliche Unit-Tests für Zustände und Policies.
2. Repository-Integration gegen echtes PostgreSQL/pgvector.
3. Service-Integration mit Transaktion, Outbox und Replay.
4. Ende-zu-Ende-Szenario über den echten Chat-/Channel-Pfad.
5. Failure Injection für Retry, Restart und Abhängigkeitenausfall.
6. Vollständige Repository-Gates vor Cutover.

### Verbindliche Szenario-Suite

| Szenario                       | Erwartetes Ergebnis                                           |
| ------------------------------ | ------------------------------------------------------------- |
| Kino wird durch Essen ersetzt  | Kino abgesagt, Essen geplant und später bestätigt             |
| Termin ohne Ergebnis           | Eine Stunde später genau eine kontextsensitive Frage          |
| Termin vorher abgesagt         | Keine Ergebnisfrage                                           |
| Mike antwortet                 | Standing Intent löst genau eine Folgeaktion aus               |
| Zwei Personen namens Christina | Rückfrage statt falscher Zuordnung                            |
| E-Mail nur entwerfen           | Kein Versandstatus und kein externer Seiteneffekt             |
| E-Mail senden mit Retry        | Höchstens ein Versand, Receipt als Evidenz                    |
| Aufgabe erledigt gemeldet      | Transition nur mit zugeordneter Observation                   |
| Rückblick letzte Woche         | Tatsächliche Events zuerst, abgesagte Pläne separat           |
| Späte Korrektur                | Heutige Wahrheit und damaliger Wissensstand bleiben abfragbar |
| Workspace-Wechsel              | Keine Daten aus anderem Workspace                             |
| Graphiti-Ausfall               | PostgreSQL-Retrieval bleibt funktionsfähig                    |
| Mem0-Ausfall                   | Faktische Ingestion und Antworten bleiben funktionsfähig      |
| Scheduler-Neustart             | Keine verlorenen oder doppelten Follow-ups                    |

### Qualitäts- und Betriebsgrenzen

- Null ungeklärte Cross-Scope-Treffer.
- Null doppelte Seiteneffekte bei identischem Idempotency Key.
- Jede ausgegebene strukturierte Tatsache besitzt Provenienz.
- Kein `completed`, `sent` oder `attended` ohne bestätigende Evidenz.
- Alle Projektionen sind aus PostgreSQL reproduzierbar.
- Canonical-Modus besitzt dokumentierten und geübten Backout.
- Proaktive Nachrichten respektieren Ruhezeiten, Budget und Kanalpräferenz.
- Retrieval weist Unsicherheit aus, statt fehlende Evidenz zu erfinden.

### Vollständige Validierung vor Abschluss

```powershell
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run check
pnpm run build
pnpm run test:e2e:smoke
pnpm run test:e2e:browser
```

Zusätzlich müssen die Live-PostgreSQL-Integration, Backfill-/Reconciliation-Drills und die vollständige Sekretärinnen-Szenario-Suite ausgeführt werden. Ein grüner Unit-Test allein ist kein Cutover-Nachweis.

### Definition of Done

Die vollständige Umsetzung ist erst abgeschlossen, wenn:

- [~] PostgreSQL läuft lokal im Zielscope im Modus `canonical`; die vollständige
  Produktivfreigabe steht wegen der offenen R2/R4/R6/R7/R8-Gates aus.
- [~] Relevante lokale Dev-Live-Messages wurden als Observations und
  strukturierte Projektionen verarbeitet; ein vollständiger ruhiger
  Produktionsbestand ist nicht abgenommen.
- [~] Die Szenario-/World-Model-Integration ist grün, aber die echte
  Channel-/Extractor-E2E ohne direkte Projector-Ersatzaufrufe bleibt offen.
- [x] Open Loops und Nutzerantworten werden im kanonischen Servicepfad
      korreliert und geschlossen.
- [x] Mission-Control-Tasks und Tool-Ergebnisse verwenden denselben lokalen
      kanonischen Zustand.
- [x] Temporale und generische Rückblickfragen sind im Retrievalpfad umgesetzt;
      vollständige historische Antwortqualität bleibt ein Mess-Gate.
- [x] pgvector ist mit echten Provider-Embeddings befüllt und im Live-Benchmark
      gemessen; die vollständige produktionsnahe Qualitätsmessung bleibt offen.
- [~] Graphiti ist lokal real erreichbar und scoped live geprüft; semantische
  historische Rebuilds und der Driftreport sind belegt. Queue-Abschluss,
  Provider-Output-Limit und Recall-Aktivierung bleiben offen.
- [x] Mem0 liefert im Canonical-Modus keine faktische Wahrheit mehr; ein
      providerweites Bestandsinventar bleibt offen.
- [x] Backfill und All-Scope-Reconcile sind nachgewiesen; der aktuelle
      Snapshot liefert 697/697 Observations, 759/759 Embeddings und 0 Pending-/
      Outbox-Rückstände. Externe Export-/Lösch-/Restore-Nachweise bleiben offen.
- [~] Monitoring, Alerting-Code, Runbooks und 5/5 lokale Failure Drills sind
  vorhanden; echter Prozess-Restart, Canary, Rollback und externe Alerting-
  Integration bleiben offen.
- [x] Alle lokalen fokussierten und vollständigen Repository-/Build-/Smoke-/Browser-Qualitätsgates bestanden haben.
- [x] Die Altpfade ausdrücklich als zeitlich begrenzte Kompatibilitätsprojektionen dokumentiert sind.

Die mit `[ ]` markierten Punkte erfordern reale Produktionsdaten, Provider-Credentials,
externe Infrastruktur oder Live-Abnahmen und sind durch lokale Code-/Testqualität
allein nicht erfüllbar. Sie werden durch die Arbeitspakete R3–R9 adressiert.

### Interne Referenzen

- [Zielarchitektur für Memory, Knowledge und proaktive Personas](../memory-knowledge-target-architecture.md)
- [World-Model-Rollout](../runbooks/WORLD_MODEL_ROLLOUT.md)
- [Memory-System](../MEMORY_SYSTEM.md)
- [Knowledge-Base-System](../KNOWLEDGE_BASE_SYSTEM.md)
- [Task-System](../TASKS_SYSTEM.md)
- [Automation-System](../AUTOMATION_SYSTEM.md)

_Dieser Plan ist ein aktives Arbeitsdokument. Abgeschlossene Arbeitspakete werden mit Evidenz, Commit und Verifikationsstatus markiert; fachliche Änderungen werden versioniert statt still überschrieben._
