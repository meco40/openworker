# Knowledge Base for Agent Access Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a production-ready, user-scoped Knowledge Base that autonomous agents (chat + rooms) can query safely and reliably with citations.

**Architecture:** Introduce a dedicated `knowledge` server domain (separate from `memory`) in `.local/messages.db`, with document ingestion (chunk + embed), hybrid retrieval (FTS + vector rerank), and two agent access paths: automatic context injection plus explicit `kb_search` tool calls.

**Tech Stack:** Next.js API routes, Node.js + TypeScript, SQLite (`better-sqlite3`, FTS5), existing Model Hub embedding dispatch (`dispatchEmbedding`), existing Rooms orchestrator + Skills system.

---

## Analysis Summary (Current State)

- Reusable building blocks already exist:
  - Embeddings via `src/server/model-hub/service.ts` (`dispatchEmbedding`).
  - Vector persistence and similarity patterns via `src/server/memory/*`.
  - Server-side skill execution and permission gating via `src/server/skills/*` and `src/server/rooms/toolExecutor.ts`.
  - Rooms orchestration path where retrieval can be injected via `src/server/rooms/orchestrator.ts`.
- Critical gaps for a true Knowledge Base:
  - `memory_nodes` is global and not scoped by `user/room/persona`.
  - No document ingestion pipeline (upload, parse, chunk, embed).
  - No KB retrieval contract with citations.
  - No dedicated KB skill/tool exposed to agents.
  - Persona docs in `docs/PERSONA_ROOMS_SYSTEM.md` mention `KNOWLEDGE.md`, but runtime file set in `src/server/personas/personaTypes.ts` differs.

## Approaches Considered

1. Extend existing `memory_nodes` directly.
   - Pros: fastest to ship.
   - Cons: mixes long-term KB docs with short memory nodes, poor tenancy semantics, weak auditability.
2. Dedicated KB domain in `messages.db` + hybrid retrieval + agent integration.
   - Pros: clean boundaries, scoped access, testability, citations, future-proof.
   - Cons: more implementation work.
3. External vector DB first (Qdrant/Pinecone/etc.).
   - Pros: large-scale retrieval.
   - Cons: new infra and ops complexity, unnecessary for current SQLite-first architecture.

**Recommendation:** Approach 2.

---

### Task 1: Create KB Domain Contracts and SQLite Schema

**Files:**

- Create: `src/server/knowledge/types.ts`
- Create: `src/server/knowledge/repository.ts`
- Create: `src/server/knowledge/sqliteKnowledgeRepository.ts`
- Create: `src/server/knowledge/runtime.ts`
- Modify: `src/server/rooms/runtime.ts`
- Test: `tests/unit/knowledge/knowledge-repository.test.ts`

**Step 1: Write failing repository schema test**

```ts
it('creates KB tables and persists namespace/document/chunk records', () => {
  const repo = new SqliteKnowledgeRepository(':memory:');
  const ns = repo.createNamespace({
    userId: 'u1',
    name: 'Team KB',
    scopeType: 'global',
    scopeRef: null,
  });
  const doc = repo.createDocument({
    userId: 'u1',
    namespaceId: ns.id,
    title: 'runbook.md',
    mimeType: 'text/markdown',
  });
  const chunk = repo.insertChunk({
    documentId: doc.id,
    chunkIndex: 0,
    text: 'hello',
    tokenEstimate: 2,
  });
  expect(chunk.chunkIndex).toBe(0);
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- tests/unit/knowledge/knowledge-repository.test.ts`
Expected: FAIL (`Cannot find module .../knowledge/sqliteKnowledgeRepository`)

**Step 3: Implement schema + repository methods**

Define tables in `sqliteKnowledgeRepository.ts`:

- `kb_namespaces`
- `kb_documents`
- `kb_chunks`
- `kb_chunk_embeddings`
- `kb_chunks_fts` (FTS5)
- `kb_access_bindings`
- `kb_retrieval_logs`
- `kb_ingest_jobs`

Enforce:

- user scoping (`user_id` on namespace + document)
- WAL/busy_timeout/foreign_keys pragmas
- unique `(namespace_id, title, content_sha256)` to dedupe re-uploads

