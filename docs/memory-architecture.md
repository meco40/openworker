# Memory Architecture

This document describes the complete memory system architecture, covering the full data flow from user input through context retrieval, LLM processing, storage, and feedback loops.

## Overview

The memory system is a multi-layered architecture that enables the AI assistant to maintain context across conversations and learn from interactions. It combines **semantic vector search** (Mem0) with **structured episodic memory** (Knowledge Repository) and **local backup storage** (SQLite).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MEMORY ARCHITECTURE                                 │
│                    Complete Data Flow & Retrieval                           │
└─────────────────────────────────────────────────────────────────────────────┘

╔═══════════════════════════════════════════════════════════════════════════╗
║  LAYER 1: WORKING MEMORY (Session Context)                                ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  • Current conversation messages                                          ║
║  • Active user intent                                                     ║
║  • Temporary context window                                               ║
╚═══════════════════════════════════════════════════════════════════════════╝
                                    │
                                    │ User sends message
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     RECALL PIPELINE (Context Building)                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐  │
│  │ 1. DECISION     │  │ 2. PARALLEL     │  │ 3. FUSION               │  │
│  │    Should recall│  │    SEARCH       │  │    Merge & rank         │  │
│  │    memory?      │  │    sources      │  │    results              │  │
│  │                 │  │                 │  │                         │  │
│  │ Skip if: "ok",  │  │ ┌───────────┐   │  │ • Deduplicate           │  │
│  │ "thanks", short │  │ │ MEM0      │   │  │ • Re-rank by relevance  │  │
│  │ confirmations   │  │ │ Semantic  │   │  │ • Format for LLM        │  │
│  │                 │  │ │ Search    │   │  │                         │  │
│  │                 │  │ │           │   │  │                         │  │
│  │                 │  │ │ Query ──► │   │  │                         │  │
│  │                 │  │ │ Vectors   │   │  │                         │  │
│  │                 │  │ │ (0.3+     │   │  │                         │  │
│  │                 │  │ │  score)   │   │  │                         │  │
│  │                 │  │ └─────┬─────┘   │  │                         │  │
│  │                 │  │       │         │  │                         │  │
│  │                 │  │ ┌─────▼─────┐   │  │                         │  │
│  │                 │  │ │ KNOWLEDGE │   │  │                         │  │
│  │                 │  │ │ RETRIEVAL │   │  │                         │  │
│  │                 │  │ │           │   │  │                         │  │
│  │                 │  │ │ ┌───────┐ │   │  │                         │  │
│  │                 │  │ │ │Episodes │   │  │                         │  │
│  │                 │  │ │ │(topics) │   │  │                         │  │
│  │                 │  │ │ └───┬───┘ │   │  │                         │  │
│  │                 │  │ │     │     │   │  │                         │  │
│  │                 │  │ │ ┌───▼───┐ │   │  │                         │  │
│  │                 │  │ │ │Meeting│ │   │  │                         │  │
│  │                 │  │ │ │Ledger │ │   │  │                         │  │
│  │                 │  │ │ │(decisions│  │  │                         │  │
│  │                 │  │ │ │& actions)│  │  │                         │  │
│  │                 │  │ │ └───┬───┘ │   │  │                         │  │
│  │                 │  │ │     │     │   │  │                         │  │
│  │                 │  │ │ ┌───▼───┐ │   │  │                         │  │
│  │                 │  │ │ │ FTS5  │ │   │  │                         │  │
│  │                 │  │ │ │ Chat  │ │   │  │                         │  │
│  │                 │  │ │ │History│ │   │  │                         │  │
│  │                 │  │ │ └───────┘ │   │  │                         │  │
│  │                 │  │ └─────┬─────┘   │  │                         │  │
│  │                 │  │       │         │  │                         │  │
│  │                 │  │ ┌─────▼─────┐   │  │                         │  │
│  │                 │  │ │  FALLBACK │   │  │                         │  │
│  │                 │  │ │  Lexical  │   │  │                         │  │
│  │                 │  │ │  search   │   │  │                         │  │
│  │                 │  │ │  if rules │   │  │                         │  │
│  │                 │  │ │  query    │   │  │                         │  │
│  │                 │  │ └───────────┘   │  │                         │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Context + Prompt
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         LLM PROCESSING                                  │
│  • Generate response using retrieved context                            │
│  • Store response in conversation history                               │
└────────────────────────────────────────┬────────────────────────────────┘
                                         │
                                         │ After response
                                         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    STORAGE PIPELINE (Memory Formation)                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐  │
