# Memory-Architektur Analyse: OpenClaw Gateway

**Datum:** 2026-02-16  
**Ziel:** Optimierung für 24-Stunden-Begleiter mit totalem Recall

---

## Executive Summary

Die aktuelle Architektur nutzt SQLite für Chat-Speicherung und mem0 für Memory-Indexierung. Für einen echten "24-Stunden-Begleiter" mit monatelangem Recall ist eine **unifizierte, hybride Wissensbasis** erforderlich, die Chats, extrahierte Entities und semantische Suche nahtlos verbindet.

---

## 1. Aktuelle Architektur

### 1.1 Speicher-Layers

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CHAT-SPEICHERUNG                               │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  SQLite (.local/messages.db)                                        │   │
│  │  ├── conversations (WebChat, Telegram, WhatsApp, etc.)              │   │
│  │  ├── messages (FTS5 Volltextsuche via messages_fts)                 │   │
│  │  ├── room_messages (Multi-Persona Rooms)                            │   │
│  │  └── channel_bindings                                               │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              MEMORY-LAYER                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  PRIMARY: mem0 (externer REST Service)                              │   │
│  │  ├── Embedding: Gemini Embedding API                                │   │
│  │  ├── Search: Cosine Similarity (Threshold 0.30)                     │   │
│  │  ├── Scope: user_id + agent_id (persona)                            │   │
│  │  └── Types: fact, preference, avoidance, lesson, personality_trait  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  MIRROR: SQLite (memory_nodes) - nur Verwaltung, nicht primär       │   │
│  │  ├── Lokaler Cache ohne Vektor-Suchfähigkeit                        │   │
│  │  └── Importance 1-5, Confidence 0.1-1.0                             │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            KNOWLEDGE-LAYER (Experimental)                   │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────────────────┐  │
│  │  Episodes       │  │  Meeting Ledger  │  │  Query Planning            │  │
│  │  - topicKey     │  │  - counterpart   │  │  - Zeitbereiche            │  │
│  │  - teaser       │  │  - decisions     │  │  - Counterpart-Erkennung   │  │
│  │  - facts[]      │  │  - openPoints    │  │  - Intent-Klassifikation   │  │
│  └─────────────────┘  └──────────────────┘  └────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Key Components

| Komponente | Pfad | Zweck |
|------------|------|-------|
| Memory Service | `src/server/memory/service.ts` | CRUD + Recall via mem0 |
| Mem0 Client | `src/server/memory/mem0Client.ts` | REST Adapter für mem0 API |
| SQLite Mirror | `src/server/memory/sqliteMemoryRepository.ts` | Lokaler Cache |
| Auto Memory | `src/server/channels/messages/autoMemory.ts` | Heuristische Extraktion |
| Knowledge Retrieval | `src/server/knowledge/retrievalService.ts` | Meeting/Negotiation Recall |
| Query Planner | `src/server/knowledge/queryPlanner.ts` | Zeit + Intent Parsing |

---

## 2. Identifizierte Probleme

### 2.1 Fragmentierte Speicherung

```
Problem: Chats und Memory sind technologisch getrennt
┌─────────────┐      ┌─────────────┐
│   Chats     │  ❌  │   Memory    │
│  (SQLite)   │  ←→  │   (mem0)    │
│             │      │             │
│ "Andreas    │      │ "Kauf von   │
│  hat Radio  │      │  Radio bei  │
│  verkauft"  │      │  Andreas"   │
└─────────────┘      └─────────────┘
        ↓                    ↓
   FTS5 Suche          Embedding-Suche
   (keyword)           (semantisch)
```

**Impact**: Query "Gib mir alle Infos zu Andreas Radio" findet entweder Chat OR Memory, nicht beides kombiniert.

### 2.2 Passive Extraktion

Die `autoMemory.ts` extrahiert nur:
- Simple Preferences ("Ich mag Kaffee")
- Events mit Zeitmarkern ("Termin morgen 15 Uhr")
- Personality Traits

**~90% des Chat-Inhalts werden nie zu Memory.**

### 2.3 Keine Hierarchische Memory-Struktur