**Step 4: Run test to verify it passes**

Run: `npm run test -- tests/unit/knowledge/knowledge-repository.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/knowledge src/server/rooms/runtime.ts tests/unit/knowledge/knowledge-repository.test.ts
git commit -m "feat(kb): add knowledge repository and sqlite schema"
```

### Task 2: Build Ingestion Pipeline (Upload -> Parse -> Chunk -> Embed)

**Files:**

- Create: `src/server/knowledge/chunking.ts`
- Create: `src/server/knowledge/parsers.ts`
- Create: `src/server/knowledge/service.ts`
- Modify: `package.json`
- Test: `tests/unit/knowledge/chunking.test.ts`
- Test: `tests/unit/knowledge/knowledge-service.test.ts`

**Step 1: Write failing tests for chunking and ingestion**

```ts
it('splits long text into stable chunk windows', () => {
  const chunks = chunkTextForKb('very long text ...', { targetChars: 1200, overlapChars: 120 });
  expect(chunks.length).toBeGreaterThan(1);
});

it('stores document chunks with embeddings', async () => {
  await service.ingestText({
    userId: 'u1',
    namespaceId: 'ns1',
    title: 'doc.md',
    text: '# Title\nBody',
  });
  expect(repo.listChunksByDocument(docId).length).toBeGreaterThan(0);
});
```

**Step 2: Run tests to verify failure**

Run: `npm run test -- tests/unit/knowledge/chunking.test.ts tests/unit/knowledge/knowledge-service.test.ts`
Expected: FAIL

**Step 3: Implement ingestion service**

Implement in `knowledge/service.ts`:

- `ingestText(...)`
- `ingestFile(...)` with parser adapter by MIME/extension
- batch embedding via existing model hub embedding runtime
- write chunks + vectors + FTS rows
- enqueue large files into `kb_ingest_jobs` when above threshold

Add parser adapters in `parsers.ts`:

- `text/plain`, `text/markdown` (required)
- `application/pdf`, `.docx` (best-case path; if parser unavailable, explicit typed error)

**Step 4: Run tests**

Run: `npm run test -- tests/unit/knowledge/chunking.test.ts tests/unit/knowledge/knowledge-service.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/knowledge package.json tests/unit/knowledge/chunking.test.ts tests/unit/knowledge/knowledge-service.test.ts
git commit -m "feat(kb): add ingestion pipeline with chunking and embeddings"
```

### Task 3: Add Hybrid Retrieval Engine with Citations

**Files:**

- Create: `src/server/knowledge/retrieval.ts`
- Modify: `src/server/knowledge/repository.ts`
- Modify: `src/server/knowledge/sqliteKnowledgeRepository.ts`
- Test: `tests/unit/knowledge/retrieval.test.ts`

**Step 1: Write failing retrieval ranking test**

```ts
it('returns top-k chunks with citation metadata', async () => {
  const result = await retrieval.search({
    userId: 'u1',
    namespaceIds: ['ns1'],
    query: 'how to rotate api key',
    topK: 5,
  });
  expect(result.items[0]?.citation.documentTitle).toBeTruthy();
});
```

**Step 2: Run test to verify failure**

Run: `npm run test -- tests/unit/knowledge/retrieval.test.ts`
Expected: FAIL

**Step 3: Implement retrieval**

Retrieval flow:

1. FTS candidate pull (`kb_chunks_fts`) with score.
2. Query embedding for semantic rerank.
3. Combined score: lexical + cosine + freshness + importance.
4. Return `items[]` with `documentId`, `documentTitle`, `chunkId`, `snippet`, `score`, `sourceUri`.
5. Persist retrieval log to `kb_retrieval_logs`.

**Step 4: Run test**

Run: `npm run test -- tests/unit/knowledge/retrieval.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/knowledge/retrieval.ts src/server/knowledge/repository.ts src/server/knowledge/sqliteKnowledgeRepository.ts tests/unit/knowledge/retrieval.test.ts
git commit -m "feat(kb): implement hybrid retrieval with citations and logs"
```

