# Memory System

## Metadata

- Purpose: Verbindliche Referenz fuer den Memory-Layer und dessen Betriebsverhalten.
- Scope: Memory-Erfassung, Recall, Feedback-Learning, Versionierung und API-Anbindung.
- Source of Truth: This is the active system documentation for this domain and overrides archived documents on conflicts.
- Last Reviewed: 2026-08-20
- Related Runbooks: N/A

---

## 1. Funktionserläuterung

Das Memory-System liefert persona-, user- und workspace-skopierten Langzeitkontext. PostgreSQL/pgvector im World Model ist kanonisch; Speicherung, Recall, Feedback-Lernen und Versionierung laufen über `MemoryService` mit `PostgresMemoryClient`. Das bestehende Mem0-förmige Interface bleibt nur aus Kompatibilitätsgründen erhalten.

### Kernkonzepte

- **Memory Node**: Eintrag mit `type`, `content`, `importance`, `confidence` und Metadaten
- **Memory Type**: `fact`, `preference`, `avoidance`, `lesson`, `personality_trait`, `workflow_pattern`
- **Recall**: Relevante Nodes per PostgreSQL/pgvector-Score + Volltext-Fallback; Mem0 ist nur ein expliziter Legacy-Provider
- **Feedback Learning**: Positive/negative Rückmeldung verändert Confidence/Importance
- **Versionierung**: Optimistische Updates via `expectedVersion`

---

## 2. Architektur

### 2.1 Komponenten

- `core/memory/types.ts` - zentrale Typdefinitionen
- `src/server/memory/service.ts` - Business-Logik
- `src/server/memory/postgresMemoryClient.ts` / `src/server/memory/mem0/` / `src/server/memory/sqliteMemoryClient.ts` - Provider-Adapter
- `src/server/memory/runtime.ts` - Runtime-Wiring + Produktions-Guards
- `src/server/memory/userScope.ts` - User-/Channel-Scope-Auflösung
- `app/api/memory/route.ts` - HTTP-Schnittstelle

### 2.2 Produktions-Guardrails

Im kanonischen `production`-Betrieb erzwingt der Runtime-Check:

- `MEMORY_PROVIDER=postgres`
- `WORLD_MODEL_MODE=canonical`
- erreichbares kanonisches PostgreSQL mit den World-Model-Runtime-Rollen

Mem0 kann nur durch eine ausdrückliche Legacy-Konfiguration aktiviert werden;
SQLite bleibt ein scope-gebundener Offline-Fallback. Beide Adapter
implementieren denselben Service-Vertrag, sind aber nicht kanonisch.

---

## 3. Funktionsaufrufe (FC-API)

Die POST-Schnittstelle unterstützt zwei Function-Call-Namen:

- `core_memory_store`
- `core_memory_recall`

Diese Namen sind **Operationsnamen**, nicht Memory-Typen.

---

## 4. API-Referenz

| Methode | Pfad          | Zweck                                                  |
| ------- | ------------- | ------------------------------------------------------ |
| GET     | `/api/memory` | Snapshot, Page oder History laden                      |
| POST    | `/api/memory` | FC-Aufruf (`core_memory_store` / `core_memory_recall`) |
| PUT     | `/api/memory` | Node updaten oder aus History wiederherstellen         |
| PATCH   | `/api/memory` | Bulk-Update/Bulk-Delete                                |
| DELETE  | `/api/memory` | Node löschen oder gesamte Persona löschen              |

### GET Query-Parameter (Auswahl)

- `personaId` (erforderlich)
- `id` + `history=true` für Historie
- `page`, `pageSize`, `query`, `type` für Pagination/Filter

### POST Body (Beispiel)

```json
{
  "fcName": "core_memory_store",
  "args": {
    "personaId": "persona_123",
    "type": "fact",
    "content": "User arbeitet mit Next.js",
    "importance": 4
  }
}
```

---

## 5. Konfiguration

| Variable                   | Beschreibung                                       | Standard   |
| -------------------------- | -------------------------------------------------- | ---------- |
| `MEMORY_PROVIDER`          | Memory-Provider (`postgres`, `mem0` oder `sqlite`) | `postgres` |
| `CANONICAL_DATABASE_URL`   | PostgreSQL/pgvector URL                            | -          |
| `MEM0_BASE_URL`            | Mem0 Base URL                                      | -          |
| `MEM0_API_PATH`            | API Prefix                                         | `/v1`      |
| `MEM0_API_KEY`             | Mem0 API Key                                       | -          |
| `MEM0_TIMEOUT_MS`          | Request Timeout                                    | `5000`     |
| `MEM0_READ_TIMEOUT_MS`     | Timeout fuer Mem0-Read-Operationen                 | `5000`     |
| `MEM0_WRITE_TIMEOUT_MS`    | Timeout fuer Mem0-Schreiboperationen               | `15000`    |
| `MEM0_MAX_RETRIES`         | Retries bei transienten HTTP-Fehlern               | `3`        |
| `MEM0_WRITE_MAX_RETRIES`   | Retries bei Mem0-Write-Timeouts                    | `1`        |
| `MEM0_RETRY_BASE_DELAY_MS` | Exponential Backoff Basis (ms)                     | `500`      |

---

## 6. Operative Befehle

```bash
npm run memory:reset
npm run memory:cleanup-noise
npm run memory:backfill-channel-scope
npm run memory:migrate-to-postgres -- --scope all --apply
```

---

## 7. Verifikation

```bash
npm run test -- tests/unit/memory
npm run test -- tests/integration/memory
npm run typecheck
npm run lint
```

---

## 8. Siehe auch

- `docs/KNOWLEDGE_BASE_SYSTEM.md`
- `docs/SESSION_MANAGEMENT.md`
- `docs/API_REFERENCE.md`

## Kanonisches Weltmodell

Strukturierte Wahrheit und generische Langzeit-Memory werden im kanonischen
PostgreSQL-Weltmodell gefuehrt (`src/server/world-model/`). Graphiti und Mem0
sind wiederaufbaubare Projektionen; Mem0 wird im kanonischen Runtime-Pfad nicht
benötigt. Details und Aktivierung: `docs/runbooks/WORLD_MODEL_ROLLOUT.md`.
