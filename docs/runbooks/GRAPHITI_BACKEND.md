# Supported Graphiti Backend & Operating Guide

## Betriebsgrenze

Graphiti ist ausschließlich eine abgeleitete, scoped Shadow-Projektion für
mehrstufige Beziehungsfragen. PostgreSQL bleibt mit strukturiertem Retrieval
und pgvector das System of Record. Graphiti darf niemals kanonische Fakten,
Events, Tasks oder bestätigte Zustände überschreiben.

Der lokal verifizierte Stand vom 2026-08-20 ist:

- Healthcheck, Message, Search und scoped Clear funktionieren gegen den lokalen
  Stack.
- `GRAPHITI_PROJECTOR_ENABLED=false` bleibt aktiv, bis der historische Async-
  Queue-Abschluss und das Recall-/Precision-Gate abgenommen sind.
- Der Ingest-Queue-Worker der gepinnten `zepai/graphiti`-Version verarbeitete
  Nachrichten seriell mit genau einem Worker-Task, und ein einziger nicht
  abgefangener Fehler in `add_episode` (z. B. ein LLM-Fehler) beendete diesen
  Worker-Task endgültig, ohne die Warteschlange weiter zu leeren. Der
  gemountete Patch `docker/graphiti/ingest.py` behebt beides: `QUEUE_WORKERS`
  (Default 4) parallele Worker statt einem, und fehlgeschlagene Episoden
  werden geloggt und übersprungen statt den Worker stillzulegen.
- Historischer Blocker (2026-08-20, inzwischen gelöst): Die gepinnte
  `graphiti_core`-Version fragt für die Relation-/Dedup-Extraktion
  (`extract_edges`) intern fest `max_tokens=16384` an — dieser Wert ist im
  installierten Paket hartkodiert und wird von `GRAPHITI_LLM_MAX_TOKENS`
  _nicht_ beeinflusst (das Env-Var wirkt nur als Default für Aufrufe ohne
  expliziten Override, z. B. Entitäts-Extraktion). Der damals verwendete
  OpenRouter-Schlüssel lehnte diese Anfragen mit HTTP 402 ab
  ("requested up to 16384 tokens, but can only afford ~14.463"), unabhängig
  von Modellwahl oder Retry-Anzahl; ein voller Rebuild erzeugte dadurch 82
  Entitätsknoten, aber **0 Kanten** (97 Warteschlangen-Jobs, 93 mit HTTP 402
  fehlgeschlagen). Beleg: `docs/audits/world-model/graphiti-queue-completion-current.json`.
  **Gelöst durch den Wechsel auf Alibaba DashScope** (OpenAI-kompatibler
  Endpunkt, LLM `qwen-plus`, Embedding `text-embedding-v4`); die
  dortige Free-Tier-Alternative auf OpenRouter (`z-ai/glm-5.2:free`,
  `nvidia/nemotron-3.5-lightning:free`) scheiterte am account-weiten
  Free-Tageskontingent von 1.000 Requests/Tag (429, `X-RateLimit-Remaining: 0`).
- Der aktuelle Drift-/Recallreport ist
  `docs/audits/world-model/graphiti-recall-drift-current.json`. Er hält die
  Aktivierung derzeit korrekt auf `shadow`, wenn die Trefferqualität unter
  der Schwelle von 0,90 für Recall oder Precision liegt.
- Der Evaluator empfiehlt nur bei erreichbarem Backend und ausreichender
  Trefferqualität `enable`; sonst bleibt der Zustand `shadow` oder `fallback`.

## Unterstützter lokaler Stack

| Komponente      | Version / Konfiguration                                | Zweck                               |
| --------------- | ------------------------------------------------------ | ----------------------------------- |
| Graph-Datenbank | Neo4j Community `5.26.2`                               | Property-Graph                      |
| Graph-Engine    | offizielles `zepai/graphiti`-Image, per Digest gepinnt | temporale Extraktion und Suche      |
| API             | Container intern `8000`, lokal `http://127.0.0.1:8001` | Health, Messages, Search, Clear     |
| Projektion      | OpenClaw Outbox-Worker                                 | asynchrone Ableitung aus PostgreSQL |