│  │ MANUAL SAVE     │  │ AUTO-MEMORY     │  │ KNOWLEDGE INGESTION     │  │
│  │                 │  │                 │  │                         │  │
│  │ "Save: ..."     │  │ buildAutoMemory │  │ maybeStoreKnowledge     │  │
│  │ prefix detected │  │ Candidates()    │  │ Artifacts()             │  │
│  │                 │  │                 │  │                         │  │
│  │ Importance: 4   │  │ Importance: 2-3 │  │ Extract structured      │  │
│  │ Type: fact      │  │ Type: detected  │  │ knowledge via LLM       │  │
│  └────────┬────────┘  └────────┬────────┘  └────────────┬────────────┘  │
│           │                    │                        │               │
│           └────────────────────┼────────────────────────┘               │
│                                │                                        │
│                                ▼                                        │
│  ╔═══════════════════════════════════════════════════════════════════╗  │
│  ║  LAYER 2: LONG-TERM MEMORY (Persistent Storage)                   ║  │
│  ╠═══════════════════════════════════════════════════════════════════╣  │
│  ║                                                                   ║  │
│  ║  ┌─────────────────────┐      ┌─────────────────────┐             ║  │
│  ║  │    MEM0 CLOUD       │      │    KNOWLEDGE REPO   │             ║  │
│  ║  │  (Semantic Memory)  │      │  (Episodic Memory)  │             ║  │
│  ║  │                     │      │                     │             ║  │
│  ║  │ • Vector embeddings │      │ • Episodes          │             ║  │
│  ║  │ • Similarity search │      │ • Meeting Ledgers   │             ║  │
│  ║  │ • Memory types:     │      │ • Decisions         │             ║  │
│  ║  │   fact, preference, │      │ • Action Items      │             ║  │
│  ║  │   avoidance, lesson │      │ • Facts per topic   │             ║  │
│  ║  │                     │      │                     │             ║  │
│  ║  │ Metadata:           │      │ Metadata:           │             ║  │
║  ║  │ • importance (1-5)  │      │ • topicKey          │             ║  │
║  ║  │ • confidence (0-1)  │      │ • counterpart       │             ║  │
║  ║  │ • version           │      │ • sourceSeq range   │             ║  │
║  ║  │ • userId+personaId  │      │                     │             ║  │
║  ║  └─────────────────────┘      └─────────────────────┘             ║  │
║  ║                                │                                  ║  │
║  ║           ┌────────────────────┘                                  ║  │
║  ║           │                                                       ║  │
║  ║           ▼                                                       ║  │
║  ║  ┌─────────────────────┐                                          ║  │
║  ║  │   SQLITE BACKUP     │                                          ║  │
║  ║  │  (Local Fallback)   │                                          ║  │
║  ║  │                     │                                          ║  │
║  ║  │ • memory_nodes table│                                          ║  │
║  ║  │ • Same schema       │                                          ║  │
║  ║  │ • Offline access    │                                          ║  │
║  ║  │ • Sync with Mem0    │                                          ║  │
║  ║  └─────────────────────┘                                          ║  │
║  ╚═══════════════════════════════════════════════════════════════════╝  │
└─────────────────────────────────────────────────────────────────────────┘
                                         │
                                         │ FEEDBACK LOOP
                                         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    LEARNING & MAINTENANCE                               │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  User Feedback Detection                                          │  │
