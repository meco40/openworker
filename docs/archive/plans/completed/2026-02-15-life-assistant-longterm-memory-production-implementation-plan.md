# Life Assistant Long-Term Memory Production Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver a production-ready, low-latency long-term memory system so a persona can answer detailed questions about events from up to 6+ months ago (for example: "Wie war das Meeting mit Andreas und was haben wir ausgehandelt?").

**Architecture:** Implement a strict 3-layer system with clear responsibilities: (1) lossless raw transcript source-of-truth, (2) structured meeting/topic ledger for deterministic retrieval, (3) semantic memory (facts + teaser + 400-800-word episode summaries) for fast conversational recall. Retrieval uses a budgeted, staged pipeline (ledger first, then semantic, then raw evidence) to keep latency and token cost predictable.

**Tech Stack:** TypeScript, Next.js API routes, existing chat/message repositories, Mem0, SQLite, scheduler runtime, Vitest.

---

## Problem Statement (Current Gaps)

1. Fact-only memory often retains "that something happened" but not "what/why/details/agreements."
2. Recall trigger gating misses common formulations and can skip retrieval entirely.
3. Scope split (`legacy-local-user` vs `channel:*`) can make memory appear empty.
4. Summary flow can skip portions of history in long conversations.
5. No structured meeting ledger exists for deterministic "Andreas + 6 months ago + negotiated terms" queries.
6. No strict retrieval budget strategy for long time ranges.

## Target SLOs and Constraints

1. `p95` chat latency overhead from memory retrieval: `<= 1200ms`.
2. Memory context budget injected into model prompt: `<= 1200 tokens` by default.
3. Long-range meeting query (`~6 months`) returns a useful answer on first pass in `< 3s` `p95`.
4. Zero transcript loss: every incoming/outgoing message persisted before derived memory writes.
5. Ingestion lag target: `< 5 min` under normal load.

## Design Decisions (Best-Case)

1. Use DB transcript as the primary immutable source-of-truth; MD export is backup/export only.
2. Keep episode length at `400-800` words (`B`) and always pair with a short teaser (`80-150` words).
3. Add deterministic meeting ledger entities (`participants`, `date/time`, `decisions`, `negotiated_terms`, `open_points`, `action_items`, `source_refs`).
4. Use staged retrieval:
   1. parse query intent/time/entities,
   2. retrieve ledger candidates,
   3. retrieve semantic memory,
   4. load raw evidence snippets only when needed,
   5. build token-budgeted response context.
5. Run ingestion asynchronously in scheduler/runtime, not on live chat request path.

## Feature Flags (Progressive Rollout)

1. `KNOWLEDGE_LAYER_ENABLED=0|1`
2. `KNOWLEDGE_LEDGER_ENABLED=0|1`
3. `KNOWLEDGE_EPISODE_ENABLED=0|1`
4. `KNOWLEDGE_RETRIEVAL_ENABLED=0|1`
5. `KNOWLEDGE_MAX_CONTEXT_TOKENS=1200`
6. `KNOWLEDGE_INGEST_INTERVAL_MS=600000`

---

### Task 1: Foundation Config and Feature Flags (TDD)

**Files:**

- Create: `src/server/knowledge/config.ts`
- Create: `tests/unit/knowledge/config.test.ts`

**Step 1: Write the failing tests**

- Add tests for defaults and env parsing for all `KNOWLEDGE_*` flags.
- Validate bounds for numeric settings (`max_context_tokens`, `ingest_interval_ms`).

**Step 2: Run test to verify it fails**

- Run: `npm run test -- tests/unit/knowledge/config.test.ts`
- Expected: FAIL because module does not exist.

**Step 3: Write minimal implementation**

- Implement typed config resolver with safe defaults and clamping.

**Step 4: Run test to verify it passes**

- Run: `npm run test -- tests/unit/knowledge/config.test.ts`
- Expected: PASS.

**Step 5: Commit**

- `git add src/server/knowledge/config.ts tests/unit/knowledge/config.test.ts`
- `git commit -m "feat: add knowledge config and feature flags"`

---

### Task 2: Structured Knowledge Repository + Migrations (TDD)

**Files:**

- Create: `src/server/knowledge/repository.ts`
- Create: `src/server/knowledge/sqliteKnowledgeRepository.ts`
- Create: `src/server/knowledge/runtime.ts`
- Create: `tests/unit/knowledge/sqlite-knowledge-repository.test.ts`

