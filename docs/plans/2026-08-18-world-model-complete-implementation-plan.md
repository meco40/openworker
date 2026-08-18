# Vollständiger Umsetzungsplan für Memory, Knowledge und proaktive Personas

_Arbeitsplan für die vollständige Zielarchitektur der persönlichen 24-Stunden-Sekretärin · Stand 2026-08-18_

---

## 📋 Überblick

Dieser Plan schließt die Lücke zwischen dem bereits implementierten World-Model-Fundament und einer tatsächlich mitdenkenden, langfristig erinnernden und proaktiv handelnden Persona. Er baut auf der [Zielarchitektur](../memory-knowledge-target-architecture.md) und dem aktuellen [World-Model-Runbook](../runbooks/WORLD_MODEL_ROLLOUT.md) auf.

> 📌 **Kernziel:** PostgreSQL wird nicht nur konzeptionell, sondern im realen Nachrichten-, Knowledge-, Task-, Tool- und Proaktivitätsfluss die verbindliche Wahrheit. Mem0, SQLite Knowledge, pgvector und Graphiti sind danach kontrollierte Projektionen oder spezialisierte Retrieval-Schichten.

### Ausgangspunkt

| Bereich      | Bereits vorhanden                                     | Noch nicht vollständig                                  |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------- |
| PostgreSQL   | Schema, Migrationen, Transaktionen, Outbox            | Kanonischer Produktivmodus und vollständige Writer      |
| Ereignisse   | Statusmodell, Transition History, Kino-/Essen-Service | Automatische Interpretation natürlicher Sprache         |
| Fakten       | Bitemporale Assertion-Tabelle                         | Assertion-Writer, Konfliktauflösung und Backfill        |
| Aufgaben     | Tabellen für Tasks, Transitions und Action Attempts   | Verbindung mit Mission Control und Tool-Ausführung      |
| Proaktivität | Open Loops, Standing Intents, Matching-Funktionen     | Scheduler, Zustellung, Antwortkorrelation und Heartbeat |
| Retrieval    | World-Model-Priorität und PostgreSQL-Volltext         | Temporale Query-Planung, Embeddings und Hybrid Ranking  |
| Graph        | Lokales Shadow-Ledger                                 | Reale Graphiti-Projektion und Qualitätsvergleich        |
| Mem0         | Preferences-only-Schalter                             | Aktivierte Migration und Entfernung faktischer Wahrheit |
| Betrieb      | PostgreSQL-Compose, Guards und Runbook                | Backfill, Reconciliation, Metriken, Canary und Rollback |

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
- Graphiti wird erst nach vollständiger kanonischer Befüllung real angebunden.
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

- [ ] Definiere für jede Domäne erlaubte Zustände, Übergänge und Evidenzanforderungen.
- [ ] Definiere Ownership zwischen Raw Messages, World Model, Mission Control, SQLite Knowledge, Mem0 und Graphiti.
- [ ] Lege die Referenzszenarien Kino/Essen, Termin-Follow-up, Mike-Antwort, E-Mail-Versand und Aufgabenabschluss als Fixtures an.
- [ ] Lege fest, welche Aussagen niemals ohne `observed` oder `confirmed` als geschehen ausgegeben werden dürfen.
- [ ] Dokumentiere die Rückwärtskompatibilität aller bestehenden APIs und UI-Flächen.
- [ ] Ergänze alle neuen Dateien in der Domain Registry.

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

- [ ] Ergänze `workspace_id` bei Entities, Relations, Action Attempts, Embeddings und allen Outbox-Ereignissen.
- [ ] Ergänze stabile `idempotency_key`- oder `external_id`-Spalten bei Events, Tasks, Action Attempts und Projektionen.
- [ ] Ersetze globale Assertion-Eindeutigkeit durch eine Regel, die nur gleichzeitig aktive Wahrheiten kollisionsfrei hält und historische Wiederholung erlaubt.
- [ ] Ergänze Foreign Keys für `supersedes_*` und `source_observation_id`, wo sie derzeit nur als UUID vorliegen.
- [ ] Ergänze `created_by`, `source_authority`, `confidence_reason` und optional `correlation_id` für Audit und Replay.
- [ ] Implementiere einen verpflichtenden `WorldModelScope` mit `userId`, `personaId` und `workspaceId`.
- [ ] Entferne ungescopte Repository-Lesezugriffe aus produktiven Exporten.
- [ ] Aktiviere Row-Level Security für User-/Persona-Zugriffe.
- [ ] Trenne App- und Scheduler-Datenbankrolle; der Worker erhält nur die für Due-Claims und Projektionen nötigen Rechte.
- [ ] Definiere Lösch- und Retention-Verhalten für alle neuen Tabellen.

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