│  │  ─────────────────────────────────────────────────────────────    │  │
│  │                                                                   │  │
│  │  "Correct" / "Exactly"  ──►  Confidence +0.15, Importance +1      │  │
│  │                                                                   │  │
│  │  "Wrong" / "Incorrect"  ──►  Confidence -0.2, Importance -1       │  │
│  │                              │                                    │  │
│  │                              ▼                                    │  │
│  │                    3× Negative + Confidence < 0.15                │  │
│  │                              │                                    │  │
│  │                              ▼                                    │  │
│  │                        AUTO-DELETE                                │  │
│  │                                                                   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                         NEXT SESSION CYCLE                              │
│  Same Recall Pipeline ──► Context enriched with stored memories         │
│                         ──► Seamless conversation continuation          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [Architecture Layers](#architecture-layers)
3. [Recall Pipeline](#recall-pipeline)
4. [Storage Pipeline](#storage-pipeline)
5. [Long-Term Memory Stores](#long-term-memory-stores)
6. [Learning & Feedback](#learning--feedback)
7. [API Reference](#api-reference)
8. [Configuration](#configuration)
9. [Security & Privacy](#security--privacy)
10. [Testing](#testing)

---

## Core Concepts

### Scope Isolation

All memory operations are scoped to prevent data leakage between users and personas:

```typescript
// Scope is composed of userId + personaId
interface MemoryScope {
  userId: string; // Authenticated user or legacy local user
  personaId: string; // Assistant persona identifier
}
```

**Authenticated Users**: Use their actual user ID across all communication channels, ensuring consistent memory access.

**Legacy Mode**: When no authenticated user exists, a local user ID is used that spans all channels for that installation.

### Memory Types

The system categorizes information into semantic memory types:

| Type                | Description                         | Default Importance | Use Case                   |
| ------------------- | ----------------------------------- | ------------------ | -------------------------- |
| `fact`              | Objective statements about the user | 3                  | "User works remotely"      |
| `preference`        | User likes/dislikes                 | 4                  | "Prefers concise answers"  |
| `avoidance`         | Things to avoid                     | 4                  | "Don't use emojis"         |
| `lesson`            | Learned experiences                 | 3                  | "Previous approach failed" |
| `personality_trait` | Observed characteristics            | 2                  | "User is detail-oriented"  |
| `workflow_pattern`  | Recurring work patterns             | 2                  | "Checks email at 9am"      |

Each memory node carries metadata:

- `importance`: 1-5 scale (5 = critical)
- `confidence`: 0.1-1.0 (certainty about accuracy)
- `version`: Incremented on each update
- `timestamp`: Creation/update time
- `source`: How the memory was captured (manual, auto, ingestion)

---

## Architecture Layers

### Layer 1: Working Memory

The working memory holds transient context for the current session:

- **Conversation messages**: Recent exchanges within the context window
- **User intent**: Detected intent from the current input
- **Active context**: Temporary data that doesn't need persistence

This layer is ephemeral and cleared when the session ends.

### Layer 2: Long-Term Memory

Persistent storage with three complementary stores:

1. **Mem0 Cloud**: Semantic vector database for similarity search
2. **Knowledge Repository**: Structured episodic memory (episodes, meeting ledgers)
3. **SQLite**: Local fallback with identical schema

---

## Recall Pipeline

The recall pipeline builds context before LLM processing through three stages:

### Stage 1: Decision

Determines if memory retrieval is beneficial:

```typescript
function shouldRecallMemoryForInput(input: string): boolean {
  // Skip for short confirmations
  if (isShortConfirmation(input)) return false;
  // Examples: "ok", "thanks", "yes", "no"

  // Skip for purely social utterances
  if (isSocialUtterance(input)) return false;
  // Examples: "hello", "good morning"

  return true;
}
```

**Why skip?** Retrieving memories for trivial confirmations adds latency without improving responses.

### Stage 2: Parallel Search

When retrieval is warranted, three sources are queried in parallel:

#### A. Mem0 Semantic Search

```typescript
// Query is converted to vector embedding
// Similarity search against stored memory vectors
const mem0Results = await mem0Client.search({
  query: userInput,
  userId: scope.userId,
  personaId: scope.personaId,
  minScore: 0.3, // Filter threshold
});
```

**How it works**:

1. Query text is embedded into a vector
2. Vector similarity search against all stored memory embeddings
3. Results filtered by minimum similarity score (0.3)
4. Ranked by relevance to the query

#### B. Knowledge Retrieval

Structured search across episodic memory:

```typescript
// Three-tier search
const episodes = await episodeRepo.findByTopic(topicKey);
const ledgers = await ledgerRepo.findByCounterpart(counterpart);
const decisions = await ledgerRepo.findDecisions(query);
```

**Episodes**: Thematic conversation blocks containing:

- `topicKey`: Identifies the subject
- `teaser`: Brief summary
- `facts`: Extracted statements
- `sourceSeqStart/End`: Message range reference

**Meeting Ledgers**: Structured meeting data:

- `decisions`: Recorded decisions
- `negotiatedTerms`: Agreed conditions
- `openPoints`: Outstanding issues
- `actionItems`: Tasks assigned
- `participants`: Who was involved

#### C. FTS5 Chat History

Full-text search for specific mentions:

```sql
-- SQLite FTS5 virtual table
SELECT * FROM messages_fts
WHERE content MATCH :query
  AND conversation_id = :convId
ORDER BY rank
LIMIT 10;
```

#### D. Fallback: Lexical Search

For rule-related queries, lexical search is preferred:

```typescript
function isRulesLikeQuery(query: string): boolean {
  const indicators = ['rule', 'policy', 'guideline', 'must', 'should not'];
  return indicators.some((i) => query.toLowerCase().includes(i));
}

// Falls back to keyword matching when semantic search
// yields insufficient results
```

### Stage 3: Fusion

Results from all sources are merged and formatted:

```typescript
function fuseRecallSources(sources: RecallSource[]): string {
  // 1. Deduplicate memories (same content from different sources)
  const unique = deduplicate(sources);

  // 2. Re-rank by combined score
  const ranked = unique.sort((a, b) => b.similarity * b.importance - a.similarity * a.importance);

  // 3. Format for LLM context
  return ranked.map((m) => formatMemoryLine(m)).join('\n');
}
```

**Output format**:

```
[preference] User prefers short answers
[fact] User works in the design industry
[lesson] Previous CSV export failed due to encoding issues
```

---

## Storage Pipeline

After LLM response, the storage pipeline captures relevant information through three paths:

### Path 1: Manual Save

Users explicitly store information using a command prefix:

```
User: Save: My preferred working hours are 9am-5pm CET
```

```typescript
function extractMemorySaveContent(input: string): string | null {
  const prefixes = ['save:', 'save that:', 'remember:'];
  for (const prefix of prefixes) {
    if (input.toLowerCase().startsWith(prefix)) {
      return input.slice(prefix.length).trim();
    }
  }
  return null;
}

// Stored with:
// - Type: 'fact'
// - Importance: 4
// - Source: 'manual_save'
// - Subject: 'user'
```

### Path 2: Auto-Memory

Automatic extraction from conversation:

```typescript
function buildAutoMemoryCandidates(
  messages: Message[],
  conversationSummary: string,
): MemoryCandidate[] {
  // Pattern matching for memory-worthy content
  const candidates = [];

  // User preferences detection
  if (detectPreferencePattern(messages)) {
    candidates.push({
      content: extractPreference(messages),
      type: 'preference',
      importance: 3,
    });
  }

  // Workflow patterns
  if (detectWorkflowPattern(messages)) {
    candidates.push({
      content: extractWorkflow(messages),
      type: 'workflow_pattern',
      importance: 2,
    });
  }

  return candidates;
}
```

**Detection patterns**:

- "I prefer...", "I like..." → preference
- "Every morning I...", "I usually..." → workflow_pattern
- "That didn't work because..." → lesson

### Path 3: Knowledge Ingestion

Structured extraction for complex information:

```typescript
async function ingestConversationWindow(messages: Message[]) {
  // Send to LLM with extraction prompt
  const extracted = await llm.extract({
    messages,
    outputSchema: {
      facts: ['string'],
      teaser: 'string',
      episode: 'string',
      decisions: ['string'],
      actionItems: ['string'],
      openPoints: ['string'],
    },
  });

  // Store in Knowledge Repository
  await episodeRepo.insert({
    topicKey: generateTopicKey(extracted),
    teaser: extracted.teaser,
    episode: extracted.episode,
    facts: extracted.facts,
    sourceSeqStart: messages[0].sequence,
    sourceSeqEnd: messages[messages.length - 1].sequence,
  });

  // Also store facts as individual memories
  for (const fact of extracted.facts) {
    await memoryService.store({
      content: fact,
      type: 'fact',
      importance: 3,
      metadata: { topicKey, source: 'knowledge_ingestion' },
    });
  }
}
```

---

## Long-Term Memory Stores

### Mem0 Cloud (Semantic Memory)

Primary storage for vector-based semantic search.

**Capabilities**:

- Vector embedding storage
- Approximate nearest neighbor (ANN) search
- Multi-tenant isolation
- REST API with automatic retry

**Schema**:

```typescript
interface Mem0Memory {
  id: string;
  content: string;
  user_id: string;
  agent_id: string; // personaId
  metadata: {
    type: MemoryType;
    importance: number;
    confidence: number;
    version: number;
    source: string;
    subject?: string;
  };
  created_at: string;
  updated_at: string;
}
```

**Client Configuration**:

```typescript
const mem0Client = new Mem0Client({
  baseUrl: process.env.MEM0_BASE_URL,
  apiKey: process.env.MEM0_API_KEY,
  apiPath: '/v1',
  timeoutMs: 5000,
  maxRetries: 0, // retries disabled by default
  retryBaseDelayMs: 500,
});
```

### Knowledge Repository (Episodic Memory)

SQLite-based storage for structured knowledge. Implemented as a modular phase-based system; phases are enabled independently via feature flags.

**Phase 1 — Episodes & Ledgers** (core, stable):

```typescript
// Episodes: thematic conversation blocks
interface KnowledgeEpisode {
  id: string;
  userId: string;
  personaId: string;
  conversationId: string;
  topicKey: string;
  counterpart: string | null;
  teaser: string;
  episode: string; // full narrative
  facts: string[]; // extracted statements
  sourceSeqStart: number;
  sourceSeqEnd: number;
  sourceRefs: KnowledgeSourceRef[]; // { seq, quote }
  eventAt: string | null; // ISO date if episode is time-bound
  updatedAt: string;
}

// Meeting Ledgers: structured decisions and agreements
interface MeetingLedgerEntry {
  id: string;
  topicKey: string;
  counterpart: string | null;
  participants: string[];
  decisions: string[];
  negotiatedTerms: string[];
  openPoints: string[];
  actionItems: string[];
  sourceRefs: KnowledgeSourceRef[];
  confidence: number;
  eventAt: string | null;
  updatedAt: string;
}
```

**Phase 1 — Events** (temporal fact store):

Structured events with deduplication, source merging, and aggregation queries. Used for answering questions like "When did X happen?" or "How many times did Y occur?".

**Phase 2 — Entity Graph** (relationship store):

Knowledge entities with aliases, typed relations, and path-finding. Enables queries like "Who is the CEO of Acme?" or "What projects is Alice working on?".

Entity types: `person`, `organization`, `project`, `location`, `concept`, and more.
Relation examples: `works_at`, `manages`, `owns`, `related_to`.

**Phase 3 — Conversation Summaries**:

Per-conversation summaries including key topics, mentioned entities, emotional tone, and message count. Used by the dynamic recall budget to orient context retrieval.

**Retrieval Audit**:

Every knowledge retrieval call is logged with stage statistics and token counts, enabling performance analysis and debugging via `GET /api/knowledge/stats`.

### SQLite Backup (Local Fallback)

Local storage with identical schema to Mem0 for offline operation.

```sql
CREATE TABLE memory_nodes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding_json TEXT,  -- Stored as JSON (not used for search)
  importance INTEGER,
  confidence REAL,
  timestamp INTEGER,
  metadata_json TEXT
);

CREATE INDEX idx_nodes_scope ON memory_nodes(user_id, persona_id);
CREATE INDEX idx_nodes_type ON memory_nodes(type);
CREATE INDEX idx_nodes_importance ON memory_nodes(importance);
```

---

## Learning & Feedback

### Feedback Detection

The system monitors user responses for implicit feedback:

```typescript
function detectMemoryFeedbackSignal(text: string): FeedbackSignal | null {
  const positive = ['correct', 'exactly', 'right', 'yes', 'perfect', 'genau', 'stimmt'];
  const negative = ['wrong', 'incorrect', 'no', 'false', 'falsch', 'stimmt nicht'];

  const lower = text.toLowerCase();

  if (positive.some((p) => lower.includes(p))) {
    return { type: 'positive', confidence: 0.8 };
  }

  if (negative.some((n) => lower.includes(n))) {
    return { type: 'negative', confidence: 0.8 };
  }

  return null;
}
```

### Feedback Processing

```typescript
async function processFeedback(memoryId: string, feedback: FeedbackSignal, userId: string) {
  const memory = await memoryService.get(memoryId, userId);

  if (feedback.type === 'positive') {
    // Reinforce memory
    await memoryService.update({
      id: memoryId,
      confidence: Math.min(1.0, memory.confidence + 0.15),
      importance: Math.min(5, memory.importance + 1),
    });
  } else {
    // Weaken memory
    const newConfidence = memory.confidence - 0.2;
    const newImportance = Math.max(1, memory.importance - 1);

    // Check for auto-deletion
    if (newConfidence < 0.15 && hasThreeNegativeFeedbacks(memoryId)) {
      await memoryService.delete(memoryId, userId);
    } else {
      await memoryService.update({
        id: memoryId,
        confidence: newConfidence,
        importance: newImportance,
      });
    }
  }
}
```

### Correction Handling

When feedback includes a correction, the new information is stored:

```
User: That's wrong. I actually prefer tea, not coffee.
```

```typescript
// Old memory is weakened
await memoryService.registerFeedback({
  memoryId: oldMemoryId,
  feedback: 'negative',
});

// New correction is stored with high importance
await memoryService.store({
  content: 'User prefers tea over coffee',
  type: 'preference',
  importance: 5, // High due to explicit correction
  metadata: {
    source: 'correction',
    replaces: oldMemoryId,
  },
});
```

---

## API Reference

### MemoryService

Main interface for memory operations.

#### `store(options: StoreOptions): Promise<MemoryNode>`

Stores a new memory.

```typescript
interface StoreOptions {
  userId: string;
  personaId: string;
  content: string;
  type?: MemoryType; // default: 'fact'
  importance?: number; // default: 3
  metadata?: Record<string, any>;
}

// Example
const memory = await memoryService.store({
  userId: 'user_123',
  personaId: 'assistant',
  content: 'User prefers email over Slack',
  type: 'preference',
  importance: 4,
});
```

#### `recall(options: RecallOptions): Promise<string>`

Retrieves memories formatted for LLM context.

```typescript
interface RecallOptions {
  userId: string;
  personaId: string;
  query: string;
  limit?: number; // default: 10
}

// Example
const context = await memoryService.recall({
  userId: 'user_123',
  personaId: 'assistant',
  query: 'How should I contact the user?',
});
// Returns formatted string for LLM context
```

#### `recallDetailed(options: RecallOptions): Promise<MemoryResult[]>`

Retrieves memories with scores for programmatic use.

```typescript
interface MemoryResult {
  id: string;
  content: string;
  type: MemoryType;
  importance: number;
  confidence: number;
  similarity: number; // Search relevance score
  metadata: Record<string, any>;
}

// Example
const results = await memoryService.recallDetailed({
  userId: 'user_123',
  personaId: 'assistant',
  query: 'communication preferences',
});
// Returns array with relevance scores
```

#### `update(options: UpdateOptions): Promise<MemoryNode>`

Updates an existing memory with optional version check.

```typescript
interface UpdateOptions {
  id: string;
  userId: string;
  content?: string;
  importance?: number;
  confidence?: number;
  metadata?: Record<string, any>;
  expectedVersion?: number; // For optimistic locking
}

// Example with version check
try {
  await memoryService.update({
    id: 'mem_abc',
    userId: 'user_123',
    content: 'Updated information',
    expectedVersion: 2,
  });
} catch (e) {
  if (e instanceof MemoryVersionConflictError) {
    // Handle conflict - memory was modified elsewhere
  }
}
```

#### `delete(id: string, userId: string): Promise<void>`

Deletes a memory.

```typescript
await memoryService.delete('mem_abc', 'user_123');
```

#### `registerFeedback(options: FeedbackOptions): Promise<void>`

Processes user feedback on a memory.

```typescript
interface FeedbackOptions {
  memoryId: string;
  feedback: 'positive' | 'negative';
  userId: string;
}

await memoryService.registerFeedback({
  memoryId: 'mem_abc',
  feedback: 'negative',
  userId: 'user_123',
});
```

#### `history(id: string, userId: string): Promise<MemoryVersion[]>`

Retrieves version history of a memory.

```typescript
const history = await memoryService.history('mem_abc', 'user_123');
// Returns array of previous versions
```

#### `restoreFromHistory(options: RestoreOptions): Promise<MemoryNode>`

Restores a memory to a previous version.

```typescript
await memoryService.restoreFromHistory({
  id: 'mem_abc',
  userId: 'user_123',
  version: 1,
  expectedVersion: 3, // Optional version check
});
```

### KnowledgeRetrievalService

Retrieves structured knowledge context.

#### `buildContext(options: BuildContextOptions): Promise<KnowledgeContext>`

Builds comprehensive context from all knowledge sources.

```typescript
interface BuildContextOptions {
  userId: string;
  personaId: string;
  query: string;
  counterpart?: string; // Filter by conversation partner
}

interface KnowledgeRetrievalResult {
  context: string; // Formatted string for LLM injection
  sections: {
    answerDraft: string; // Contextual introduction
    keyDecisions: string; // Relevant decisions (formatted)
    openPoints: string; // Outstanding items (formatted)
    evidence: string; // Supporting message excerpts (formatted)
  };
  references: string[]; // Source IDs for citations
  tokenCount: number; // Approximate token usage
  computedAnswer?: string | null; // Pre-computed direct answer (event queries)
}

// Example
const result = await knowledgeRetrieval.buildContext({
  userId: 'user_123',
  personaId: 'assistant',
  query: 'What did we agree with the vendor?',
  counterpart: 'vendor_acme',
});
```

---

## Configuration

### Environment Variables

#### Core Memory Settings

| Variable                   | Description                           | Required         | Default |
| -------------------------- | ------------------------------------- | ---------------- | ------- |
| `MEMORY_PROVIDER`          | Storage provider (`mem0` or `sqlite`) | Yes              | -       |
| `MEM0_BASE_URL`            | Mem0 API base URL                     | If provider=mem0 | -       |
| `MEM0_API_KEY`             | Mem0 API authentication key           | If provider=mem0 | -       |
| `MEM0_API_PATH`            | API version path                      | No               | `/v1`   |
| `MEM0_TIMEOUT_MS`          | Request timeout in milliseconds       | No               | `5000`  |
| `MEM0_MAX_RETRIES`         | Number of retry attempts              | No               | `0`     |
| `MEM0_RETRY_BASE_DELAY_MS` | Base delay for exponential backoff    | No               | `500`   |

#### SQLite Settings

| Variable           | Description                  | Required | Default              |
| ------------------ | ---------------------------- | -------- | -------------------- |
| `MEMORY_DB_PATH`   | Path to SQLite database file | No       | `.local/messages.db` |
| `MESSAGES_DB_PATH` | Fallback for database path   | No       | `.local/messages.db` |

#### Knowledge Layer Settings

| Variable                            | Description                                 | Required | Default           |
| ----------------------------------- | ------------------------------------------- | -------- | ----------------- |
| `KNOWLEDGE_LAYER_ENABLED`           | Master switch for knowledge system          | No       | `false`           |
| `KNOWLEDGE_LEDGER_ENABLED`          | Enable meeting ledgers                      | No       | `false`           |
| `KNOWLEDGE_EPISODE_ENABLED`         | Enable episode storage                      | No       | `false`           |
| `KNOWLEDGE_RETRIEVAL_ENABLED`       | Enable knowledge retrieval                  | No       | `false`           |
| `KNOWLEDGE_MAX_CONTEXT_TOKENS`      | Maximum tokens for knowledge context        | No       | `4000`            |
| `KNOWLEDGE_INGEST_INTERVAL_MS`      | Minimum interval between ingestions         | No       | `600000` (10 min) |
| `KNOWLEDGE_MIN_MESSAGES_PER_BATCH`  | Minimum messages required per batch         | No       | `1`               |
| `KNOWLEDGE_CONTRADICTION_DETECTION` | Enable contradiction detection (Phase 3)    | No       | `false`           |
| `KNOWLEDGE_CORRECTION_DETECTION`    | Enable correction detection (Phase 3)       | No       | `false`           |
| `KNOWLEDGE_DYNAMIC_RECALL_BUDGET`   | Enable dynamic recall budget (Phase 5)      | No       | `false`           |
| `KNOWLEDGE_CONVERSATION_SUMMARY`    | Enable conversation summarization (Phase 5) | No       | `false`           |
| `KNOWLEDGE_MEMORY_CONSOLIDATION`    | Enable memory consolidation (Phase 5)       | No       | `false`           |
| `KNOWLEDGE_PERSONA_TYPE_AWARENESS`  | Enable persona-type-aware recall (Phase 6)  | No       | `false`           |
| `KNOWLEDGE_EMOTION_TRACKING`        | Enable emotion tracking (roleplay personas) | No       | `false`           |
| `KNOWLEDGE_PROJECT_TRACKING`        | Enable project tracking (builder personas)  | No       | `false`           |
| `KNOWLEDGE_TASK_TRACKING`           | Enable task tracking (assistant personas)   | No       | `false`           |

### TypeScript Interfaces

```typescript
// Core types
type MemoryType =
  | 'fact'
  | 'preference'
  | 'avoidance'
  | 'lesson'
  | 'personality_trait'
  | 'workflow_pattern';

interface MemoryNode {
  id: string;
  type: MemoryType;
  content: string;
  importance: number; // 1-5
  confidence: number; // 0.1-1.0
  timestamp: number;
  metadata: {
    version: number;
    source: string;
    subject?: string;
    topicKey?: string;
    [key: string]: any;
  };
}

interface MemoryScope {
  userId: string;
  personaId: string;
}
```

---

## Error Handling

### Error Types

| Error                        | Cause                                  | Handling                              |
| ---------------------------- | -------------------------------------- | ------------------------------------- |
| `MemoryNotFoundError`        | Memory ID doesn't exist                | Return null or throw based on context |
| `MemoryVersionConflictError` | Expected version doesn't match current | Retry with fresh data or alert user   |
| `Mem0ConnectionError`        | Cannot reach Mem0 service              | Fall back to SQLite if available      |
| `Mem0TimeoutError`           | Request exceeded timeout               | Retry with exponential backoff        |
| `Mem0AuthenticationError`    | Invalid API key                        | Log error and fail fast               |

### Retry Logic

The Mem0Client implements exponential backoff:

```typescript
// Retry delays: 1s, 2s, 4s (with maxRetries=3)
const delay = retryBaseDelayMs * Math.pow(2, attempt);
```

Retried errors:

- Network timeouts
- HTTP 5xx server errors
- Rate limiting (HTTP 429)

Non-retried errors:

- HTTP 4xx client errors
- Authentication failures
- Invalid request payloads

---

## Performance Considerations

### Recall Pipeline Optimization

1. **Decision Gate**: Skipping retrieval for trivial inputs saves ~100-200ms
2. **Parallel Search**: Simultaneous Mem0 + Knowledge queries reduce latency
3. **Caching**: Recently recalled memories are cached per conversation
4. **Early Termination**: Search stops when sufficient high-quality results found

### Storage Optimization

1. **Batching**: Multiple auto-memories are batched into single write
2. **Async Ingestion**: Knowledge extraction runs asynchronously
3. **Lazy Sync**: SQLite sync with Mem0 is deferred when possible

### Query Patterns

For optimal retrieval, structure queries to match stored content:

```typescript
// Good: Specific, entity-focused queries
const results = await memoryService.recall({
  query: 'vendor payment terms',
});

// Less effective: Vague queries
const results = await memoryService.recall({
  query: 'tell me about stuff',
});
```

---

## Security & Privacy

### Data Isolation

- **User-scoped**: All memories include `userId` in query filters
- **Persona-scoped**: Each persona has isolated memory space
- **No cross-contamination**: Queries cannot return other users' data

### API Security

- API keys stored server-side only
- Never exposed to clients
- HTTPS enforced for Mem0 communication

### Retention

- No automatic deletion (except via feedback loop)
- Manual deletion via `memoryService.delete()`
- Version history retained indefinitely

### Memory Poisoning Guard

Active defense against prompt-injection attacks that attempt to write malicious content into the knowledge store. Implemented in `src/server/knowledge/security/memoryPoisoningGuard.ts`.

The guard runs on every ingested message and blocks patterns such as:

- Instructions to override persona behavior (`"Ignore previous instructions..."`)
- Attempts to exfiltrate stored memories
- Encoded or obfuscated injection payloads

Blocked messages are rejected before the ingestion pipeline writes them to the repository.

---

## Testing

### Unit Tests

```typescript
describe('MemoryService', () => {
  it('should store and retrieve memory', async () => {
    const memory = await service.store({
      userId: 'test_user',
      personaId: 'test_persona',
      content: 'Test memory',
    });

    const recalled = await service.recall({
      userId: 'test_user',
      personaId: 'test_persona',
      query: 'test',
    });

    expect(recalled).toContain('Test memory');
  });

  it('should handle version conflicts', async () => {
    await expect(
      service.update({
        id: 'mem_123',
        userId: 'test_user',
        expectedVersion: 1, // Actual is 2
      }),
    ).rejects.toThrow(MemoryVersionConflictError);
  });
});
```

### Integration Tests

Test the complete recall pipeline with real Mem0 instance (or mocked):

```typescript
describe('Recall Pipeline', () => {
  it('should skip retrieval for confirmations', () => {
    expect(shouldRecallMemoryForInput('ok')).toBe(false);
    expect(shouldRecallMemoryForInput('thanks!')).toBe(false);
  });

  it('should fuse multiple sources', async () => {
    const result = await buildRecallContext({
      userId: 'test_user',
      query: 'project timeline',
    });

    expect(result).toContainSources(['mem0', 'episodes', 'ledgers']);
  });
});
```