**Step 1: Write the failing tests**

- Test schema creation and CRUD for:
  1. `knowledge_ingestion_checkpoints`
  2. `knowledge_episodes`
  3. `knowledge_meeting_ledger`
  4. `knowledge_retrieval_audit`
- Test idempotent migrations across repeated initializations.

**Step 2: Run test to verify it fails**

- Run: `npm run test -- tests/unit/knowledge/sqlite-knowledge-repository.test.ts`
- Expected: FAIL (missing files).

**Step 3: Write minimal implementation**

- Implement repository with `KNOWLEDGE_DB_PATH || MESSAGES_DB_PATH`.
- Add indexes:
  - by `user_id/persona_id/updated_at`,
  - by `counterpart/date`,
  - by `topic_key/date`.

**Step 4: Run test to verify it passes**

- Run: `npm run test -- tests/unit/knowledge/sqlite-knowledge-repository.test.ts`
- Expected: PASS.

**Step 5: Commit**

- `git add src/server/knowledge/repository.ts src/server/knowledge/sqliteKnowledgeRepository.ts src/server/knowledge/runtime.ts tests/unit/knowledge/sqlite-knowledge-repository.test.ts`
- `git commit -m "feat: add sqlite knowledge repository and runtime"`

---

### Task 3: Transcript Cursor and Idempotent Ingestion Window (TDD)

**Files:**

- Create: `src/server/knowledge/ingestionCursor.ts`
- Create: `tests/unit/knowledge/ingestion-cursor.test.ts`
- Modify: `src/server/channels/messages/repository.ts` (if typed helpers are needed)

**Step 1: Write the failing tests**

- Verify "fetch messages after last processed seq" behavior.
- Verify checkpoint update is atomic and idempotent.
- Verify no duplicate processing on repeated runs.

**Step 2: Run test to verify it fails**

- Run: `npm run test -- tests/unit/knowledge/ingestion-cursor.test.ts`
- Expected: FAIL.

**Step 3: Write minimal implementation**

- Build cursor logic per `(conversation_id, persona_id)`.
- Ensure deterministic ordering by `seq`.

**Step 4: Run test to verify it passes**

- Run: `npm run test -- tests/unit/knowledge/ingestion-cursor.test.ts`
- Expected: PASS.

**Step 5: Commit**

- `git add src/server/knowledge/ingestionCursor.ts src/server/channels/messages/repository.ts tests/unit/knowledge/ingestion-cursor.test.ts`
- `git commit -m "feat: add idempotent knowledge ingestion cursor"`

---

### Task 4: Multi-Artifact Extractor (Facts, Teaser, Episode, Meeting Ledger) (TDD)

**Files:**

- Create: `src/server/knowledge/extractor.ts`
- Create: `src/server/knowledge/prompts.ts`
- Create: `tests/unit/knowledge/extractor.test.ts`

**Step 1: Write the failing tests**

- Input: a synthetic meeting transcript.
- Assert extractor returns:
  1. facts (short),
  2. teaser (80-150 words),
  3. episode (400-800 words),
  4. meeting ledger fields with source refs.
- Assert fallback extractor still returns deterministic minimal outputs if model call fails.

**Step 2: Run test to verify it fails**

- Run: `npm run test -- tests/unit/knowledge/extractor.test.ts`
- Expected: FAIL.

**Step 3: Write minimal implementation**

- Implement model-driven extraction with strict JSON schema parse.
- Add deterministic fallback parser.

**Step 4: Run test to verify it passes**

- Run: `npm run test -- tests/unit/knowledge/extractor.test.ts`
- Expected: PASS.

**Step 5: Commit**

- `git add src/server/knowledge/extractor.ts src/server/knowledge/prompts.ts tests/unit/knowledge/extractor.test.ts`
- `git commit -m "feat: add knowledge extractor for facts episodes and meeting ledger"`

---

### Task 5: Extend Memory Store Metadata for Evidence Linking (TDD)

**Files:**

- Modify: `src/server/memory/service.ts`
- Modify: `src/server/memory/mem0Client.ts`
- Modify: `tests/unit/memory/memory-service.test.ts`
- Modify: `tests/unit/memory/mem0-client.test.ts`