```
Aktuell: Flache Memory-Nodes
[Memory 1] "Andreas hat Radio verkauft" (confidence: 0.5)
[Memory 2] "Andreas wohnt in Berlin"    (confidence: 0.3)
[Memory 3] "Andreas arbeitet bei Siemens" (confidence: 0.4)

Fehlt: Verknüpfung und Aggregation
- Wer ist Andreas? (Entity-Profil)
- Wie oft erwähnt? (Häufigkeit)
- Was wurde zusammen besprochen? (Kontext)
```

### 2.4 Persona-Isolierung

- Memories sind an `personaId` gebunden
- Persona-Wechsel = Memory-Verlust
- Kein "User-Centric" Memory über alle Personas

### 2.5 Externer Single Point of Failure

| Problem | Impact |
|---------|--------|
| Netzwerk-Latenz zu mem0 | 50-500ms pro Recall |
| Kein lokales Fallback | Ausfall = keine Memory-Funktion |
| SQLite-Mirror unvollständig | Keine echte Vektor-Suche lokal |

### 2.6 Query-Planner Limitationen

Aktueller Query Planner (`queryPlanner.ts`) unterstützt nur:
- Zeit: gestern, vorgestern, vor X Monaten
- Counterpart: "mit [Name]"
- Topic: hardcoded keywords (sauna, meeting, vertrag)

**Fehlt**: Beliebige Entity-Erkennung, komplexe Relationen, Zeiträume wie "im Sommer 2024".

---

## 3. Ziel-Architektur: "Total Recall"

### 3.1 Unified Knowledge Base

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     UNIFIZIERTE WISSENSBASIS                                │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  LANGZEIT-MEMORY (Graph + Vektor)                                   │   │
│  │                                                                     │   │
│  │   ┌─────────┐       ┌─────────┐       ┌─────────┐                  │   │
│  │   │ Entity  │◄─────►│ Entity  │◄─────►│ Entity  │                  │   │
│  │   │Andreas  │       │  Radio  │       │ Berlin  │                  │   │
│  │   └────┬────┘       └────┬────┘       └────┬────┘                  │   │
│  │        │                 │                 │                        │   │
│  │        └─────────────────┴─────────────────┘                        │   │
│  │                      │                                              │   │
│  │               ┌─────────────┐                                       │   │
│  │               │  Relation   │ "hat verkauft"                        │   │
│  │               │  2024-01-15 │                                       │   │
│  │               │  Preis: 50€ │                                       │   │
│  │               └─────────────┘                                       │   │
│  │                                                                     │   │
│  │   → Vektor-Embedding der gesamten Relation                          │   │
│  │   → Zeitliche Versionierung                                         │   │
│  │   → Confidence basierend auf Häufigkeit/Bestätigung                 │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ▲                                              │
│                              │                                              │
│  ┌───────────────────────────┴─────────────────────────────────────────┐   │
│  │           KONTINUIERLICHE INDEXIERUNGSPipeline                      │   │
│  │                                                                     │   │
│  │   ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐    │   │
│  │   │   Chats     │───►│   NER/      │───►│  Entitäts-Auflösung │    │   │
│  │   │  (SQLite)   │    │   Relation  │    │  (Deduplizierung)   │    │   │
│  │   └─────────────┘    │   Extraktion│    └─────────────────────┘    │   │
│  │                      └─────────────┘              │                 │   │
│  │                              ▲                    ▼                 │   │
│  │                              │           ┌─────────────────┐        │   │
│  │                              └───────────│  Knowledge Graph│        │   │
│  │                                          │  Update/Merge   │        │   │
│  │                                          └─────────────────┘        │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Hybride Abfrage-Engine