- [ ] Führe `WORLD_MODEL_MODE` mit den Zuständen `off|shadow|required|canonical` ein.
- [ ] Mache `ObservationService.record()` zum einzigen produktiven Observation-Writer.
- [ ] Verwende Message-ID, Conversation-ID und Sequenz als stabile Source-Identität.
- [ ] Schreibe Observation und Outbox atomar in einer PostgreSQL-Transaktion.
- [ ] Markiere eine lokal gespeicherte Nachricht sichtbar als `memory_pending`, falls der Required-Modus die Projektion noch nicht bestätigen kann.
- [ ] Implementiere einen Reconciliation-Worker, der solche Nachrichten erneut projiziert.
- [ ] Verhindere im Canonical-Modus direkte fachliche Writes nach Mem0 oder SQLite Knowledge.
- [ ] Stelle sicher, dass ein Timeout nicht zu einer zweiten Observation oder doppelten Tool-Aktion führt.
- [ ] Ergänze Health-Status `healthy|degraded|blocked` für den World-Model-Schreibpfad.

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

- [ ] Definiere `WorldModelProjection` mit Observations, Assertions, Events, Entities, Relations, Tasks, Open Loops und Confidence.
- [ ] Überführe das bestehende Extraction-Ergebnis in diese Struktur, ohne beim Speichern erneut LLM-Ausgaben zu interpretieren.
- [ ] Leite alle Artefakt-IDs deterministisch aus Scope, Source-Sequenzen und Inhalt ab.
- [ ] Schreibe die gesamte Projektion und ihre Outbox-Ereignisse in einer Transaktion.
- [ ] Setze den Ingestion-Checkpoint erst nach kanonischem Commit.
- [ ] Erzeuge für zweifelhafte oder mehrdeutige Extraktionen einen Open Loop statt einer erzwungenen Wahrheit.
- [ ] Speichere die unveränderte Extraktionsantwort für Audit und späteres Replay.
- [ ] Mache Mem0- und SQLite-Schreibfehler nach dem kanonischen Commit zu Projektionsfehlern, nicht zu Ingestion-Blockern.

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

- [ ] Klassifiziere Ereignisaussagen als Vorschlag, Plan, Änderung, Absage, Verlauf oder Ergebnisbestätigung.
- [ ] Suche Kandidaten über Scope, Typ, Beteiligte, Ort, Zeitüberlappung und Conversation-Kontext.
- [ ] Verwende deterministische Regeln für eindeutige Treffer und Confidence-basierte Rückfragen bei mehreren Kandidaten.
- [ ] Trenne `Ich gehe essen` von `Ich war essen`; nur die zweite Form darf ohne weitere Rückfrage ein Outcome bestätigen.
- [ ] Schließe beim Absagen oder Bestätigen automatisch den zugehörigen Event-Outcome-Open-Loop.
- [ ] Erzeuge bei einem neuen Ersatzplan ein neues Event und verknüpfe es über `replaces_event_id` oder eine kanonische Relation.
- [ ] Speichere Gründe und Source-Observation in jeder Transition.

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

- [ ] Implementiere `assert`, `confirm`, `deny`, `supersede`, `retract` und `expire` als fachliche Operationen.
- [ ] Schließe `known_to` der alten Assertion und füge eine neue Assertion hinzu, statt Werte zu überschreiben.
- [ ] Verwende Modalität und Source Authority bei Konflikten; Nutzerbestätigung schlägt Inferenz.
- [ ] Implementiere Entity Resolution mit Alias, Kategorie, Eigentümer, Scope und expliziter Disambiguation.
- [ ] Verhindere automatisches Mergen gleichnamiger Personen ohne ausreichende Evidenz.
- [ ] Führe Relationsänderungen mit `valid_*`, `known_*` und `supersedes_relation_id`.
- [ ] Erzeuge Open Loops für ungeklärte Referenzen wie `Mike` oder `Christina`.

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