### Task 4: Expose Authenticated KB API Surface

**Files:**

- Create: `app/api/knowledge/namespaces/route.ts`
- Create: `app/api/knowledge/namespaces/[id]/documents/route.ts`
- Create: `app/api/knowledge/documents/[id]/route.ts`
- Create: `app/api/knowledge/query/route.ts`
- Create: `app/api/knowledge/bindings/route.ts`
- Test: `tests/integration/knowledge/knowledge-routes.test.ts`

**Step 1: Write failing integration route tests**

```ts
it('rejects unauthenticated namespace creation', async () => {
  const res = await POST(
    new Request('http://localhost/api/knowledge/namespaces', { method: 'POST' }),
  );
  expect(res.status).toBe(401);
});

it('creates namespace and returns user-scoped list', async () => {
  // mocked auth user context
});
```

**Step 2: Run test to verify failure**

Run: `npm run test -- tests/integration/knowledge/knowledge-routes.test.ts`
Expected: FAIL

**Step 3: Implement routes with strict ownership checks**

All routes must:

- call `resolveRequestUserContext()`
- enforce user ownership and namespace binding checks
- sanitize and validate payloads
- support pagination for listing documents/chunks

Required endpoints:

- `GET/POST /api/knowledge/namespaces`
- `GET/POST /api/knowledge/namespaces/:id/documents`
- `DELETE /api/knowledge/documents/:id`
- `POST /api/knowledge/query`
- `POST /api/knowledge/bindings` (room/persona -> namespace mapping)

**Step 4: Run integration tests**

Run: `npm run test -- tests/integration/knowledge/knowledge-routes.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add app/api/knowledge tests/integration/knowledge/knowledge-routes.test.ts
git commit -m "feat(kb): add authenticated knowledge base API routes"
```

### Task 5: Add Agent Tooling (`kb_search`) + Server Handler

**Files:**

- Create: `skills/knowledge-base/index.ts`
- Create: `src/server/skills/handlers/kbSearch.ts`
- Modify: `skills/definitions.ts`
- Modify: `skills/execute.ts`
- Modify: `src/server/skills/executeSkill.ts`
- Modify: `src/server/skills/builtInSkills.ts`
- Test: `tests/integration/skills/kb-search-skill.test.ts`

**Step 1: Write failing skill dispatch test**

```ts
it('dispatches kb_search and returns citations', async () => {
  const result = await dispatchSkill('kb_search', { query: 'deploy checklist', topK: 3 });
  expect(result).toHaveProperty('items');
});
```

**Step 2: Run test to verify failure**

Run: `npm run test -- tests/integration/skills/kb-search-skill.test.ts`
Expected: FAIL (`Unsupported skill: kb_search`)

**Step 3: Implement skill manifest + handler wiring**

Implement `kb_search` tool JSON schema with args:

- `query` (required string)
- `namespaceIds` (optional array)
- `topK` (optional number)

Server handler:

- resolve user scope
- call retrieval service
- return compact citation-safe payload

**Step 4: Run test**

Run: `npm run test -- tests/integration/skills/kb-search-skill.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add skills src/server/skills tests/integration/skills/kb-search-skill.test.ts
git commit -m "feat(kb): add kb_search skill and server handler"
```

### Task 6: Integrate KB Access into Rooms and Chat Agents

**Files:**

- Modify: `src/server/rooms/orchestrator.ts`
- Modify: `src/server/rooms/toolExecutor.ts`
- Modify: `src/server/channels/messages/contextBuilder.ts`
- Modify: `src/server/rooms/types.ts`
- Modify: `src/server/rooms/repository.ts`
- Modify: `src/server/rooms/sqliteRoomRepository.ts`
- Test: `tests/integration/rooms/rooms-kb-runtime.test.ts`
- Test: `tests/unit/channels/context-builder-kb.test.ts`

**Step 1: Write failing tests for KB-injected context**

```ts
it('injects top KB snippets into room system prompt when matches exist', async () => {
  // run orchestrator once and assert gateway prompt contains "Knowledge Context"
});

it('includes KB snippets in standard chat context builder', async () => {
  // assert context builder output contains citation block
});
```