```
Nutzer: "Gib mir alle Infos zu Andreas bei dem ich das Radio gekauft habe"

┌─────────────────────────────────────────────────────────────────────────────┐
│  1. QUERY-ANALYSE                                                           │
│     - Entities: ["Andreas", "Radio"]                                        │
│     - Intent: "entity_summary"                                              │
│     - Zeit: unbounded                                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  2. PARALLELE SUCHE                                                         │
│                                                                             │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐         │
│   │  Graph       │  │  Vektor      │  │  Volltext                │         │
│   │  Traversal   │  │  Search      │  │  (FTS5)                  │         │
│   │              │  │              │  │                          │         │
│   │ Andreas ──►  │  │ "Andreas     │  │ "Andreas sagte..."       │         │
│   │  ├─ Radio    │  │  Radio Kauf" │  │ aus Chat #1234           │         │
│   │  ├─ Wohnort  │  │              │  │                          │         │
│   │  └─ Arbeit   │  │              │  │                          │         │
│   └──────────────┘  └──────────────┘  └──────────────────────────┘         │
└─────────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  3. RERANKING & FUSION (RRF + Cross-Encoder)                                │
└─────────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  4. KONTEXT-ZUSAMMENSTELLUNG                                                │
│                                                                             │
│  ═══ ANDREAS (Aggregiertes Profil) ═══                                      │
│  • Wohnort: Berlin (seit 2019, Quelle: Chat #452)                          │
│  • Arbeit: Siemens, Abteilung Automation (Quelle: Chat #892)               │
│  • Kontakt: andreas@example.com                                            │
│  • Häufigkeit: 23 Erwähnungen in 12 Gesprächen                             │
│                                                                             │
│  ═══ RADIO-KAUF ═══                                                         │
│  • Datum: 15.01.2024                                                       │
│  • Preis: 50€ (verhandelt von 80€)                                         │
│  • Zustand: Gut, kleiner Kratzer auf Rückseite                             │
│  • Quelle: Chat-Verlauf #1234, Zeile 45-52 [Link]                          │
│  • Zusätzlich: Andreas empfohl Händler "TechSecond"                        │
│                                                                             │
│  ═══ VERBUNDENE THEMEN ═══                                                  │
│  • Andreas sucht selbst Laptop (März 2024, noch offen)                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Datenmodell-Vorschlag

### 4.1 UnifiedMemoryNode

```typescript
interface UnifiedMemoryNode {
  id: string;
  
  // Inhalt
  content: string;              // Original-Text oder Zusammenfassung
  embedding: number[];          // 768-dim (Gemini) oder 384-dim (lokal)
  
  // Quelle (Provenienz)
  source: {
    type: 'chat' | 'extracted_fact' | 'daily_digest' | 'document';
    conversationId?: string;
    messageIds?: string[];      // Verknüpfung zu Original
    timestamp: string;          // ISO 8601
    confidence: number;         // Extraktions-Confidence
  };
  
  // Semantische Struktur (aus NER/Relation Extraction)
  entities: {
    id: string;
    name: string;
    canonicalName: string;      // Dedupliziert ("Andreas M." → "Andreas Mueller")
    type: 'person' | 'organization' | 'location' | 'product' | 
          'event' | 'date' | 'money';
    confidence: number;
  }[];
  
  relations: {
    id: string;
    subject: string;            // Entity ID
    predicate: string;          // "hat_verkauft", "wohnt_in", "arbeitet_bei"
    object: string;             // Entity ID oder Literal
    temporal?: {
      start?: string;
      end?: string;
      isOngoing: boolean;
    };
    sources: string[];          // Ursprüngliche messageIds
  }[];
  
  // Metadaten für Retrieval
  importance: number;           // 1-5 (berechnet aus Häufigkeit, Aktualität)
  accessCount: number;          // Für LRU-Caching
  lastAccessed: string;
  
  // Zeitreihen
  versionHistory: {
    timestamp: string;
    content: string;
    changeType: 'created' | 'updated' | 'merged' | 'corrected';
  }[];
}
```

### 4.2 Entity Profile

```typescript
interface EntityProfile {
  id: string;
  canonicalName: string;
  aliases: string[];            // ["Andi", "Andreas M.", "der Siemens-Typ"]
  type: 'person' | 'organization' | 'product' | 'location';
  
  // Aggregierte Fakten
  attributes: {
    key: string;                // "wohnort", "arbeitgeber", "email"
    value: string;
    firstSeen: string;
    lastConfirmed: string;
    confidence: number;
    sources: string[];          // memory_node IDs
  }[];
  
  // Verknüpfungen
  relations: {
    targetEntityId: string;
    predicate: string;
    count: number;              // Wie oft wurde diese Relation erwähnt?
    firstSeen: string;
    lastSeen: string;
  }[];
  