- [ ] Ergänze `origin`, `external_task_id`, `request_observation_id` und `completion_evidence_id`.
- [ ] Mache den Canonical Task Service zum Statusautomaten für vorgeschlagen, geplant, laufend, wartend, erledigt, fehlgeschlagen und abgebrochen.
- [ ] Spiegle bestehende Mission-Control-Aufgaben während der Migration über die Outbox.
- [ ] Erzeuge vor jedem Tool-Aufruf einen idempotenten Action Attempt.
- [ ] Speichere Tool-Receipt, Provider-ID, Ziel, Zeitstempel und Ergebnis vor dem Status `succeeded`.
- [ ] Trenne E-Mail-Entwurf, Freigabe, Versandversuch und bestätigten Versand.
- [ ] Verknüpfe aus E-Mails oder Meetings erkannte Action Items mit echten Tasks statt temporären `action-N`-Objekten.
- [ ] Erzeuge einen Open Loop, wenn eine Aufgabe auf Nutzerantwort, Freigabe oder externes Ereignis wartet.

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

- [ ] Ergänze Lease-Felder für fällige Open Loops und claime sie mit `FOR UPDATE SKIP LOCKED`.
- [ ] Starte den Prospective Runtime Loop im Scheduler mit sauberem Shutdown.
- [ ] Prüfe unmittelbar vor Versand Eventstatus, bereits bekannte Antwort, Attempts, Ruhezeit, Kanalverfügbarkeit und Budget.
- [ ] Erzeuge eine Outbox-Nachricht `proactive.question.requested` statt direkt im Claim-Prozess zu senden.
- [ ] Markiere `asked` erst nach bestätigter Kanalzustellung.
- [ ] Implementiere Retry, Backoff, Dead Letter und manuelle Wiederaufnahme.
- [ ] Storniere Follow-ups automatisch bei Absage, bereits bestätigtem Ergebnis oder gelöschtem Scope.

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

- [ ] Übersetze Aussagen wie `Wenn Mike antwortet, erinnere mich an das Angebot` in einen validierten Standing Intent.
- [ ] Nutze strukturierte Triggerfelder; Textbegriffe bleiben nur ein Signal, nicht der einzige Matcher.
- [ ] Erzeuge beim Match eine idempotente Intent-Fire-Entität und eine konkrete Folgeaktion.
- [ ] Erhöhe `fire_count` erst innerhalb derselben Transaktion wie die Folgeaktion.
- [ ] Respektiere Cooldown, Expiry, Max Fires, Channel-, Sender-, Subject- und Workspace-Scope.
- [ ] Starte den Heartbeat als separaten Reconciliation-Takt.
- [ ] Lasse den Heartbeat verpasste Due-Claims, hängende Action Attempts, überfällige Tasks und unbeantwortete Open Loops prüfen.
- [ ] Lasse ihn still bleiben, wenn keine relevante Aktion vorliegt.

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

- [ ] Übertrage `openLoopId`, `eventId`, `taskId` und `intentFireId` als unsichtbare Zustellmetadaten, soweit der Kanal dies unterstützt.
- [ ] Nutze Thread-/Conversation-Bezug und Antwortzeitfenster als deterministische Sekundärsignale.
- [ ] Verwende ein Modell nur bei verbleibender Mehrdeutigkeit und speichere dessen Confidence.
- [ ] Frage nach, wenn mehrere offene Fragen zur Antwort passen.
- [ ] Speichere jede Antwort zuerst als Observation und aktualisiere danach Event, Task, Assertions und Open Loop atomar.
- [ ] Implementiere Ruhezeiten, Dringlichkeitsstufen, tägliches Notification Budget, Kanalpräferenzen und Snooze.
- [ ] Verhindere proaktive Nachrichten bei laufender Nutzerinteraktion, wenn eine stille Kontextanreicherung genügt.

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