**Step 1: Write the failing tests**

- Add tests that `store(...)` can persist additional metadata:
  - `topicKey`, `conversationId`, `sourceSeqStart`, `sourceSeqEnd`, `artifactType`.
- Assert metadata survives through Mem0 client payload.

**Step 2: Run test to verify it fails**

- Run: `npm run test -- tests/unit/memory/memory-service.test.ts tests/unit/memory/mem0-client.test.ts`
- Expected: FAIL for missing metadata propagation.

**Step 3: Write minimal implementation**

- Add optional metadata argument to memory store path.
- Preserve backward compatibility for existing call sites.

**Step 4: Run test to verify it passes**

- Run: `npm run test -- tests/unit/memory/memory-service.test.ts tests/unit/memory/mem0-client.test.ts`
- Expected: PASS.

**Step 5: Commit**

- `git add src/server/memory/service.ts src/server/memory/mem0Client.ts tests/unit/memory/memory-service.test.ts tests/unit/memory/mem0-client.test.ts`
- `git commit -m "feat: support evidence metadata in mem0 memory writes"`

---

### Task 6: Knowledge Ingestion Service (Async Pipeline) (TDD)

**Files:**

- Create: `src/server/knowledge/ingestionService.ts`
- Create: `tests/unit/knowledge/ingestion-service.test.ts`
- Modify: `src/server/knowledge/runtime.ts`

**Step 1: Write the failing tests**

- Verify each run:
  1. reads unprocessed message windows,
  2. calls extractor,
  3. writes artifacts to repository + Mem0,
  4. updates checkpoint.
- Verify dedupe and retry behavior.

**Step 2: Run test to verify it fails**

- Run: `npm run test -- tests/unit/knowledge/ingestion-service.test.ts`
- Expected: FAIL.

**Step 3: Write minimal implementation**

- Implement orchestration and error handling with retry-safe writes.
- Ensure one failed conversation does not stop entire run.

**Step 4: Run test to verify it passes**

- Run: `npm run test -- tests/unit/knowledge/ingestion-service.test.ts`
- Expected: PASS.

**Step 5: Commit**

- `git add src/server/knowledge/ingestionService.ts src/server/knowledge/runtime.ts tests/unit/knowledge/ingestion-service.test.ts`
- `git commit -m "feat: add async knowledge ingestion service"`

---

### Task 7: Scheduler Integration for 10-Minute Ingestion (TDD)

**Files:**

- Modify: `scheduler.ts`
- Create: `src/server/knowledge/runtimeLoop.ts`
- Create: `tests/unit/knowledge/runtime-loop.test.ts`

**Step 1: Write the failing tests**

- Verify periodic invocation by interval.
- Verify graceful shutdown handling.
- Verify loop respects feature flags.

**Step 2: Run test to verify it fails**

- Run: `npm run test -- tests/unit/knowledge/runtime-loop.test.ts`
- Expected: FAIL.

**Step 3: Write minimal implementation**

- Start knowledge runtime loop in scheduler bootstrap.
- Keep live chat path non-blocking.

**Step 4: Run test to verify it passes**

- Run: `npm run test -- tests/unit/knowledge/runtime-loop.test.ts`
- Expected: PASS.

**Step 5: Commit**

- `git add scheduler.ts src/server/knowledge/runtimeLoop.ts tests/unit/knowledge/runtime-loop.test.ts`
- `git commit -m "feat: run knowledge ingestion loop in scheduler"`

---

### Task 8: Query Planner + Time/Entity Resolution (TDD)

**Files:**

- Create: `src/server/knowledge/queryPlanner.ts`
- Create: `tests/unit/knowledge/query-planner.test.ts`

**Step 1: Write the failing tests**

- Parse intents like:
  1. "meeting mit andreas vor 6 monaten",
  2. "was haben wir ausgehandelt",
  3. "heute mittag sauna".
- Assert extraction of:
  - `timeRange`,
  - `counterpart`,
  - `topic`,
  - `detailDepth`.

**Step 2: Run test to verify it fails**

- Run: `npm run test -- tests/unit/knowledge/query-planner.test.ts`
- Expected: FAIL.

**Step 3: Write minimal implementation**

- Rule-based parser with deterministic output.
- Keep external NLP dependency out of v1 (YAGNI).