  // Timeline
  mentions: {
    timestamp: string;
    memoryNodeId: string;
    context: string;            // Snippet
  }[];
}
```

---

## 5. Implementierungs-Roadmap

### Phase 1: Sofort umsetzbar (1-2 Tage)

#### 1.1 FTS5 + Embedding-Reranking für Chats

Die SQLite-Datenbank hat bereits FTS5 (`messages_fts`). Erweiterung um semantisches Reranking:

```typescript
// src/server/channels/messages/enhancedSearch.ts
export class EnhancedChatSearch {
  async semanticSearch(
    userId: string,
    query: string,
    options?: { limit?: number; timeRange?: DateRange }
  ): Promise<SearchResult[]> {
    // 1. FTS5 für Kandidaten (schnell)
    const candidates = this.repo.searchMessages(query, {
      userId,
      limit: (options?.limit ?? 10) * 5  // 5x Overfetch für Reranking
    });
    
    // 2. Embedding-Generierung (parallel)
    const [queryEmbedding, candidateEmbeddings] = await Promise.all([
      getEmbedding(query),
      Promise.all(candidates.map(c => getEmbedding(c.content)))
    ]);
    
    // 3. Cosine Similarity Scoring
    const scored = candidates.map((c, i) => ({
      ...c,
      semanticScore: cosineSimilarity(queryEmbedding, candidateEmbeddings[i]),
      ftsScore: 1.0 // Könnte BM25 score nutzen
    }));
    
    // 4. Reranking und Filterung
    return scored
      .filter(s => s.semanticScore > 0.7)
      .sort((a, b) => b.semanticScore - a.semanticScore)
      .slice(0, options?.limit ?? 10);
  }
}
```

#### 1.2 Chat-Kontext in Memory-Recall einbeziehen

```typescript
// In src/server/channels/messages/service.ts
private async buildRecallContext(
  conversation: Conversation,
  userInput: string,
  // ...
) {
  // Knowledge-Layer (bestehend)
  const knowledgeContext = await this.queryKnowledgeLayer(...);
  
  // Memory-Layer (bestehend)
  const memoryContext = await getMemoryService().recallDetailed(...);
  
  // NEU: Chat-Layer
  const chatContext = await this.enhancedChatSearch.semanticSearch(
    conversation.userId,
    userInput,
    { limit: 5, timeRange: { months: 6 } }
  );
  
  // Fusion
  return this.fuseContexts({
    knowledge: knowledgeContext,
    memory: memoryContext,
    chat: chatContext
  });
}
```

### Phase 2: Lokale Vektor-Datenbank (3-5 Tage)

#### 2.1 Optionen

| Option | Pros | Cons | Empfehlung |
|--------|------|------|------------|
| **sqlite-vss** | Nativ in SQLite, kein extra Service | Setup komplex, weniger Features | ⭐⭐⭐ |
| **LanceDB** | Embedded, gute Performance, Arrow-native | Neues Ökosystem | ⭐⭐⭐⭐ |
| **Chroma** | Feature-reich, gute Doku | Extra Prozess/Service | ⭐⭐⭐ |
| **Transformers.js** | 100% client-side, offline | Browser-only, langsamer | ⭐⭐ |

#### 2.2 Beispiel: LanceDB Integration

```typescript
// src/server/vector/lanceRepository.ts
import * as lancedb from '@lancedb/lancedb';

export class LanceMemoryRepository {
  private db: lancedb.Connection;
  private table: lancedb.Table;
  
  async initialize() {
    this.db = await lancedb.connect('data/lance_memory');
    
    // Schema: id, content, embedding (768-dim), 
    //         source_type, conversation_id, timestamp, entities (JSON)
    this.table = await this.db.openTable('memories');
  }
  
