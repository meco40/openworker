# Webapp Cleanup And Optimization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove measurable performance ballast (oversized standalone tracing payload + test DB artifact growth), tighten dependency hygiene, and reduce duplication risk in high-clone API/infra areas without behavior regressions.

**Architecture:** Keep runtime behavior stable while optimizing build/deploy and developer feedback loop. Apply changes in small TDD slices: update failing tests first, then minimal implementation. Prefer low-risk structural cleanup over broad rewrites.

**Tech Stack:** Next.js 16, TypeScript, Vitest, better-sqlite3, npm.

---

### Task 1: Harden Next Standalone Tracing Excludes

**Files:**

- Modify: `tests/unit/next-config-tracing.test.ts`
- Modify: `next.config.ts`

**Step 1: Write failing tests for missing excludes**

Add assertions for:

- `.local/**`
- `.local/**/*.db`
- `tests/**`
- `docs/**`

Also update handler exclude expectation to only require canonical path:

- `src/server/skills/handlers/**`

**Step 2: Run test to verify RED**

Run:

```bash
npm run test -- tests/unit/next-config-tracing.test.ts
```

Expected: FAIL on new exclude assertions.

**Step 3: Minimal implementation in Next config**

Update `outputFileTracingExcludes['/*']` in `next.config.ts`:

- add `.local/**` and `.local/**/*.db`
- add `tests/**` and `docs/**`
- remove typo compatibility entry `src/server/skills/handlers./**`

**Step 4: Run test to verify GREEN**

Run:

```bash
npm run test -- tests/unit/next-config-tracing.test.ts
```

Expected: PASS.

---

### Task 2: Stop Test DB/WAL/SHM Artifact Leaks

**Files:**

- Create: `tests/helpers/sqliteTestArtifacts.ts`
- Create: `tests/unit/helpers/sqliteTestArtifacts.test.ts`
- Modify: `src/server/knowledge/sqliteKnowledgeRepository.ts`
- Modify: `tests/unit/knowledge/event-dedup.test.ts`
- Modify: `tests/unit/knowledge/entity-graph.test.ts`
- Modify: `tests/unit/knowledge/nata-scenario.test.ts`

**Step 1: Write failing helper tests (RED)**

In `tests/unit/helpers/sqliteTestArtifacts.test.ts`, test:

- `cleanupSqliteArtifacts(path)` removes `path`, `path-wal`, `path-shm`, `path-journal`
- function is idempotent (no throw if files are missing)

**Step 2: Run helper test to verify RED**

Run:

```bash
npm run test -- tests/unit/helpers/sqliteTestArtifacts.test.ts
```

Expected: FAIL because helper does not exist.

**Step 3: Implement minimal helper**

In `tests/helpers/sqliteTestArtifacts.ts`:

- export `cleanupSqliteArtifacts(dbPath: string): void`
- attempt deletion for base + suffixes
- swallow `ENOENT`/Windows lock races safely

**Step 4: Make repository closeable for deterministic cleanup**

In `src/server/knowledge/sqliteKnowledgeRepository.ts`:

- add `close(): void` that calls `this.db.close()` if open

**Step 5: Use helper + close in leaking tests**

In each knowledge test listed above:

- import `cleanupSqliteArtifacts`
- call `repo.close()` in `afterEach` (best effort)
- replace single-file delete with `cleanupSqliteArtifacts(dbPath)`

**Step 6: Run targeted tests to verify GREEN**

Run:

```bash
npm run test -- tests/unit/helpers/sqliteTestArtifacts.test.ts tests/unit/knowledge/event-dedup.test.ts tests/unit/knowledge/entity-graph.test.ts tests/unit/knowledge/nata-scenario.test.ts
```

Expected: PASS.

---

### Task 3: Add Local Artifact Cleanup Script

**Files:**

- Create: `scripts/cleanup-local-artifacts.ts`
- Create: `tests/unit/scripts/cleanup-local-artifacts.test.ts`
- Modify: `package.json`

**Step 1: Write failing script tests (RED)**

In `tests/unit/scripts/cleanup-local-artifacts.test.ts`, test script functions:

- classify removable files by known test prefixes (`test-dedup`, `test-entity-graph`, `test-nata-scenario`, `worker.delete.routes`, `worker.metrics.route`, `automation.routes`)
- support dry-run mode
- preserve stable DBs (`messages.db`, `stats.db`) by default