**Step 4: Run test to verify it passes**

- Run: `npm run test -- tests/unit/knowledge/query-planner.test.ts`
- Expected: PASS.

**Step 5: Commit**

- `git add src/server/knowledge/queryPlanner.ts tests/unit/knowledge/query-planner.test.ts`
- `git commit -m "feat: add deterministic knowledge query planner"`

---

### Task 9: Retrieval Service with Token Budget and Evidence Pack (TDD)

**Files:**

- Create: `src/server/knowledge/retrievalService.ts`
- Create: `src/server/knowledge/tokenBudget.ts`
- Create: `tests/unit/knowledge/retrieval-service.test.ts`
- Create: `tests/integration/knowledge/meeting-retrieval.test.ts`

**Step 1: Write the failing tests**

- Assert staged retrieval order:
  1. meeting ledger,
  2. teaser/episode memories,
  3. raw evidence snippets.
- Assert hard token budget enforcement.
- Assert answer context includes evidence references.

**Step 2: Run test to verify it fails**

- Run: `npm run test -- tests/unit/knowledge/retrieval-service.test.ts tests/integration/knowledge/meeting-retrieval.test.ts`
- Expected: FAIL.

**Step 3: Write minimal implementation**

- Implement retrieval stages with budget pruning.
- Return compact context sections:
  - `AnswerDraft`,
  - `KeyDecisions`,
  - `OpenPoints`,
  - `Evidence`.

**Step 4: Run test to verify it passes**

- Run: `npm run test -- tests/unit/knowledge/retrieval-service.test.ts tests/integration/knowledge/meeting-retrieval.test.ts`
- Expected: PASS.

**Step 5: Commit**

- `git add src/server/knowledge/retrievalService.ts src/server/knowledge/tokenBudget.ts tests/unit/knowledge/retrieval-service.test.ts tests/integration/knowledge/meeting-retrieval.test.ts`
- `git commit -m "feat: add budgeted multi-stage knowledge retrieval service"`

---

### Task 10: Integrate Knowledge Retrieval into Chat Recall Path (TDD)

**Files:**

- Modify: `src/server/channels/messages/service.ts`
- Modify: `tests/unit/channels/message-service-memory-recall.test.ts`
- Create: `tests/unit/channels/message-service-knowledge-recall.test.ts`

**Step 1: Write the failing tests**

- Test scenario:
  1. midday sauna conversation stored as episode + facts,
  2. evening query "du warst ja in der sauna" returns details, not only fact.
- Test long-range meeting query with counterpart + time phrase.
- Test fallback to existing recall if knowledge layer disabled.

**Step 2: Run test to verify it fails**

- Run: `npm run test -- tests/unit/channels/message-service-memory-recall.test.ts tests/unit/channels/message-service-knowledge-recall.test.ts`
- Expected: FAIL.

**Step 3: Write minimal implementation**

- Call `KnowledgeRetrievalService` from `buildRecallContext(...)`.
- Keep legacy memory recall as fallback path.
- Expand trigger logic for plural/continuation patterns.

**Step 4: Run test to verify it passes**

- Run: `npm run test -- tests/unit/channels/message-service-memory-recall.test.ts tests/unit/channels/message-service-knowledge-recall.test.ts`
- Expected: PASS.

**Step 5: Commit**

- `git add src/server/channels/messages/service.ts tests/unit/channels/message-service-memory-recall.test.ts tests/unit/channels/message-service-knowledge-recall.test.ts`
- `git commit -m "feat: integrate structured knowledge retrieval into chat recall"`

---

### Task 11: Backfill and Export Operations (TDD + Script Validation)

**Files:**

- Create: `scripts/knowledge-backfill.ts`
- Create: `scripts/transcript-export.ts`
- Create: `tests/integration/knowledge/knowledge-backfill.test.ts`
- Modify: `package.json`

**Step 1: Write the failing tests**

- Backfill test for historical messages over large seq ranges.
- Export test for markdown transcript bundles.

**Step 2: Run test to verify it fails**

- Run: `npm run test -- tests/integration/knowledge/knowledge-backfill.test.ts`
- Expected: FAIL.

**Step 3: Write minimal implementation**

- Script 1: backfill from existing messages and populate knowledge layers.
- Script 2: export immutable transcript windows to Markdown for backup/legal archive.