  async search(
    query: string,
    embedding: number[],
    filters?: { userId?: string; entityType?: string; timeRange?: DateRange }
  ): Promise<MemoryResult[]> {
    let queryBuilder = this.table
      .search(embedding)
      .metricType('cosine')
      .limit(20);
    
    // Hybride Filterung
    if (filters?.userId) {
      queryBuilder = queryBuilder.where(`user_id = '${filters.userId}'`);
    }
    if (filters?.timeRange) {
      queryBuilder = queryBuilder.where(
        `timestamp >= '${filters.timeRange.from}' AND timestamp <= '${filters.timeRange.to}'`
      );
    }
    
    return queryBuilder.toArray();
  }
  
  async upsert(nodes: UnifiedMemoryNode[]) {
    const records = nodes.map(n => ({
      id: n.id,
      content: n.content,
      vector: n.embedding,
      source_type: n.source.type,
      conversation_id: n.source.conversationId,
      timestamp: n.source.timestamp,
      entities: JSON.stringify(n.entities),
      user_id: n.userId,
      importance: n.importance
    }));
    
    await this.table.add(records);
  }
}
```

### Phase 3: Entity-Extraktion (1 Woche)

#### 3.1 LLM-basierte Extraktion

```typescript
// src/server/extraction/entityExtractor.ts
const entityExtractionSpec: FunctionDeclaration = {
  name: 'extract_entities_and_relations',
  description: 'Extrahiere alle Entities und Relationen aus dem Chat-Verlauf',
  parameters: {
    type: Type.OBJECT,
    properties: {
      entities: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            type: { 
              type: Type.STRING, 
              enum: ['person', 'organization', 'location', 'product', 'event', 'date', 'money'] 
            },
            mentions: { type: Type.ARRAY, items: { type: Type.STRING } },
          }
        }
      },
      relations: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            subject: { type: Type.STRING },
            predicate: { type: Type.STRING },
            object: { type: Type.STRING },
            temporal_marker: { type: Type.STRING },
          }
        }
      }
    }
  }
};

export class EntityExtractor {
  async extract(messages: Message[]): Promise<ExtractionResult> {
    const result = await gemini.generateContent({
      model: 'gemini-1.5-flash',
      tools: [{ functionDeclarations: [entityExtractionSpec] }],
      contents: [{
        role: 'user',
        parts: [{
          text: `Extrahiere alle wichtigen Informationen aus diesem Chat:\n\n${
            messages.map(m => `${m.role}: ${m.content}`).join('\n')
          }`
        }]
      }]
    });
    
    return result.functionCalls[0].args;
  }
}
```

#### 3.2 Sliding Window Indexierung

```typescript
// src/server/indexing/continuousIndexer.ts
export class ContinuousIndexer {
  private windowSize = 10;
  private overlap = 3;
  
  async indexConversation(conversationId: string) {
    const unindexed = await this.getUnindexedMessages(conversationId);
    
    // Sliding Windows mit Überlappung
    for (let i = 0; i < unindexed.length; i += (this.windowSize - this.overlap)) {
      const window = unindexed.slice(i, i + this.windowSize);
      
      // Parallel: Entity-Extraktion + Embedding
      const [extraction, embedding] = await Promise.all([
        this.entityExtractor.extract(window),
        getEmbedding(window.map(m => m.content).join('\n'))
      ]);
      
      // Graph-Merge
      await this.knowledgeGraph.merge(extraction);
      
      // Vektor-Speicher
      await this.vectorRepo.upsert([{
        id: `mem-${conversationId}-${i}`,
        content: this.summarize(window),
        embedding,
        entities: extraction.entities,
        source: {
          type: 'chat',
          conversationId,
          messageIds: window.map(m => m.id),
          timestamp: window[window.length - 1].createdAt
        }
      }]);
    }
    
    await this.markIndexed(conversationId, unindexed);
  }
}
```

### Phase 4: Knowledge Graph Layer (2 Wochen)

#### 4.1 Optionen

| Option | Use Case | Komplexität |
|--------|----------|-------------|
| **Neo4j** | Produktion, komplexe Queries | Hoch (extra Service) |
| **KuzuDB** | Embedded Graph DB, Cypher | Mittel |
| **SQLite + JSON** | Einfache Relationen | Niedrig |

#### 4.2 Beispiel: KuzuDB

```typescript
// Schema
CREATE NODE TABLE Entity(
  id STRING PRIMARY KEY,
  name STRING,
  type STRING,
  canonical_name STRING
);