Die exakte Image-Referenz, Ports und Volumes stehen in
`docker-compose.graphiti.yml`. Der Stack verwendet getrennte lokale Neo4j-
Volumes mit Suffix `-526`; sie werden bei einem Container-Neustart nicht
gelöscht.

## Ollama-Lifecycle der lokalen App

Der normale lokale Start `pnpm run dev` lädt `.env.local`, startet vor Web und
Scheduler genau einen von der App verwalteten Ollama-Server und stellt sicher,
dass `OLLAMA_MODEL` (Standard `qwen3:8b`) vorhanden ist. Mit
`OLLAMA_LIFECYCLE_EXCLUSIVE=true` übernimmt der Dev-Stack den konfigurierten
Ollama-Port; ein dort laufender Ollama-`serve`-Prozess wird beim App-Start
beendet und durch den App-eigenen Prozess ersetzt. Beim App-Exit werden Web,
Scheduler und Ollama gemeinsam beendet. Das Modell bleibt als lokaler
Festplattenbestand installiert, verursacht außerhalb der laufenden App aber
keinen Ollama-Prozess und keine Inferenz.

Die Lifecycle-Schalter sind `OLLAMA_LIFECYCLE_ENABLED`,
`OLLAMA_LIFECYCLE_EXCLUSIVE`, `OLLAMA_MODEL`, `OLLAMA_HOST`,
`OLLAMA_NUM_PARALLEL`, `OLLAMA_CONTEXT_LENGTH` und `OLLAMA_KEEP_ALIVE`. Beim
Start führt der Dev-Stack zusätzlich eine minimale lokale Warm-up-Inferenz mit
`keep_alive=-1` aus und prüft `/api/ps`; dadurch ist der GPU-/CPU-Anteil des
Modells bereits vor der ersten Graphiti-Anfrage sichtbar. Beim externen
Graphiti-LLM kann der Lifecycle mit `OLLAMA_LIFECYCLE_ENABLED=false` deaktiviert
werden.

## Konfiguration

```env
GRAPHITI_BASE_URL=http://127.0.0.1:8001
GRAPHITI_SHADOW_ENABLED=true
GRAPHITI_PROJECTOR_ENABLED=false
GRAPHITI_TIMEOUT_MS=10000
GRAPHITI_MAX_RETRIES=2
GRAPHITI_MAX_MESSAGE_CHARS=1200
GRAPHITI_LLM_MAX_TOKENS=16384
GRAPHITI_QUEUE_WORKERS=1
GRAPHITI_SEMAPHORE_LIMIT=1
GRAPHITI_OPENAI_BASE_URL=http://host.docker.internal:11434/v1
GRAPHITI_EMBEDDING_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
GRAPHITI_MODEL_NAME=qwen3:8b
GRAPHITI_SMALL_MODEL_NAME=qwen3:8b
GRAPHITI_EMBEDDING_MODEL_NAME=text-embedding-v4
GRAPHITI_EMBEDDING_DIM=2048
GRAPHITI_SEARCH_CANDIDATES=20
GRAPHITI_SEARCH_RESULTS=5
GRAPHITI_QUERY_VARIANTS=3
```

Der Compose-Stack verlangt `GRAPHITI_OPENAI_API_KEY` zur Laufzeit. Secrets
werden ausschließlich über die Umgebung injiziert und nicht in Repo, Plan oder
Report geschrieben. Modell und Embedding-Modell sind über
`GRAPHITI_MODEL_NAME` und `GRAPHITI_EMBEDDING_MODEL_NAME` überschreibbar. Der
gemountete Server-Patch baut den OpenAI-kompatiblen Embedder mit diesem Modell
und `GRAPHITI_EMBEDDING_DIM` tatsächlich auf; die Variable wird nicht nur als
Dokumentationswert weitergereicht.