**Step 4: Run test to verify it passes**

- Run: `npm run test -- tests/integration/knowledge/knowledge-backfill.test.ts`
- Expected: PASS.

**Step 5: Commit**

- `git add scripts/knowledge-backfill.ts scripts/transcript-export.ts tests/integration/knowledge/knowledge-backfill.test.ts package.json`
- `git commit -m "feat: add knowledge backfill and transcript export scripts"`

---

### Task 12: Observability, Health Checks, and Production Gates (TDD)

**Files:**

- Modify: `app/api/control-plane/metrics/route.ts`
- Modify: `src/commands/health/checks/coreChecks.ts`
- Modify: `src/commands/health/checkHelpers.ts`
- Modify: `tests/integration/control-plane-metrics-route.test.ts`
- Create: `tests/unit/knowledge/health-checks.test.ts`
- Modify: `docs/MEMORY_SYSTEM.md`
- Modify: `docs/DEPLOYMENT_OPERATIONS.md`

**Step 1: Write the failing tests**

- Add tests for new metrics:
  - ingestion lag,
  - episode count,
  - ledger count,
  - retrieval errors.
- Add health test to fail when lag exceeds threshold.

**Step 2: Run test to verify it fails**

- Run: `npm run test -- tests/integration/control-plane-metrics-route.test.ts tests/unit/knowledge/health-checks.test.ts`
- Expected: FAIL.

**Step 3: Write minimal implementation**

- Add runtime metrics and health checks.
- Document runbook for rollback and incident response.

**Step 4: Run test to verify it passes**

- Run: `npm run test -- tests/integration/control-plane-metrics-route.test.ts tests/unit/knowledge/health-checks.test.ts`
- Expected: PASS.

**Step 5: Commit**

- `git add app/api/control-plane/metrics/route.ts src/commands/health/checks/coreChecks.ts src/commands/health/checkHelpers.ts tests/integration/control-plane-metrics-route.test.ts tests/unit/knowledge/health-checks.test.ts docs/MEMORY_SYSTEM.md docs/DEPLOYMENT_OPERATIONS.md`
- `git commit -m "feat: add production observability and health gates for knowledge layer"`

---

### Task 13: Security, Privacy, and Data Lifecycle Controls (TDD)

**Files:**

- Create: `src/server/knowledge/securityPolicy.ts`
- Create: `src/server/knowledge/retentionService.ts`
- Modify: `app/api/memory/route.ts`
- Modify: `src/server/channels/messages/sqliteMessageRepository.ts`
- Create: `tests/unit/knowledge/security-policy.test.ts`
- Create: `tests/integration/knowledge/data-lifecycle.test.ts`
- Modify: `docs/DEPLOYMENT_OPERATIONS.md`

**Step 1: Write the failing tests**

- Add tests for:
  1. tenant isolation enforcement by `user_id` + `persona_id` in every read/write path,
  2. right-to-be-forgotten cascade delete across ledger + semantic + transcript-derived artifacts,
  3. retention policy pruning behavior without breaking source-of-truth integrity.

**Step 2: Run test to verify it fails**

- Run: `npm run test -- tests/unit/knowledge/security-policy.test.ts tests/integration/knowledge/data-lifecycle.test.ts`
- Expected: FAIL.

**Step 3: Write minimal implementation**

- Implement centralized scope guard and deletion orchestrator.
- Add retention policy hooks with dry-run mode.
- Document operator procedures for retention and legal deletion requests.

**Step 4: Run test to verify it passes**

- Run: `npm run test -- tests/unit/knowledge/security-policy.test.ts tests/integration/knowledge/data-lifecycle.test.ts`
- Expected: PASS.

**Step 5: Commit**

- `git add src/server/knowledge/securityPolicy.ts src/server/knowledge/retentionService.ts app/api/memory/route.ts src/server/channels/messages/sqliteMessageRepository.ts tests/unit/knowledge/security-policy.test.ts tests/integration/knowledge/data-lifecycle.test.ts docs/DEPLOYMENT_OPERATIONS.md`
- `git commit -m "feat: add knowledge security policy and data lifecycle controls"`

---

### Task 14: Load, Soak, and Failure-Injection Validation

**Files:**

- Create: `scripts/knowledge-load-test.ts`
- Create: `scripts/knowledge-failure-drill.ts`
- Modify: `docs/DEPLOYMENT_OPERATIONS.md`