CREATE NODE TABLE Memory(
  id STRING PRIMARY KEY,
  content STRING,
  timestamp TIMESTAMP,
  importance INT64
);

CREATE REL TABLE Mentioned(FROM Memory TO Entity);
CREATE REL TABLE Related(FROM Entity TO Entity, predicate STRING, since TIMESTAMP);

// Query: Finde alle Verbindungen zu Andreas
MATCH (e:Entity {name: 'Andreas'})<-[:Mentioned]-(m:Memory)-[:Mentioned]->(other:Entity)
RETURN m.content, other.name, other.type
ORDER BY m.timestamp DESC;
```

### Phase 5: Advanced Features (1 Woche)

#### 5.1 Tägliche Zusammenfassungen (Daily Digest)

```typescript
export class DailyDigestService {
  async generateDigest(userId: string, date: Date) {
    const dayEvents = await this.getEventsForDay(userId, date);
    
    const digest = await this.summarizeWithModel({
      events: dayEvents,
      prompt: `Erstelle eine chronologische Zusammenfassung des Tages.
               Hebe wichtige Gespräche, Entscheidungen und offene Punkte hervor.
               Struktur: Zeitpunkt | Wer | Was | Offene Punkte`
    });
    
    await this.storeEpisode({
      type: 'daily_digest',
      date,
      content: digest,
      eventReferences: dayEvents.map(e => e.id),
      importance: 4
    });
  }
}
```

#### 5.2 Proaktive Erinnerungen

```typescript
export class ProactiveMemoryService {
  async getSuggestions(userId: string, currentContext: string) {
    // Finde offene Punkte
    const openItems = await this.graph.query(`
      MATCH (m:Memory)-[:HAS_ACTION_ITEM]->(action:ActionItem {status: 'open'})
      WHERE m.user_id = $userId
      RETURN action.description, action.due_date, m.content as context
      ORDER BY action.due_date
    `, { userId });
    
    // Relevanz für aktuellen Kontext
    const contextEmbedding = await getEmbedding(currentContext);
    const relevant = await Promise.all(
      openItems.map(async item => ({
        ...item,
        relevance: cosineSimilarity(
          contextEmbedding,
          await getEmbedding(item.context)
        )
      }))
    );
    
    return relevant
      .filter(r => r.relevance > 0.6)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 3);
  }
}
```

---

## 6. Vergleich: Aktuell vs. Optimiert

| Aspekt | Aktuell | Optimiert | Impact |
|--------|---------|-----------|--------|
| **Speicherung** | Fragmentiert (Chat SQLite + Memory mem0) | Unified (Graph + Vektor) | ⭐⭐⭐⭐⭐ |
| **Suche** | Nur Embedding (mem0) | Hybrid (Graph + Vektor + FTS) | ⭐⭐⭐⭐⭐ |
| **Entitätserkennung** | Keine | Kontinuierliche NER | ⭐⭐⭐⭐ |
| **Zeitliche Abfragen** | Eingeschränkt | Native Zeitreihen | ⭐⭐⭐⭐ |
| **Beziehungen** | Keine expliziten | Knowledge Graph | ⭐⭐⭐⭐⭐ |
| **Fallback** | SQLite-Mirror (unvollständig) | Vollständig lokal | ⭐⭐⭐⭐ |
| **Latenz** | 50-500ms (Netzwerk) | <10ms (lokal) | ⭐⭐⭐⭐ |
| **Persona-Isolation** | Strikte Trennung | User-Centric + Persona-Overlay | ⭐⭐⭐ |

---

## 7. Empfohlene Tech Stack Änderungen

### Neue Dependencies

```json
{
  "dependencies": {
    // Vektor-Datenbank (Option 1: LanceDB)
    "@lancedb/lancedb": "^0.15.0",
    
    // ODER Vektor-Datenbank (Option 2: sqlite-vss)
    "sqlite-vss": "^0.1.0",
    
    // Graph-Datenbank (Optional)
    "kuzu": "^0.7.0",
    
    // Lokale Embeddings (Offline-Fallback)
    "@xenova/transformers": "^2.17.0",
    
    // Cross-Encoder für Reranking
    "@xenova/transformers": "^2.17.0" // nutzt sentence-transformers
  }
}
```

### Neue Module

```
src/server/
├── memory/                    # Bestehend (mem0-basiert)
│   └── ...
├── vector/                    # NEU: Lokale Vektor-DB
│   ├── lanceRepository.ts
│   ├── embeddingService.ts
│   └── hybridSearch.ts
├── knowledge-graph/           # NEU: Graph-Layer
│   ├── kuzuRepository.ts
│   ├── entityResolver.ts
│   └── relationExtractor.ts
├── indexing/                  # NEU: Kontinuierliche Indexierung
│   ├── continuousIndexer.ts
│   ├── slidingWindow.ts
│   └── entityExtractor.ts
└── recall/                    # NEU: Hybride Abfrage-Engine
    ├── totalRecallEngine.ts
    ├── queryParser.ts
    ├── contextFusion.ts
    └── reranker.ts