**Step 2: Run script test to verify RED**

Run:

```bash
npm run test -- tests/unit/scripts/cleanup-local-artifacts.test.ts
```

Expected: FAIL because module does not exist.

**Step 3: Implement minimal script**

In `scripts/cleanup-local-artifacts.ts`:

- export pure functions for testability (`collectCandidates`, `cleanupCandidates`)
- include CLI entrypoint:
  - `--dry-run` (default true)
  - `--apply` (perform deletes)
  - optional `--dir <path>`

**Step 4: Add npm script**

In `package.json`:

- add `local:cleanup`: `node --import tsx scripts/cleanup-local-artifacts.ts --apply`
- add `local:cleanup:dry`: `node --import tsx scripts/cleanup-local-artifacts.ts --dry-run`

**Step 5: Run script unit tests (GREEN)**

Run:

```bash
npm run test -- tests/unit/scripts/cleanup-local-artifacts.test.ts
```

Expected: PASS.

---

### Task 4: Targeted Route Deduplication

**Files:**

- Create: `src/server/http/memoryDiagnostics.ts`
- Create: `src/server/http/unauthorized.ts`
- Modify: `app/api/doctor/route.ts`
- Modify: `app/api/health/route.ts`
- Modify: `app/api/rooms/[id]/start/route.ts`
- Modify: `app/api/rooms/[id]/stop/route.ts`
- Verify: `tests/integration/diagnostics/doctor-route.test.ts`
- Verify: `tests/integration/diagnostics/health-route.test.ts`
- Verify: `tests/integration/rooms/rooms-routes.test.ts`

**Step 1: Define behavior lock with existing integration tests**

Run:

```bash
npm run test -- tests/integration/diagnostics/doctor-route.test.ts tests/integration/diagnostics/health-route.test.ts tests/integration/rooms/rooms-routes.test.ts
```

Expected: PASS baseline before refactor.

**Step 2: Extract shared helpers (minimal)**

- `memoryDiagnostics.ts`: parse query param to boolean
- `unauthorized.ts`: shared unauthorized JSON response

**Step 3: Refactor duplicate routes to use helpers**

- replace duplicate parser/auth blocks in doctor/health
- replace duplicate unauthorized helper in rooms start/stop

**Step 4: Re-run integration tests**

Run:

```bash
npm run test -- tests/integration/diagnostics/doctor-route.test.ts tests/integration/diagnostics/health-route.test.ts tests/integration/rooms/rooms-routes.test.ts
```

Expected: PASS with no behavior change.

---

### Task 5: Dependency Hygiene From Knip

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`

**Step 1: Write failing guard test for dependency expectations (RED)**

Create or extend a unit test in `tests/unit/dependency-hygiene.test.ts` to assert:

- `eslint-import-resolver-typescript` not present in devDependencies
- `postcss` present in devDependencies
- `@next/env` present in dependencies or devDependencies

**Step 2: Run guard test to verify RED**

Run:

```bash
npm run test -- tests/unit/dependency-hygiene.test.ts
```

Expected: FAIL.

**Step 3: Apply minimal dependency fixes**

- remove unused `eslint-import-resolver-typescript`
- add `postcss`
- add `@next/env`

**Step 4: Reinstall lockfile and verify GREEN**

Run:

```bash
npm install
npm run test -- tests/unit/dependency-hygiene.test.ts
```

Expected: PASS.

---

### Task 6: Final Verification Pass

**Files:**

- Verify only (no file changes)

**Step 1: Run focused regression suite**

```bash
npm run test -- tests/unit/next-config-tracing.test.ts tests/unit/helpers/sqliteTestArtifacts.test.ts tests/unit/knowledge/event-dedup.test.ts tests/unit/knowledge/entity-graph.test.ts tests/unit/knowledge/nata-scenario.test.ts tests/unit/scripts/cleanup-local-artifacts.test.ts tests/unit/dependency-hygiene.test.ts
```

**Step 2: Run static quality checks**

```bash
npm run typecheck
npm run lint
```

**Step 3: Run production build**

```bash
npm run build
```

**Step 4: Re-run dead-code scan for evidence**

```bash
npm run knip
```

Expected:

- no regressions in touched areas
- standalone tracing excludes reflect cleanup intent
- dependency findings reduced
- local artifact cleanup workflow available.