**Step 1: Write validation scenarios**

- Define reproducible scenarios:
  1. 6-month retrieval under high message volume,
  2. ingestion with Mem0 timeout spikes,
  3. scheduler restart during backfill.

**Step 2: Implement load/failure scripts**

- `knowledge-load-test.ts`: synthetic traffic + retrieval metrics capture.
- `knowledge-failure-drill.ts`: toggles/timeouts/partial failures.

**Step 3: Run scripts in staging**

- Run:
  - `node --import tsx scripts/knowledge-load-test.ts`
  - `node --import tsx scripts/knowledge-failure-drill.ts`
- Expected:
  - SLOs remain within thresholds,
  - fallback behavior works without user-visible outage.

**Step 4: Commit**

- `git add scripts/knowledge-load-test.ts scripts/knowledge-failure-drill.ts docs/DEPLOYMENT_OPERATIONS.md`
- `git commit -m "chore: add knowledge load and failure validation drills"`

---

## End-to-End Verification Gate (Must Pass Before Rollout)

Run:

```bash
npm run test -- tests/unit/knowledge/config.test.ts \
  tests/unit/knowledge/sqlite-knowledge-repository.test.ts \
  tests/unit/knowledge/ingestion-cursor.test.ts \
  tests/unit/knowledge/extractor.test.ts \
  tests/unit/knowledge/ingestion-service.test.ts \
  tests/unit/knowledge/runtime-loop.test.ts \
  tests/unit/knowledge/query-planner.test.ts \
  tests/unit/knowledge/retrieval-service.test.ts \
  tests/unit/knowledge/security-policy.test.ts \
  tests/unit/channels/message-service-memory-recall.test.ts \
  tests/unit/channels/message-service-knowledge-recall.test.ts \
  tests/integration/knowledge/meeting-retrieval.test.ts \
  tests/integration/knowledge/knowledge-backfill.test.ts \
  tests/integration/knowledge/data-lifecycle.test.ts \
  tests/integration/control-plane-metrics-route.test.ts

npm run typecheck
npm run lint
```

Expected:

1. All tests PASS.
2. No type errors.
3. No lint errors.

---

## Rollout Plan (Production)

1. Deploy with all `KNOWLEDGE_*` flags off.
2. Enable ingestion only (`KNOWLEDGE_LAYER_ENABLED=1`, retrieval off).
3. Backfill 30 days, then 90 days, then 180 days.
4. Enable retrieval for 5% traffic (persona/user allowlist).
5. Observe `p95` latency, token budget, error rate for 24h.
6. Ramp to 25%, then 100%.
7. Keep one-command rollback: `KNOWLEDGE_RETRIEVAL_ENABLED=0`.

---

## Plan Self-Review (Production Readiness)

### Coverage Check

1. **Correctness:** Covered by extractor/retrieval integration tests with real query scenarios.
2. **Data loss prevention:** Raw transcript remains canonical; ingestion is derived and checkpointed.
3. **Latency/cost control:** Explicit token budget, staged retrieval, async ingestion.
4. **Long-range retrieval quality:** Meeting ledger + episode + raw evidence path.
5. **Operational visibility:** Metrics + health checks + runbook + feature flags.
6. **Rollback safety:** Flag-based disable without schema rollback.

### Remaining Risks and Mitigations

1. **Risk:** Extractor hallucination in structured fields.
   **Mitigation:** Require source refs, confidence score, and fallback deterministic parsing.
2. **Risk:** Backfill spikes load.
   **Mitigation:** throttle by batch size and sleep windows; run off-peak.
3. **Risk:** Scope mismatch across channels.
   **Mitigation:** centralized scope resolver reused by ingestion + retrieval + UI diagnostics.
4. **Risk:** Query ambiguity ("Andreas" multiple people).
   **Mitigation:** return disambiguation prompt with top candidates and dates.

### Production-Ready Verdict

This plan is production-ready **if and only if** all of the following are true:

1. Verification gate passes.
2. 24h canary metrics remain within SLO.
3. Backfill and rollback drills are executed successfully.
4. Incident playbook is documented and tested.

---

Plan complete and saved to `docs/plans/2026-02-15-life-assistant-longterm-memory-production-implementation-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
