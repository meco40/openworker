# Knowledge Base System

## Metadata

- Purpose: Verbindliche Referenz fuer internen Knowledge-Layer und Ingestion-Pipeline.
- Scope: Episode-Ingestion, Ledger-Persistenz, Retrieval, Runtime-Loop, Token-Budgeting.
- Source of Truth: This is the active system documentation for this domain and overrides archived documents on conflicts.
- Last Reviewed: 2026-02-21
- Related Runbooks: N/A

---

## 1. Funktionserläuterung

Der Knowledge-Layer erweitert den Chat um strukturierte Wissensartefakte aus Konversationsfenstern. Er arbeitet intern und wird über Feature-Flags gesteuert.

### Kernkonzepte

- **Episode Ingestion**: Verdichtung neuer Gesprächsfenster in strukturierte Wissenseinträge
- **Ledger Entries**: Langfristige, zusammengefasste Wissensbausteine
- **Retrieval Service**: Kontext-Rückgabe für den Chat-Prompt
- **Runtime Loop**: Periodische Ingestion über Cursor
- **Token Budget**: Begrenzung der Kontextgröße

---

## 2. Architektur

### 2.1 Komponenten

- `src/server/knowledge/config.ts` - Flags und Limits
- `src/server/knowledge/runtime.ts` - Runtime-Wiring
- `src/server/knowledge/runtimeLoop.ts` - Ingestion-Loop
- `src/server/knowledge/ingestionService.ts` - Ingestion-Orchestrierung
- `src/server/knowledge/ingestionCursor.ts` - Cursor-Verwaltung
- `src/server/knowledge/retrievalService.ts` - Recall/Ranking
- `src/server/knowledge/queryPlanner.ts` - Query-Planung
- `src/server/knowledge/extractor.ts` - Modellgestützte Extraktion
- `src/server/knowledge/sqliteKnowledgeRepository.ts` - Persistenz

### 2.2 Laufzeitintegration

Die Hauptintegration erfolgt intern im Chat-/Memory-Flow:

- Ingestion-Trigger: `MessageService.maybeStoreKnowledgeArtifacts(...)`
- Retrieval-Trigger: `MessageService.buildRecallContext(...)`
- Runtime Loop Start/Stop: `startKnowledgeRuntimeLoop()` / `stopKnowledgeRuntimeLoop()`

Zusaetzlich existiert eine dedizierte Read-API fuer Graph-Visualisierung:

- `GET /api/knowledge/graph` (mit `personaId`, optional `limit`, `edgeLimit`)

---

## 3. Konfiguration

Quelle: `src/server/knowledge/config.ts`

| Variable                       | Standard | Beschreibung                          |
| ------------------------------ | -------- | ------------------------------------- |
| `KNOWLEDGE_LAYER_ENABLED`      | `false`  | Hauptschalter für Knowledge-Layer     |
| `KNOWLEDGE_LEDGER_ENABLED`     | `false`  | Ledger-Ingestion aktiv                |
| `KNOWLEDGE_EPISODE_ENABLED`    | `false`  | Episode-Ingestion aktiv               |
| `KNOWLEDGE_RETRIEVAL_ENABLED`  | `false`  | Retrieval im Abruf aktiv              |
| `KNOWLEDGE_MAX_CONTEXT_TOKENS` | `4000`   | Kontextlimit (Clamp 200..8000)        |
| `KNOWLEDGE_INGEST_INTERVAL_MS` | `600000` | Loop-Intervall (Clamp 60000..3600000) |

---

## 4. API-Umfang

Aktive Knowledge-Route im Code:

| Methode | Pfad                   | Zweck                                                         |
| ------- | ---------------------- | ------------------------------------------------------------- |
| GET     | `/api/knowledge/graph` | Persona-spezifischen Entity-Graph (Nodes/Edges/Stats) abrufen |

Die Ingestion- und Retrieval-Logik bleibt ansonsten intern und wird nicht als CRUD-HTTP-API exponiert.

---

## 5. Verifikation

```bash
npm run test -- tests/unit/knowledge
npm run test -- tests/integration/knowledge
npm run typecheck
npm run lint
```

---

## 6. Siehe auch

- `docs/MEMORY_SYSTEM.md`
- `docs/SESSION_MANAGEMENT.md`
- `docs/API_REFERENCE.md`
- `docs/archive/plans/completed/2026-02-12-knowledge-base-agent-access-implementation.md`