**Step 2: Run tests to verify failure**

Run: `npm run test -- tests/integration/rooms/rooms-kb-runtime.test.ts tests/unit/channels/context-builder-kb.test.ts`
Expected: FAIL

**Step 3: Implement retrieval injection + metadata persistence**

Room flow:

- resolve KB namespaces bound to room/persona
- run retrieval on latest user/system intent
- prepend compact block in system/context section:
  - `Knowledge Context`
  - cited snippets with source ids
- persist citations in message metadata (`metadata.kbCitations`)

Chat flow:

- in `contextBuilder.ts`, do the same for non-room agent turns.

Tool executor:

- ensure `kb_search` obeys persona permission + server policy ceiling.

**Step 4: Run tests**

Run: `npm run test -- tests/integration/rooms/rooms-kb-runtime.test.ts tests/unit/channels/context-builder-kb.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/rooms src/server/channels/messages/contextBuilder.ts tests/integration/rooms/rooms-kb-runtime.test.ts tests/unit/channels/context-builder-kb.test.ts
git commit -m "feat(kb): integrate retrieval context into rooms and chat agents"
```

### Task 7: Scheduler, Metrics, and Operational Hardening

**Files:**

- Modify: `scheduler.ts`
- Modify: `app/api/control-plane/metrics/route.ts`
- Create: `tests/integration/knowledge/knowledge-scheduler-runtime.test.ts`
- Create: `docs/KNOWLEDGE_BASE_SYSTEM.md`
- Modify: `docs/PERSONA_ROOMS_SYSTEM.md`

**Step 1: Write failing scheduler + metrics test**

```ts
it('processes queued KB ingestion jobs in scheduler cycle', async () => {
  // enqueue job, run cycle, expect completed document chunks
});
```

**Step 2: Run test to verify failure**

Run: `npm run test -- tests/integration/knowledge/knowledge-scheduler-runtime.test.ts`
Expected: FAIL

**Step 3: Implement operations layer**

- Add KB ingest cycle in `scheduler.ts` with envs:
  - `KB_INGEST_INTERVAL_MS`
  - `KB_MAX_CONCURRENT_JOBS`
- Extend control-plane metrics with:
  - `kb.documentsTotal`
  - `kb.chunksTotal`
  - `kb.pendingJobs`
  - `kb.lastIngestAt`
- Update docs and explicitly reconcile persona file naming mismatch (current runtime files vs old `KNOWLEDGE.md` mention).

**Step 4: Run test + sanity checks**

Run: `npm run test -- tests/integration/knowledge/knowledge-scheduler-runtime.test.ts`
Expected: PASS

Run: `npm run lint`
Expected: PASS

**Step 5: Commit**

```bash
git add scheduler.ts app/api/control-plane/metrics/route.ts tests/integration/knowledge/knowledge-scheduler-runtime.test.ts docs/KNOWLEDGE_BASE_SYSTEM.md docs/PERSONA_ROOMS_SYSTEM.md
git commit -m "feat(kb): add ingest scheduler, metrics, and docs hardening"
```

---

## Verification Gate (Before Merge)

Run in order:

1. `npm run test -- tests/unit/knowledge`
2. `npm run test -- tests/integration/knowledge`
3. `npm run test -- tests/integration/rooms/rooms-kb-runtime.test.ts`
4. `npm run test -- tests/integration/skills/kb-search-skill.test.ts`
5. `npm run lint`
6. `npm run typecheck`

Expected:

- All new KB-related tests pass.
- If global `typecheck` still fails due known unrelated telemetry imports, document as pre-existing blocker in PR notes.

---

## Rollout and Risk Controls

- Feature flag: `KB_ENABLED=true` for progressive rollout.
- Safe fallback: if retrieval fails, continue agent turn without KB block (no hard failure of room/chat cycle).
- Limits:
  - max upload size
  - max chunks per document
  - max retrieval `topK`
- Audit:
  - log retrieval query hash + citation ids, never raw secrets.

---

Plan complete and saved to `docs/plans/2026-02-12-knowledge-base-agent-access-implementation.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
