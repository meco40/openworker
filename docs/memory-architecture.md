# Memory Architecture

This document describes the complete memory system architecture, covering the full data flow from user input through context retrieval, LLM processing, storage, and feedback loops.

## Overview

The memory system is a multi-layered architecture that enables the AI assistant to maintain context across conversations and learn from interactions. It combines **semantic vector search** (Mem0) with **structured episodic memory** (Knowledge Repository) and **local backup storage** (SQLite).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MEMORY ARCHITECTURE                                 │
│                    Complete Data Flow & Retrieval                           │
└─────────────────────────────────────────────────────────────────────────────┘

╔═════════════════════════════════════════════════════════════════════════════╗
║  LAYER 1: WORKING MEMORY (Session Context)                                  ║
╠═════════════════════════════════════════════════════════════════════════════╣
║  • Current conversation messages   • Active user intent                     ║
║  • Temporary context window        • Ephemeral — cleared after session      ║
╚═════════════════════════════════════════════════════════════════════════════╝
                                    │
                                    │ User sends message
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      RECALL PIPELINE (Context Building)                     │
│                                                                             │
│  ┌──────────────────┐   ┌──────────────────────────────┐   ┌─────────────┐ │
│  │ 1. DECISION      │   │ 2. ENTITY RESOLUTION         │   │ 3. PARALLEL │ │
│  │                  │   │                              │   │    SEARCH   │ │
│  │ Skip if trivial: │   │ resolveEntity("mein Bruder") │   │             │ │
│  │ "ok", "thanks",  │   │  → KnowledgeEntity: Max      │   │ ┌─────────┐ │ │
│  │ "yes", "hello"   │   │                              │   │ │  MEM0   │ │ │
│  │                  │   │ resolvePronouns("er")        │   │ │Semantic │ │ │
│  │ → skip retrieval │   │  → "Max"                     │   │ │ Search  │ │ │
│  │                  │   │                              │   │ │score≥0.3│ │ │
│  └──────────────────┘   └──────────────────────────────┘   │ └────┬────┘ │ │
│                                                            │      │      │ │
│                                                            │ ┌────▼────┐ │ │
│                                                            │ │KNOWLEDGE│ │ │
│                                                            │ │RETRIEVAL│ │ │
│                                                            │ │         │ │ │
│                                                            │ │Episodes │ │ │
│                                                            │ │Ledgers  │ │ │
│                                                            │ │Events   │ │ │
│                                                            │ │EntityGph│ │ │
│                                                            │ │FTS5 Chat│ │ │
│                                                            │ └────┬────┘ │ │
│                                                            │      │      │ │
│                                                            │ ┌────▼────┐ │ │
│                                                            │ │FALLBACK │ │ │
│                                                            │ │ Lexical │ │ │
│                                                            │ │(rules Q)│ │ │
│                                                            │ └─────────┘ │ │
│                                                            └─────────────┘ │
│                                                                    │        │
│  ┌─────────────────────────────────────────────────────────────────▼──────┐ │
│  │ 4. FUSION  — Deduplicate · Re-rank by (similarity × importance)        │ │
│  │             Format for LLM:  [preference] ... / [fact] ... / [lesson]  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Context + Prompt
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            LLM PROCESSING                                   │
│  • Generate response using retrieved context                                │
│  • Store response in conversation history                                   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       │ After response
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     STORAGE PIPELINE (Memory Formation)                     │
│                                                                             │
│  ┌─────────────────┐   ┌─────────────────┐   ┌──────────────────────────┐  │
│  │  MANUAL SAVE    │   │  AUTO-MEMORY    │   │  KNOWLEDGE INGESTION     │  │
│  │                 │   │                 │   │                          │  │
│  │ "Save: ..."     │   │ buildAutoMemory │   │ ┌──────────────────────┐ │  │
│  │ prefix detected │   │ Candidates()    │   │ │ Poisoning Guard      │ │  │
│  │                 │   │                 │   │ │ (blocks injections)  │ │  │
│  │ Importance: 4   │   │ Importance: 2-3 │   │ └──────────┬───────────┘ │  │
│  │ Type: fact      │   │ Type: detected  │   │            │ passed      │  │
│  │ Source: manual  │   │ Source: auto    │   │            ▼             │  │
│  └────────┬────────┘   └────────┬────────┘   │ LLM extracts:            │  │
│           │                     │            │ • facts / episodes       │  │
│           │                     │            │ • ledgers / events       │  │
│           │                     │            │ • entities + relations   │  │
│           │                     │            │ • pronouns resolved      │  │
│           │                     │            └────────────┬────────────┘  │
│           └─────────────────────┼─────────────────────────┘                │
│                                 │                                          │
│                                 ▼                                          │
│  ╔═══════════════════════════════════════════════════════════════════════╗ │
│  ║  LAYER 2: LONG-TERM MEMORY (Persistent Storage)                       ║ │
│  ╠═══════════════════════════════════════════════════════════════════════╣ │
│  ║                                                                       ║ │
│  ║  ┌─────────────────────┐   ┌──────────────────────────────────────┐  ║  │
│  ║  │    MEM0 CLOUD       │   │         KNOWLEDGE REPOSITORY         │  ║  │
│  ║  │  (Semantic Memory)  │   │                                      │  ║  │
│  ║  │                     │   │  Phase 1  Episodes (topicKey, facts) │  ║  │
│  ║  │ Vector embeddings   │   │           Meeting Ledgers            │  ║  │
│  ║  │ Similarity search   │   │           (decisions, actionItems)   │  ║  │
│  ║  │                     │   │           Events (temporal facts,    │  ║  │
│  ║  │ Memory types:       │   │           dedup, aggregation)        │  ║  │
│  ║  │  fact, preference,  │   │                                      │  ║  │
│  ║  │  avoidance, lesson, │   │  Phase 2  Entity Graph               │  ║  │
│  ║  │  personality_trait, │   │           Entities + Aliases         │  ║  │
│  ║  │  workflow_pattern   │   │           (Max ← "mein Bruder")      │  ║  │
│  ║  │                     │   │           Relations (works_at, ...)  │  ║  │
│  ║  │ Metadata:           │   │           Path-finding               │  ║  │
│  ║  │  importance (1-5)   │   │                                      │  ║  │
│  ║  │  confidence (0-1)   │   │  Phase 3  Conversation Summaries     │  ║  │
│  ║  │  version            │   │           (topics, entities, tone)   │  ║  │
│  ║  │  userId+personaId   │   │                                      │  ║  │
│  ║  └──────────┬──────────┘   │           Retrieval Audit log        │  ║  │
│  ║             │              └──────────────────────────────────────┘  ║  │
│  ║             │                                                        ║  │
│  ║             ▼                                                        ║  │
│  ║  ┌─────────────────────┐                                             ║  │
│  ║  │   SQLITE BACKUP     │                                             ║  │
│  ║  │  (Local Fallback)   │  memory_nodes table · offline access        ║  │
│  ║  └─────────────────────┘                                             ║  │
│  ╚═══════════════════════════════════════════════════════════════════════╝  │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       │ FEEDBACK LOOP
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       LEARNING & MAINTENANCE                                │
│                                                                             │
│  "Correct" / "Exactly"  ──►  Confidence +0.15, Importance +1               │
│                                                                             │
│  "Wrong" / "Incorrect"  ──►  Confidence -0.2,  Importance -1               │
│                                      │                                      │
│                                      ▼                                      │
│                       3× Negative + Confidence < 0.15                       │
│                                      │                                      │
│                                      ▼                                      │
│                                 AUTO-DELETE                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  NEXT SESSION CYCLE                                                         │
│  Same Recall Pipeline ──► Context enriched with stored memories             │
│                         ──► Entity Graph resolves references automatically  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [Architecture Layers](#architecture-layers)
3. [Recall Pipeline](#recall-pipeline)
4. [Storage Pipeline](#storage-pipeline)
5. [Long-Term Memory Stores](#long-term-memory-stores)
6. [Entity Graph](#entity-graph)
7. [Fact Lifecycle](#fact-lifecycle)
8. [Learning & Feedback](#learning--feedback)
9. [API Reference](#api-reference)
10. [Configuration](#configuration)
11. [Security & Privacy](#security--privacy)
12. [Testing](#testing)

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

The recall pipeline builds context before LLM processing through four stages:

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

### Stage 2: Entity Resolution

Before the parallel search, named references and pronouns in the query are resolved to known entity IDs from the Entity Graph:

```typescript
// Query: "Was hat mein Bruder gesagt?"
const resolved = knowledgeRepo.resolveEntity('mein Bruder', { userId, personaId });
// → { entity: { id: 'ent-abc', canonicalName: 'Max' }, matchType: 'alias', confidence: 0.9 }
// Subsequent queries are scoped to episodes/ledgers where counterpart = 'ent-abc'
```

**Self-Reference Query Expansion**: `MemoryService` additionally expands perspective pronouns before the Mem0 search. When the user asks `"Was kannst du?"`, the query is also sent as `"Was kann ich?"` — ensuring persona self-reference memories (stored in first-person) surface for second-person queries and vice versa.

```typescript
// Implemented in MemoryService.expandSelfReferenceQuery()
// 'du hast mir gesagt' → also searches 'ich habe dir gesagt'
```

**Memory Subject Classification**: Every recalled memory node is tagged with a subject before LLM injection, derived from content patterns and stored metadata:

| Subject        | Detection                                | LLM Context Tag                        |
| -------------- | ---------------------------------------- | -------------------------------------- |
| `user`         | `du`/`dein`/`your` content patterns      | `[Subject: user]`                      |
| `assistant`    | `ich`/`mein`/`I` self-reference patterns | `[Subject: assistant, Self-Reference]` |
| `conversation` | `metadata.subject = 'conversation'`      | `[Subject: conversation]`              |
| `null`         | Indeterminate                            | _(no tag)_                             |

This classification prevents the LLM from confusing persona self-memories with facts about the user.

### Stage 3: Parallel Search

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

### Stage 4: Fusion

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

See the dedicated [Entity Graph](#entity-graph) section for full documentation.

**Phase 3 — Conversation Summaries**:

Per-conversation summaries including key topics, mentioned entities, emotional tone, and message count. Used by the dynamic recall budget to orient context retrieval.

**Retrieval Audit**:

Every knowledge retrieval call is logged with stage statistics and token counts, enabling performance analysis and debugging via `GET /api/control-plane/metrics` (`metrics.knowledge`).

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

## Entity Graph

The Entity Graph is the relationship layer of the Knowledge Repository. It enables the system to recognize that "Max", "mein Bruder", and "er" all refer to the same entity, and to traverse relationships between entities when building recall context.

Storage location: `src/server/knowledge/entityGraph.ts`, `entityExtractor.ts`, `pronounResolver.ts`.
Enabled when: `KNOWLEDGE_LAYER_ENABLED=true`.

### Data Model

```typescript
// An entity is a named thing the system knows about
type EntityCategory =
  | 'person' // Max, Lisa, Tante Erna
  | 'project' // Notes2, MeinBlog
  | 'place' // Berlin, Büro, Zuhause
  | 'organization' // Siemens, BMW
  | 'concept' // Next.js, TypeScript
  | 'object'; // Auto, Laptop

interface KnowledgeEntity {
  id: string; // 'ent-xxx'
  userId: string;
  personaId: string;
  canonicalName: string; // 'Max'
  category: EntityCategory;
  owner: 'persona' | 'user' | 'shared'; // whose context — e.g. 'mein Bruder' → owner: 'user'
  properties: Record<string, string>; // { beruf: 'Ingenieur', alter: '28' }
  createdAt: string;
  updatedAt: string;
}

// Aliases let the system resolve references to the same entity
interface EntityAlias {
  id: string;
  entityId: string;
  alias: string; // 'mein Bruder', 'er', 'Bruder'
  aliasType: 'name' | 'relation' | 'pronoun' | 'abbreviation';
  owner: 'persona' | 'user' | 'shared';
  confidence: number; // 0.0–1.0
  createdAt: string;
}

// Relations link two entities with a typed, directional edge
interface EntityRelation {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string; // 'bruder', 'auftraggeber', 'framework'
  properties: Record<string, string>; // { seit: '2026-01', status: 'aktiv' }
  confidence: number;
  createdAt: string;
  updatedAt: string;
}
```

### How Entities Are Extracted

During knowledge ingestion, the LLM extracts entities from the conversation window. The `EntityExtractor` class normalizes, validates, and deduplicates the raw LLM output before it reaches the repository:

```typescript
interface ExtractedEntity {
  name: string;
  category: EntityCategory;
  owner: 'persona' | 'user' | 'shared';
  aliases: string[]; // ['mein Bruder', 'Bruder']
  relations: {
    targetName: string;
    relationType: string;
    direction: 'outgoing' | 'incoming';
  }[];
  properties: Record<string, string>;
  sourceSeq: number[]; // Message sequence numbers
}
```

When a new entity arrives:

1. The repository tries to resolve the canonical name against existing entities.
2. If a match is found → **merge**: new aliases and properties are added, existing relations updated.
3. If no match → **create**: a new entity node is inserted.

### Pronoun Resolution

Before facts are written, reference pronouns are resolved to entity names to avoid dangling references:

```typescript
// 'er' → 'Max' (when Max was last mentioned)
resolvePronouns('er ist Ingenieur', { lastMentionedPerson: 'Max', ... })
// → 'Max ist Ingenieur'
```

Only masculine reference pronouns (`er`, `ihm`, `sein`, …) are resolved — feminine/neutral pronouns like `sie`/`ihr` are intentionally left ambiguous to avoid incorrect resolution.

Perspective pronouns (`ich`, `mein`, `du`, `dein`) are never resolved and remain as-is.

### Entity Resolution During Recall

When the retrieval service processes a query, it resolves named references to entity IDs before searching:

```
Query: "Was hat mein Bruder gesagt?"
         │
         ▼
 resolveEntity("mein Bruder") → { entity: Max, matchType: 'alias', confidence: 0.9 }
         │
         ▼
 Retrieve all episodes + ledgers where counterpart = Max.id
         │
         ▼
 Return context scoped to that entity
```

Lookup strategies (in priority order):

| Match Type   | Example                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `exact_name` | Query contains `"Max"` and an entity with `canonicalName: 'Max'` exists |
| `alias`      | Query contains `"mein Bruder"` and an alias entry maps it to Max        |
| `relation`   | Query contains `"Bruder"` and a relation-word alias resolves it         |
| `fuzzy`      | Partial name match with confidence score                                |

### Path Finding

The repository supports multi-hop traversal for questions like "What does the company that Alice works for do?":

```typescript
// Returns the chain of relation edges from entityA to entityB
repository.findPath(entityA.id, entityB.id, maxDepth?: number): EntityRelation[]
```

### Relation-Word Aliases

German relationship words are detected automatically as the `relation` alias type:

> `bruder`, `schwester`, `mutter`, `vater`, `freund`, `freundin`, `tante`, `onkel`, `oma`, `opa`, `partner`, `partnerin`, `chef`, `kollege`, `nachbar`, …

When a user says _"Mein Bruder heißt Max"_, the alias `mein Bruder` is stored for the entity `Max` with `aliasType: 'relation'` and `owner: 'user'`.

### Multilingual Alias Expansion

Entity aliases support automatic DE/EN equivalence via `src/server/knowledge/multilingualAliases.ts`. When an alias is stored or resolved, it is expanded to include cross-language equivalents:

| German      | English equivalents     |
| ----------- | ----------------------- |
| `bruder`    | `brother`, `bro`        |
| `schwester` | `sister`, `sis`         |
| `mutter`    | `mother`, `mom`, `mama` |
| `vater`     | `father`, `dad`, `papa` |
| `freund`    | `friend`, `buddy`       |
| `kollege`   | `colleague`, `coworker` |
| `projekt`   | `project`               |
| `aufgabe`   | `task`, `todo`          |

Querying `"brother"` therefore finds entities aliased as `"Bruder"`, and vice versa.

---

## Fact Lifecycle

Every fact, event, and entity in the Knowledge Repository passes through a state machine defined in `src/server/knowledge/factLifecycle.ts`. Only **active** facts (`new` or `confirmed`) are returned in recall results — stale, superseded, or rejected facts are silently excluded.

### States

```
new ───────────────────────────────────────────► confirmed
 │                  ▲                           │
 │           reactivated                        │
 ▼                  │                           ▼
rejected ◄── garbage_collected ──── superseded ◄── contradicted / corrected
                                        │
                                   time_expired
                                        │
                                        ▼
                                      stale
```

| State        | Description                             | Included in Recall |
| ------------ | --------------------------------------- | ------------------ |
| `new`        | Just extracted, not yet confirmed       | ✅ Yes             |
| `confirmed`  | Repeated in session or user-confirmed   | ✅ Yes             |
| `stale`      | Time-expired but not deleted            | ❌ No              |
| `superseded` | Replaced by contradiction or correction | ❌ No              |
| `rejected`   | Garbage-collected (low confidence)      | ❌ No              |

### Transition Signals

```typescript
type LifecycleSignal =
  | 'user_confirmed' // explicit positive feedback → confirmed
  | 'repeated_in_session' // same fact seen again → new → confirmed
  | 'contradicted' // conflicting fact detected → superseded
  | 'corrected_by_user' // user corrects → superseded
  | 'time_expired' // no longer current → stale
  | 'reactivated' // fact becomes relevant again → confirmed
  | 'garbage_collected'; // low-confidence cleanup → rejected
```

The state machine is a pure function `transitionLifecycle(currentStatus, signal)` — no side effects, fully testable in isolation.

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
await memoryService.registerFeedback(personaId, [oldMemoryId], 'negative', userId);

// New correction is stored with high importance
await memoryService.store(
  personaId,
  'preference',
  'User prefers tea over coffee',
  5, // High due to explicit correction
  userId,
  { source: 'correction', replaces: oldMemoryId },
);
```

---

## API Reference

> All `MemoryService` methods use **positional arguments**, not option objects. The first argument is always `personaId`; `userId` is an optional trailing argument.

### MemoryService

Main interface for memory operations. Source: `src/server/memory/service.ts`.

#### `store(personaId, type, content, importance, userId?, metadata?): Promise<MemoryNode>`

Stores a new memory.

```typescript
// Signature
store(
  personaId: string,
  type: MemoryType,
  content: string,
  importance: number,         // 1–5
  userId?: string,
  metadata?: Record<string, unknown>,
): Promise<MemoryNode>

// Example
const node = await memoryService.store(
  'assistant',
  'preference',
  'User prefers email over Slack',
  4,
  'user_123',
);
```

#### `recall(personaId, query, limit?, userId?): Promise<string>`

Returns memories formatted as a single string for LLM context injection. The string includes `[Type: ...]` and optional `[Subject: ...]` tags per memory.

```typescript
// Signature
recall(
  personaId: string,
  query: string,
  limit?: number,    // default: 3
  userId?: string,
): Promise<string>

// Example
const context = await memoryService.recall('assistant', 'communication preferences', 5, 'user_123');
// Returns: "[Type: preference] User prefers email over Slack [Subject: user]\n..."
```

#### `recallDetailed(personaId, query, limit?, userId?): Promise<MemoryRecallResult>`

Returns memories with individual similarity scores for programmatic processing.

```typescript
// Return type
interface MemoryRecallResult {
  context: string; // Same formatted string as recall()
  matches: MemoryRecallMatch[];
}

interface MemoryRecallMatch {
  node: MemoryNode;
  similarity: number; // 0.0–1.0, filtered to ≥ 0.3
  score: number; // Alias for similarity (used for sorting)
}

// Example
const result = await memoryService.recallDetailed('assistant', 'vendor agreement', 5, 'user_123');
for (const match of result.matches) {
  console.log(match.node.content, match.similarity);
}
```

#### `update(personaId, nodeId, input, userId?): Promise<MemoryNode | null>`

Updates an existing memory. Returns `null` if the memory was not found. Throws `MemoryVersionConflictError` if `expectedVersion` is provided and does not match.

```typescript
// Input type
interface UpdateInput {
  type?: MemoryType;
  content?: string;
  importance?: number;
  expectedVersion?: number; // Optimistic concurrency check
}

// Example
const updated = await memoryService.update(
  'assistant',
  'mem_abc123',
  { content: 'Updated information', expectedVersion: 2 },
  'user_123',
);
```

#### `delete(personaId, nodeId, userId?): Promise<boolean>`

Deletes a single memory. Returns `true` if deleted, `false` if not found.

```typescript
const deleted = await memoryService.delete('assistant', 'mem_abc123', 'user_123');
```

#### `deleteByPersona(personaId, userId?): Promise<number>`

Deletes all memories for a persona. Returns the count of deleted records.

```typescript
const count = await memoryService.deleteByPersona('assistant', 'user_123');
```

#### `registerFeedback(personaId, nodeIds, signal, userId?): Promise<number>`

Applies a feedback signal to one or more memory nodes. Returns the count of updated nodes. Nodes that drop below `confidence < 0.15` after three negative signals are auto-deleted.

```typescript
// signal: 'positive' → confidence +0.15, importance +1
//         'negative' → confidence −0.2,  importance −1 (auto-delete at threshold)
const changed = await memoryService.registerFeedback(
  'assistant',
  ['mem_abc123', 'mem_def456'],
  'negative',
  'user_123',
);
```

#### `history(personaId, nodeId, userId?): Promise<{ node: MemoryNode; entries: MemoryHistoryRecord[] } | null>`

Returns the full version history of a memory node. Returns `null` if not found.

```typescript
const result = await memoryService.history('assistant', 'mem_abc123', 'user_123');
if (result) {
  console.log(`Current: ${result.node.content}`);
  console.log(`${result.entries.length} history entries`);
}
```

#### `restoreFromHistory(personaId, nodeId, input, userId?): Promise<MemoryNode | null>`

Restores a memory to a previous version by 0-based history index. Returns `null` if not found.

```typescript
// input.restoreIndex is the 0-based index into entries returned by history()
await memoryService.restoreFromHistory(
  'assistant',
  'mem_abc123',
  { restoreIndex: 0, expectedVersion: 3 },
  'user_123',
);
```

### KnowledgeRetrievalService

Retrieves structured knowledge context. Source: `src/server/knowledge/retrievalService.ts`.

#### `buildContext(input: KnowledgeRetrievalInput): Promise<KnowledgeRetrievalResult>`

Builds comprehensive context from all available knowledge sources (episodes, ledgers, events, entity graph, Mem0 semantic search).

```typescript
interface KnowledgeRetrievalInput {
  userId: string;
  personaId: string;
  conversationId?: string;
  query: string;
}

interface KnowledgeRetrievalResult {
  context: string; // Formatted context string for LLM injection
  sections: {
    answerDraft: string; // Contextual introduction
    keyDecisions: string; // Relevant decisions (formatted)
    openPoints: string; // Outstanding items
    evidence: string; // Supporting message excerpts
  };
  references: string[]; // Source IDs for citations
  tokenCount: number; // Approximate token usage
  computedAnswer?: string | null; // Pre-computed direct answer for event queries
}

// Example
const result = await knowledgeRetrieval.buildContext({
  userId: 'user_123',
  personaId: 'assistant',
  query: 'What did we agree with the vendor?',
  conversationId: 'conv_abc',
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

Not-found conditions are **not** signaled by exceptions — affected methods return `null` or `false` instead.

| Error                        | Cause                                           | Handling                                                           |
| ---------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| `MemoryVersionConflictError` | `expectedVersion` doesn’t match current version | Thrown by `update()` and `restoreFromHistory()` — reload and retry |
| `Mem0ConnectionError`        | Cannot reach Mem0 service                       | Fall back to SQLite if available                                   |
| `Mem0TimeoutError`           | Request exceeded timeout                        | Retry with exponential backoff                                     |
| `Mem0AuthenticationError`    | Invalid API key                                 | Log error and fail fast                                            |

### Retry Logic

The Mem0Client implements exponential backoff:

```typescript
// Base delay: retryBaseDelayMs (default 500 ms)
// Retry 1: 500 ms, Retry 2: 1000 ms, Retry 3: 2000 ms, …
// Default maxRetries=0 (retries disabled; set MEM0_MAX_RETRIES > 0 to enable)
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

### Answer Safety Policy

When building knowledge context, the `KnowledgeRetrievalService` assesses the strength of retrieved evidence and may inject hedging instructions into the system prompt. Implemented in `src/server/knowledge/answerSafetyPolicy.ts`.

| Safety Level | Condition                                                     | System Prompt Effect                                 |
| ------------ | ------------------------------------------------------------- | ---------------------------------------------------- |
| `confident`  | ≥ 3 sources, avg confidence ≥ 0.7, or computed answer present | No hedging — answer freely                           |
| `hedged`     | ≥ 1 source, avg confidence ≥ 0.5                              | `"Soweit ich mich erinnere…"` guidance injected      |
| `caveat`     | ≥ 1 source with low confidence                                | `"Ich bin mir nicht ganz sicher…"` guidance injected |
| `decline`    | No reliable evidence found                                    | Persona instructed not to fabricate facts            |

This prevents confident hallucinations when memory coverage is sparse.

---

## Testing

### Unit Tests

```typescript
describe('MemoryService', () => {
  it('should store and recall a memory', async () => {
    // store(personaId, type, content, importance, userId)
    await service.store('test_persona', 'fact', 'Test memory', 3, 'test_user');

    // recall(personaId, query, limit, userId)
    const context = await service.recall('test_persona', 'test', 5, 'test_user');

    expect(context).toContain('Test memory');
  });

  it('should throw MemoryVersionConflictError on version mismatch', async () => {
    // update(personaId, nodeId, input, userId)
    await expect(
      service.update(
        'test_persona',
        'mem_123',
        { content: 'updated', expectedVersion: 1 }, // Actual version is 2
        'test_user',
      ),
    ).rejects.toThrow(MemoryVersionConflictError);
  });
});
```

### Integration Tests

Test the complete recall pipeline with real Mem0 instance (or mocked):

```typescript
describe('Recall Pipeline', () => {
  it('should skip retrieval for short confirmations', () => {
    expect(shouldRecallMemoryForInput('ok')).toBe(false);
    expect(shouldRecallMemoryForInput('thanks!')).toBe(false);
  });

  it('should resolve entity aliases before searching', async () => {
    // 'mein Bruder' stored as alias for entity Max
    const result = knowledgeRepo.resolveEntity('mein Bruder', { userId, personaId });
    expect(result?.entity.canonicalName).toBe('Max');
  });

  it('should expand self-reference pronouns in query', () => {
    const expanded = service['expandSelfReferenceQuery']('du hast mir gesagt');
    expect(expanded).toContain('ich habe dir gesagt');
  });
});
```