**Provider-Stand 2026-08-20:** Der aktuelle Graphiti-LLM-Zweig läuft lokal über
Ollama mit `qwen3:8b` auf der GTX 1080. Der Embedding-Zweig bleibt absichtlich
getrennt und nutzt DashScope `text-embedding-v4` mit 2048 Dimensionen. Der
frühere DashScope-LLM-Stand `qwen-plus` bleibt als verifizierter Fallback
dokumentiert. Der Wegzug von OpenRouter war notwendig, weil der hinterlegte
Schlüssel 16k-Token-Anfragen kostenpflichtiger Modelle mit HTTP 402 ablehnte
und das account-weite Free-Tageskontingent erschöpft war.

Die Endpunkte sind absichtlich getrennt:
`GRAPHITI_OPENAI_BASE_URL=http://host.docker.internal:11434/v1` und
`GRAPHITI_MODEL_NAME=qwen3:8b` zeigen auf Ollama, während
`GRAPHITI_EMBEDDING_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
das bestehende `text-embedding-v4` mit 2048 Dimensionen beibehält. Der lokale
Qwen-Adapter setzt über die OpenAI-kompatible API
`reasoning_effort=none`, weil Qwen3 sonst seine Thinking-Tokens für die
Graphiti-Extraktion verbraucht. Für die GTX 1080 werden
`GRAPHITI_SEMAPHORE_LIMIT=1` und `GRAPHITI_QUEUE_WORKERS=1` empfohlen.

Zwei providerbedingte Patch-Pflichten sind zu beachten:

- `graphiti_core` nutzt für kleine Unteraufgaben ein „small model" mit dem
  Upstream-Default `gpt-4.1-nano`, das auf Nicht-OpenAI-Providern mit 404
  scheitert. Der Patch verdrahtet `SMALL_MODEL_NAME`
  (`GRAPHITI_SMALL_MODEL_NAME`; leer = gleiches Modell wie `MODEL_NAME`).
- DashScope `text-embedding-v4` lehnt Embedding-Batches mit mehr als 10
  Einträgen ab (HTTP 400); der Embedder im Patch teilt Batches deshalb in
  Chunks von maximal 10.

`text-embedding-v4` liefert 2048 Dimensionen, passend zum bestehenden
`EMBEDDING_DIM=2048`. Da es sich um einen anderen Embedding-Raum als das
frühere Nemotron-Modell handelt, wurde der Graph nach der Umstellung aus
PostgreSQL scopeweise neu aufgebaut; ein bloßer Container-Neustart reicht dafür
nicht.

`GRAPHITI_LLM_MAX_TOKENS` (Compose-Variable, im Container `MAX_TOKENS`) setzt
das Ausgabe-Token-Budget für LLM-Aufrufe, die keinen eigenen Override
mitgeben (z. B. Entitäts-Extraktion). Der lokale Graphiti-Server-Patch
mountet dafür `docker/graphiti/config.py` und `docker/graphiti/zep_graphiti.py`
read-only über die gepinnte Server-Version und verdrahtet die Variable in
den LLM-Client. `GRAPHITI_QUEUE_WORKERS` (Container `QUEUE_WORKERS`, Default 4) steuert, wie viele Episoden die Ingest-Warteschlange parallel statt
seriell verarbeitet; verdrahtet über den gemounteten
`docker/graphiti/ingest.py`-Patch, der zugleich sicherstellt, dass eine
fehlgeschlagene Episode den betroffenen Worker nicht dauerhaft stilllegt
(Upstream-Fehler: der Worker-Loop fing keine Exceptions ab).

Für das Retrieval werden pro Anfrage bis zu 20 Graphiti-Kandidaten geladen,
anschließend lokal dedupliziert und auf fünf Ergebnisse gerankt. Bis zu drei
gebundene Query-Varianten machen kanonische Namen, Prädikate und bekannte
Entity-Aliase für Graphitis semantische und lexikalische Suchpfade sichtbar.
Die Parameter sind über `GRAPHITI_SEARCH_CANDIDATES`,
`GRAPHITI_SEARCH_RESULTS` und `GRAPHITI_QUERY_VARIANTS` begrenzbar. Die
Qualitätsmessung validiert die Top-k-Ergebnisse weiterhin gegen PostgreSQL und
berichtet zusätzlich Recall@k, Precision@k, MRR sowie — wenn der gepatchte
REST-Response die UUIDs liefert — Provenienztreffer.

Für die 8-GB-GPU sind ein Queue-Worker und ein paralleler LLM-Aufruf der
belastbare Standard. Bei einem stärkeren lokalen oder externen Provider kann
beides nach einem neuen Benchmark erhöht werden. Die Queue meldet
abgeschlossene und fehlgeschlagene Episoden über `/queue-status`; ein Rebuild
wird erst nach leerer Queue und ohne neue Fehljobs als erfolgreich bezeichnet.

**Wichtige Einschränkung:** Die pinned `graphiti_core`-Version fragt für die
Relation-/Dedup-Extraktion (`extract_edges`) intern fest `max_tokens=16384`
an — dieser Wert ist im Paket hartkodiert (`edge_operations.py`) und wird von
`GRAPHITI_LLM_MAX_TOKENS` **nicht** beeinflusst. Für diesen konkreten Aufruf
lässt sich das Budget also nur durch einen zusätzlichen Bibliothekspatch
ändern, nicht per Umgebungsvariable.

Für die Extraktion wird aktuell `qwen3:8b` über Ollama verwendet; der Wert ist
in `.env.local` explizit gesetzt. Historischer Verlauf der Modellwahl:
`qwen-plus` über DashScope war stabil, `gpt-4.1-mini` ließ einzelne
Relation-/Dedup-Prompts auch mit einem 32k-Budget unvollständig; der
OpenRouter-Schlüssel lehnte danach `gpt-4o-mini`-Anfragen mit 16k-Budget per
HTTP 402 (Spend-Limit) ab; das Free-Modell `z-ai/glm-5.2:free` scheiterte am
account-weiten Free-Tageskontingent (1.000 Requests/Tag, 429); auf DashScope
war `deepseek-v4-flash-0731` schnell, erschöpfte aber mitten im Rebuild seine
modellbezogene Free-Quote (HTTP 403 „free quota has been exhausted", 53 von 93
Episoden verarbeitet). `GRAPHITI_LLM_MAX_TOKENS=16384` bleibt das
Ausgabe-Token-Budget. Bekannte Beobachtung zu den Reasoning-Modellen
(`deepseek-v4-*`): Reasoning-Tokens zählen in dieses Budget mit, und
`deepseek-v4-flash-0731` entglitt in einer von drei strict-`json_schema`-Proben
(dem Modus, den `graphiti_core` per `beta.chat.completions.parse` nutzt) in
eine Zero-Width-Space-Wiederholung bis zum Token-Limit. Die Retry-Logik von
graphiti_core fängt Parse-Fehler auf; anhaltende `Output length exceeded`-
oder Parse-Fehler im Container-Log sind ein Signal für einen Modellwechsel
(`deepseek-v4-pro-0813` war in der Probe ebenfalls stabil).

Der vollständig dokumentierte 402-Blocker des OpenRouter-Schlüssels
(vollständiger Rebuild-Lauf am 2026-08-20, 93 von 97 Warteschlangen-Jobs mit
HTTP 402 `"requested up to 16384 tokens, but can only afford ~14.463"`
fehlgeschlagen, 82 Entitätsknoten ohne Kanten) ist durch den Provider-Wechsel
auf DashScope aufgelöst. Rebuild-Reports weisen Fehleranzahl und betroffene
Stufe pro Scope aus, statt einen unvollständigen Lauf stillschweigend als
Erfolg zu werten.

## Scope- und Group-Strategie

Graphiti akzeptiert in der verwendeten Version keine beliebigen
`user:persona:workspace`-Strings als Group-ID. OpenClaw bildet den vollständigen
Scope deshalb deterministisch auf eine sichere ID ab:

```text
openclaw-<sha256(userId + NUL + personaId + NUL + workspaceId)[:32]>
```

Die ursprünglichen Scope-Werte bleiben Bestandteil jedes kanonischen Outbox-
Events und werden nicht durch diese technische Group-ID ersetzt. Die Bildung
ist in `src/server/world-model/graphiti/client.ts` zentralisiert und wird von
Projector und Löschpfad gemeinsam verwendet.

Für die kompatible lokale Graphiti-Version wird bei `add_episode` keine
explizite UUID gesendet: Graphiti behandelt diese UUID sonst als vorhandenen
Node. Die lokale Message-Mapping-Logik sendet Name, Content, Role, Role-Type,
Timestamp und Source-Description.

## Betriebsmodi

1. **Shadow:** kanonische Outbox-Events werden gespiegelt; PostgreSQL bleibt die
   Antwortquelle.
2. **Evaluation:** `evaluator.ts` fragt Graphiti live ab und vergleicht die
   Treffer mit aktiven strukturierten Zielen. Nicht erreichbare oder qualitativ
   unzureichende Treffer führen zu `fallback`/`shadow`.
3. **Aktiver Multi-Hop-Recall:** erst nach historischem Rebuild, Driftreport,
   festen Qualitätsgrenzen und dokumentiertem Rollback aktivieren.

Bei Graphiti- oder Neo4j-Ausfall greift der Circuit Breaker. Strukturierter
PostgreSQL-/pgvector-Recall bleibt verfügbar; ein Graphiti-Ausfall darf keinen
kanonischen Write blockieren.

## Start, Status und Logs

```powershell
docker compose -f docker-compose.graphiti.yml up -d
docker compose -f docker-compose.graphiti.yml ps
docker compose -f docker-compose.graphiti.yml logs --tail=200 graphiti
```

Vor einem historischen Lauf zunächst einen Dry-Run/Scope festlegen. Keine
globalen Lösch- oder Truncate-Befehle verwenden. Nach jedem Lauf Healthcheck,
Outbox-Pending, Graphiti-Queue, Fehler und Scope prüfen.

## Rebuild, Resume und Löschung

```powershell
pnpm run world-model:rebuild-projections -- --type graphiti --scope <user:persona:workspace> --batch-size 25 --output docs/audits/world-model/rebuild-current-graphiti-semantic.json
# Nur bei ausreichender Provider-Kapazität: zusätzlich rohe Chat-Observations senden.
pnpm run world-model:rebuild-projections -- --type graphiti --scope <user:persona:workspace> --include-observations
pnpm run world-model:graphiti-evaluate -- --scope all --output docs/audits/world-model/graphiti-recall-drift-current.json
```

Der Standard-Rebuild projiziert die semantischen kanonischen Aggregatdaten
(Assertions, Events und Relations). Rohe Chat-Observations werden nur mit
`--include-observations` zusätzlich gesendet, weil Graphiti sie intern als
einzelne LLM-Jobs verarbeitet und ein gesamter Scope sonst das Provider-
Kontextlimit überschreiten kann. Der Rebuild läuft chunkweise, resumierbar und
auf einem benannten Scope. Der Rebuildreport bestätigt die Verarbeitung aus
PostgreSQL; der Recallreport ist
die separate Aktivierungsentscheidung. Die Persona-Löschung ruft bei aktiviertem Graphiti-Backend
`clearGraphitiScope` vor dem finalen Persona-Delete auf; scheitert dieser
externe Schritt, wird die Löschung zum Schutz vor verwaisten PII-Daten
abgebrochen.

## Verifikation

Der aktuelle echte lokale Smoke-Nachweis ist:

```powershell
$env:WORLD_MODEL_E2E='true'
$env:GRAPHITI_E2E='true'
pnpm exec vitest run tests/integration/world-model/graphiti-shadow-comparison.test.ts
```

Dieser Lauf prüft einen echten lokalen Message/Search/Clear-Zyklus. Er ersetzt
nicht den offenen historischen Rebuild-, Drift-, Provider- oder Produktions-
Canary-Nachweis.

Bei Datenverlust oder Korruption darf der Graph ausschließlich aus dem
kanonischen PostgreSQL-Bestand neu aufgebaut werden. Nachweis und Rollback
werden erst als abgeschlossen markiert, wenn die offenen Gates im aktuellen
World-Model-Plan erfüllt sind.