- [ ] Verwende den bestehenden Knowledge Query Planner dort wieder, wo Zeit- und Entitätsauflösung bereits funktionieren.
- [ ] Parse Zeiträume wie heute, gestern, letzte Woche, vor sechs Monaten und zwischen zwei Terminen.
- [ ] Parse Intent wie `was gemacht`, `was geplant`, `was abgesagt`, `wer war dabei`, `was ist offen` und `was habe ich versprochen`.
- [ ] Suche Events, Assertions, Tasks, Relations und Open Loops gemeinsam, aber mit typisierten Resultaten.
- [ ] Liefere bei Rückblickfragen tatsächliche Ereignisse zuerst und abgesagte Pläne als klar getrennten Kontext.
- [ ] Unterstütze `as_of_valid_time` und `as_of_known_time` für historische Fragen.
- [ ] Scopiere jede Query auf User, Persona und Workspace.
- [ ] Gib Evidenz-IDs und Confidence an den Prompt weiter.

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

- [ ] Definiere ein versioniertes Embedding-Format für Assertions, Events, Tasks, Entitäten und Episodenzusammenfassungen.
- [ ] Erzeuge Embeddings asynchron aus der Outbox.
- [ ] Speichere Modell, Modellversion, Text-Hash und Projektion-Version.
- [ ] Re-embedde gezielt bei Modellwechsel oder geändertem aktiven Zustand.
- [ ] Ergänze passende HNSW-Indizes und scope-freundliche Filterstrategie.
- [ ] Implementiere Ranking: strukturierter Treffer vor Volltext, Volltext vor Vector, aktuelle Wahrheit vor historischer Ähnlichkeit.
- [ ] Unterdrücke superseded, retracted, cancelled oder nicht zum Query-Intent passende Resultate.
- [ ] Messe Recall-Qualität, Latenz und Tokenkosten mit festen Szenarien.

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

- [ ] Wähle und dokumentiere ein unterstütztes Graphiti-Backend für die Betriebsumgebung.
- [ ] Implementiere authentifizierten Client, Timeouts, Circuit Breaker und Health Check.
- [ ] Projiziere ausschließlich aus kanonischen Outbox-Ereignissen.
- [ ] Mappe User, Persona und Workspace auf getrennte Graph-Segmente.
- [ ] Übertrage gültige Zeit, ungültige Zeit, Source Observation und Confidence.
- [ ] Implementiere vollständigen Rebuild aus PostgreSQL mit Checkpoint und Resume.
- [ ] Betreibe Graphiti zuerst im Shadow Mode und vergleiche Treffer gegen strukturierte/pgvector-Antworten.
- [ ] Aktiviere Graphiti im Recall nur bei nachgewiesenem Mehrwert für mehrstufige Beziehungsfragen.
- [ ] Implementiere Konsolidierung als neue abgeleitete Summary/Preference mit Quellmenge und Version.
- [ ] Verbiete Konsolidierung, Events oder bestätigte Fakten direkt zu überschreiben.

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

- [ ] Unterstütze `--dry-run`, Scope-Filter, Zeitraum, Batchgröße, Resume-Checkpoint und Rate Limit.
- [ ] Importiere zuerst Raw Messages als Observations.
- [ ] Re-projiziere danach strukturierte Knowledge-Artefakte mit stabilen Source-IDs.
- [ ] Importiere Tasks und Tool-Ergebnisse mit Origin-Verweis.
- [ ] Importiere Mem0-Präferenzen getrennt von faktischen Memories.
- [ ] Markiere nicht eindeutig zuordenbare Fakten als `inferred` oder offene Klärung, nicht als bestätigt.
- [ ] Vergleiche Anzahl, Scope, Hashes, aktive Fakten, Eventstatus und offene Aufgaben zwischen Alt- und Neusystem.
- [ ] Erzeuge einen maschinenlesbaren Abweichungsreport.
- [ ] Erlaube gefahrloses Wiederholen des gesamten Backfills.

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