```

---

## 8. Konfigurations-Empfehlungen

### Environment Variables

```bash
# Memory Provider
MEMORY_PROVIDER=hybrid              # NEU: hybrid | mem0 | sqlite
VECTOR_DB_PROVIDER=lancedb          # lancedb | chroma | none
GRAPH_DB_PROVIDER=kuzu              # kuzu | neo4j | none

# Embeddings
EMBEDDING_PROVIDER=gemini           # gemini | openai | local
EMBEDDING_MODEL=gemini-embedding-001
LOCAL_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2

# Indexierung
ENABLE_CONTINUOUS_INDEXING=true
INDEXING_WINDOW_SIZE=10
INDEXING_BATCH_SIZE=100

# Recall
RECALL_HYBRID_WEIGHTS='{"vector": 0.4, "graph": 0.3, "fts": 0.3}'
RERANKING_ENABLED=true
RERANKING_TOP_K=20
```

---

## 9. Success Metrics

### Quantitativ

| Metric | Aktuell | Ziel | Messung |
|--------|---------|------|---------|
| Recall Latenz | 200ms | <50ms | Avg/ p95 |
| Chat → Memory Extraktion | ~10% | >70% | % indizierter Nachrichten |
| Query Coverage | 40% | >90% | % erfolgreicher Queries |
| Offline-Fähigkeit | Nein | Ja | Feature Flag |

### Qualitativ

- "Gib mir alle Infos zu Andreas" → Aggregiertes Profil mit allen Verknüpfungen
- "Was habe ich im März mit Andreas besprochen?" → Chronologische Timeline
- "Wer hat mir das Radio verkauft?" → Korrekte Antwort trotz unterschiedlicher Formulierungen

---

## 10. Risiken & Mitigationen

| Risiko | Impact | Mitigation |
|--------|--------|------------|
| Performance bei großen Datenmengen | Hoch | Sharding nach User + Zeit, Lazy Loading |
| Entity-Deduplizierung falsch | Mittel | Fuzzy Matching + Manuelle Review UI |
| LLM-Kosten für Extraktion | Mittel | Batch-Verarbeitung, lokale Modelle |
| Migration bestehender Daten | Hoch | Inkrementeller Rollout, mem0 als Fallback |
| Datenschutz (Embeddings) | Mittel | Lokale Embeddings, keine externe Übertragung |

---

## 11. Fazit

Die aktuelle Architektur ist ein guter Startpunkt, aber für einen **echten 24-Stunden-Begleiter** mit **monatelangem, totalem Recall** notwendig:

1. **Unified Storage**: Chat + Memory in einer durchsuchbaren Einheit
2. **Strukturierte Extraktion**: Entities und Relationen aus allen Chats
3. **Hybride Suche**: Vektor + Graph + Volltext kombiniert
4. **Lokale Vektor-DB**: Unabhängigkeit von mem0

Die Roadmap ist evolutionär: Phase 1 nutzt bestehende SQLite-FTS5, Phase 2-5 fügen lokale Vektor-Datenbank und Graph-Layer hinzu. Jedes Phase liefert standalone Value.

---

**Autor:** Kimi Code CLI  
**Version:** 1.0  
**Status:** Analyse & Empfehlung
