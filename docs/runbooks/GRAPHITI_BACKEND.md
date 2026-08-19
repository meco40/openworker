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
- Der semantische historische Rebuild wurde für alle drei bekannten lokalen
  Scopes mit Batchgröße 25 ausgeführt. Graphiti nimmt die Jobs per `202
Accepted` asynchron an; Queue-Abschluss und Recall werden deshalb getrennt
  vom PostgreSQL-Rebuildreport bewertet. Die letzten Provider-Logs zeigen
  `Output length exceeded max tokens 8192` und keinen belegten vollständigen
  Queue-Abschluss. Rohe Observations bleiben deshalb standardmäßig deaktiviert.
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

## Konfiguration

```env
GRAPHITI_BASE_URL=http://127.0.0.1:8001
GRAPHITI_SHADOW_ENABLED=true
GRAPHITI_PROJECTOR_ENABLED=false
GRAPHITI_TIMEOUT_MS=10000
GRAPHITI_MAX_RETRIES=2
GRAPHITI_MAX_MESSAGE_CHARS=1200
```

Der Compose-Stack verlangt `GRAPHITI_OPENAI_API_KEY` zur Laufzeit. Secrets
werden ausschließlich über die Umgebung injiziert und nicht in Repo, Plan oder
Report geschrieben. Modell und Embedding-Modell sind über
`GRAPHITI_MODEL_NAME` und `GRAPHITI_EMBEDDING_MODEL_NAME` überschreibbar.

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
