# Memory System

**Stand:** 2026-02-13

## Überblick

Das Memory-System speichert konzeptuelles Wissen für KI-Interaktionen:

- **Embedding-basierte Speicherung** mit Vektor-Similarity
- **Automatische Deduplizierung** durch Cosine-Similarity
- **Confidence-Scoring** für Erinnerungsqualität
- **Persistenz** in SQLite
- **Mem0-Provider** für Long-Term Persona Recall (kein fail-open Fallback im Recall-Pfad)

## Architektur

```
src/server/memory/
├── embeddings.ts         # Embedding-Generierung
├── mem0Client.ts         # Mem0 REST Adapter (optional)
├── repository.ts        # Repository-Interface
├── sqliteMemoryRepository.ts  # SQLite-Implementierung
├── runtime.ts          # Runtime-Initialisierung
└── service.ts          # Business-Logik
```

## Memory-Typen

| Typ                  | Beschreibung                         |
| -------------------- | ------------------------------------ |
| `core_memory_store`  | Langzeitspeicher für wichtige Fakten |
| `core_memory_recall` | Abrufbare Erinnerungen               |

## Embedding-Pipeline

```typescript
// embeddings.ts
export async function getServerEmbedding(text: string): Promise<number[]> {
  // Nutzt Model-Hub für Embedding-Generierung
  const result = await dispatchEmbedding(text);
  return result.embedding;
}
```

## Speicher-Logik

```typescript
// service.ts
async store(type: MemoryType, content: string, importance: number): Promise<MemoryNode> {
  // 1. Embedding generieren
  const queryVector = await this.getEmbedding(content);

  // 2. Deduplizierung durch Similarity-Check (>0.95)
  const existing = this.findSimilar(queryVector);

  if (existing) {
    // Bestehende Erinnerung aktualisieren
    return this.updateNode({ ...existing, importance: Math.max(...) });
  }

  // 3. Neue Erinnerung speichern
  return this.insertNode({ type, content, embedding: queryVector, importance });
}
```

## Abruf-Logik

```typescript
// service.ts
async recall(query: string, limit = 3): Promise<string> {
  // 1. Query-Embedding generieren
  const queryVector = await this.getEmbedding(query);

  // 2. Similarity-Suche mit Confidence-Score
  const results = this.findSimilar(queryVector)
    .map(node => ({
      node,
      similarity: cosineSimilarity(queryVector, node.embedding),
      score: similarity * (1 + node.confidence * 0.5)
    }))
    .sort((a, b) => b.score - a.score);

  // 3. Top-k Ergebnisse über Threshold (>0.7)
  return results
    .filter(r => r.similarity > 0.7)
    .map(r => `[${r.node.type}] ${r.node.content}`)
    .join('\n');
}
```

## Cosine-Similarity

```typescript
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) return 0;

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    magnitudeA += vecA[i] * vecA[i];
    magnitudeB += vecB[i] * vecB[i];
  }

  magnitudeA = Math.sqrt(magnitudeA);
  magnitudeB = Math.sqrt(magnitudeB);

  return dotProduct / (magnitudeA * magnitudeB);
}
```

## API-Oberfläche

### POST /api/memory

Erinnerung speichern.

**Body:**

```json
{
  "type": "core_memory_store",
  "content": "Wichtige Information",
  "importance": 0.8
}
```

### GET /api/memory?query=...&limit=3

Erinnerungen abrufen.

**Response:**

```json
{
  "ok": true,
  "memories": "[core_memory_store] Inhalt 1\n[core_memory_recall] Inhalt 2"
}
```

## Konfiguration

| Variable                 | Beschreibung                                                         | Standard               |
| ------------------------ | -------------------------------------------------------------------- | ---------------------- |
| `MEMORY_PROVIDER`        | Memory Backend (`mem0` empfohlen; andere Werte deaktivieren Mem0)    | `mem0`                 |
| `MEMORY_DB_PATH`         | Pfad zur lokalen Memory-Datenbank (SQLite Mirror + Verwaltungsdaten) | `.local/messages.db`   |
| `MEM0_BASE_URL`          | Mem0 Base URL (z. B. `http://localhost:8000`)                        | -                      |
| `MEM0_API_PATH`          | Mem0 API Prefix (`/v1` oder `/` bei Legacy-REST ohne Versionspfad)   | `/v1`                  |
| `MEM0_API_KEY`           | Optionaler Bearer Token für Mem0                                     | -                      |
| `MEM0_TIMEOUT_MS`        | Timeout pro Mem0 Request in ms                                       | `5000`                 |
| `MEMORY_EMBEDDING_MODEL` | Embedding-Modell für Memory-Vektorisierung (Gemini)                  | `gemini-embedding-001` |
| `GEMINI_API_KEY`         | API Key für Memory-Embeddings (Gemini)                               | -                      |

### Rollout-Regeln (Production)

1. Produktion mit `MEMORY_PROVIDER=mem0` und gesetztem `MEM0_BASE_URL` betreiben.
2. Recall-/Embedding-Fehler als Incident behandeln, nicht lokal maskieren.
3. Scope-Isolation immer über `user_id` + `agent_id` (Persona) erzwingen.
4. Production Fail-Fast: Start wird abgebrochen, wenn `MEMORY_PROVIDER!=mem0` oder `MEM0_BASE_URL` fehlt.
5. Runtime-Fail-Fast: Web- und Scheduler-Start brechen ab, wenn Mem0 nicht erreichbar ist (Connectivity-Probe via `listMemories`).
6. Memory-Pfad bleibt provider-konsistent: für Embeddings ist im Memory-Kontext ausschließlich Gemini vorgesehen.

## Operativer Reset (Fresh Start)

```bash
npm run memory:reset
```

Der Befehl:

1. leert lokale Legacy-Memory-Einträge in `.local/messages.db` (`memory_nodes`)
2. ermittelt Scope-Kombinationen (`user_id` + `persona_id`) aus lokalen Datenbanken
3. löscht Mem0-Memorys pro Scope
4. verifiziert, dass pro Scope keine Einträge mehr vorhanden sind

## Verifikation

```bash
npm run test -- tests/unit/memory
npm run test -- tests/integration/memory
npm run lint
npm run typecheck
```

## Siehe auch

- [docs/CORE_HANDBOOK.md](CORE_HANDBOOK.md)
- [docs/plans/2026-02-12-knowledge-base-agent-access-implementation.md](plans/2026-02-12-knowledge-base-agent-access-implementation.md) – Knowledge Base (in Entwicklung)