- [ ] Stoppe im Canonical-Modus direkte Fakt-, Event- und Task-Writes nach Mem0.
- [ ] Erlaube nur versionierte Memory-Typen `preference`, `avoidance`, `personality_trait` und `workflow_pattern`.
- [ ] Entferne faktischen Mem0-Recall aus Antworten, sobald World-Model-Parität erreicht ist.
- [ ] Prüfe bestehende Mem0-Daten und migriere nur belegte Präferenzen.
- [ ] Mache SQLite Knowledge zur abgeleiteten Kompatibilitätsprojektion.
- [ ] Entferne diese Projektion erst nach dokumentierter UI-/API-Migration und Exportmöglichkeit.
- [ ] Definiere Backout: World Model bleibt erhalten; nur die Recall-Quellenreihenfolge kann zurückgeschaltet werden.

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

- [ ] Metriken: Ingestion Lag, Pending Observations, Projection Lag, Outbox Age, Dead Letters, Due Loops, Duplicate Suppression, Retrieval Source, Graphiti Drift und Backfill Progress.
- [ ] Health Gates: PostgreSQL, Migration-Version, Scheduler Lease, Outbox, Embeddings und optional Graphiti.
- [ ] Alerting: zu alte Outbox, wachsende Pending-Menge, wiederholte Scope-Verstöße, Follow-up-Zustellfehler und Reconciliation Drift.
- [ ] Implementiere Export, Löschung und Retention über World Model und alle Projektionen.
- [ ] Lösche Graphiti-, Embedding- und Mem0-Projektionen bei Nutzer-/Persona-Löschung idempotent.
- [ ] Dokumentiere Backup, Restore, Graph-Rebuild, Embedding-Rebuild, Backfill-Resume und Rollback.
- [ ] Führe Failure Drills für PostgreSQL-Ausfall, Scheduler-Neustart, Graphiti-Ausfall, Embedder-Ausfall und doppelten Webhook durch.
- [ ] Rolle `off → shadow → required → canonical` zuerst für Testscope, dann Persona-Allowlist, dann pro Workspace aus.
- [ ] Aktiviere Mem0 Preferences-only erst nach erfolgreicher Canonical-Parität.

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

- [ ] PostgreSQL im Zielscope tatsächlich im Modus `canonical` läuft.
- [ ] Jede relevante Nachricht als Observation und strukturierte Projektion verarbeitet wird.
- [ ] Kino-/Essen-, Termin-, E-Mail-, Aufgaben- und Standing-Intent-Szenarien Ende-zu-Ende funktionieren.
- [ ] Open Loops und Nutzerantworten automatisch korreliert und geschlossen werden.
- [ ] Mission-Control-Tasks und Tool-Ergebnisse denselben kanonischen Zustand verwenden.
- [ ] Temporale und generische Rückblickfragen ohne exakten Titel funktionieren.
- [ ] pgvector produktiv befüllt und im Hybrid Retrieval gemessen wird.
- [ ] Graphiti real angebunden, im Shadow Mode evaluiert und vollständig rebuildbar ist.
- [ ] Mem0 keine faktische Wahrheit mehr liefert.
- [ ] Backfill, Reconciliation, Export, Löschung und Retention nachgewiesen sind.
- [ ] Monitoring, Alerting, Failure Drills, Rollback und Runbooks vollständig sind.
- [ ] Alle fokussierten und vollständigen Qualitätsgates bestanden haben.
- [ ] Die Altpfade entweder entfernt oder ausdrücklich als zeitlich begrenzte Kompatibilitätsprojektion dokumentiert sind.

### Interne Referenzen

- [Zielarchitektur für Memory, Knowledge und proaktive Personas](../memory-knowledge-target-architecture.md)
- [World-Model-Rollout](../runbooks/WORLD_MODEL_ROLLOUT.md)
- [Memory-System](../MEMORY_SYSTEM.md)
- [Knowledge-Base-System](../KNOWLEDGE_BASE_SYSTEM.md)
- [Task-System](../TASKS_SYSTEM.md)
- [Automation-System](../AUTOMATION_SYSTEM.md)

_Dieser Plan ist ein aktives Arbeitsdokument. Abgeschlossene Arbeitspakete werden mit Evidenz, Commit und Verifikationsstatus markiert; fachliche Änderungen werden versioniert statt still überschrieben._
