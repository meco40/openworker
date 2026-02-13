# Memory System

**Stand:** 2026-02-13

## Überblick

Das Memory-System speichert konzeptuelles Wissen für KI-Interaktionen:

- **Embedding-basierte Speicherung** mit Vektor-Similarity
- **Automatische Deduplizierung** durch Cosine-Similarity
- **Confidence-Scoring** für Erinnerungsqualität
- **Persistenz** in SQLite

## Architektur

```
src/server/memory/
├── types.ts              # Memory-Typ-Definitionen
├── embeddings.ts         # Embedding-Generierung
├── vectorStore.ts       # Vektor-Speicher
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

| Variable         | Beschreibung              | Standard             |
| ---------------- | ------------------------- | -------------------- |
| `MEMORY_DB_PATH` | Pfad zur Memory-Datenbank | `.local/messages.db` |
| `GEMINI_API_KEY` | API Key für Embeddings    | -                    |

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
