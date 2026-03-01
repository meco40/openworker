# Test Artifacts Centralization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Route test-generated artifacts (DBs, uploads, workspaces, temp roots) into `.local/test-artifacts` to keep cleanup centralized and predictable while preserving persona data semantics.

**Architecture:** Introduce a shared test artifact path helper and global Vitest setup defaults, then migrate test env/path wiring from scattered `.local/*` literals to helper-driven paths. Keep persona-scoped runtime paths unchanged (`personas/<slug>/...`) while redirecting test roots via environment variables.

**Tech Stack:** TypeScript, Vitest, Node.js fs/path utilities, npm scripts.

---

### Task 1: Add shared test artifact path helpers

**Files:**

- Create: `tests/helpers/testArtifacts.ts`
- Test: `tests/unit/helpers/test-artifacts.test.ts`

**Step 1: Write the failing test**

- Add coverage for default root resolution, deterministic sub-path joining, unique DB path generation, and artifact cleanup behavior.

**Step 2: Run test to verify it fails**
Run: `npm test -- tests/unit/helpers/test-artifacts.test.ts`
Expected: FAIL because helper module/functions are missing.

**Step 3: Write minimal implementation**

- Implement `getTestArtifactsRoot`, `testArtifactsPath`, `uniqueTestDbPath`, and `removeTestArtifactPath`.

**Step 4: Run test to verify it passes**
Run: `npm test -- tests/unit/helpers/test-artifacts.test.ts`
Expected: PASS.

**Step 5: Commit**

- Commit helper + tests.

### Task 2: Add centralized cleanup script for test artifacts

**Files:**

- Create: `scripts/cleanup-test-artifacts.ts`
- Test: `tests/unit/scripts/cleanup-test-artifacts.test.ts`
- Modify: `package.json`

**Step 1: Write the failing test**

- Add tests for dry-run stats and destructive cleanup behavior.

**Step 2: Run test to verify it fails**
Run: `npm test -- tests/unit/scripts/cleanup-test-artifacts.test.ts`
Expected: FAIL because script API does not exist.

**Step 3: Write minimal implementation**

- Implement artifact counting and cleanup with `--dry-run` / `--apply` support.
- Add npm scripts:
  - `test:artifacts:clean:dry`
  - `test:artifacts:clean`

**Step 4: Run test to verify it passes**
Run: `npm test -- tests/unit/scripts/cleanup-test-artifacts.test.ts`
Expected: PASS.

**Step 5: Commit**

- Commit script + tests + package script changes.

### Task 3: Route default test env paths into `.local/test-artifacts`

**Files:**

- Create: `tests/setup/test-artifacts.setup.ts`
- Modify: `vitest.config.ts`

**Step 1: Write the failing test**

- Use existing integration/unit suites that currently rely on default env DB paths as regression targets.

**Step 2: Run test to verify it fails**
Run: focused suites using legacy defaults.
Expected: FAIL or path mismatch due to old `.local/*` defaults.

**Step 3: Write minimal implementation**

- Configure `setupFiles` in Vitest.
- In setup, initialize default env keys for DB/config/persona/upload/workspace paths under `.local/test-artifacts` unless already set by the test.

**Step 4: Run test to verify it passes**
Run: focused suites around personas, attachments, skills routing, and config rollback.
Expected: PASS.

**Step 5: Commit**

- Commit setup + config wiring.

### Task 4: Migrate tests with hardcoded `.local/*` paths

**Files:**

- Modify: affected files under `tests/unit/**`, `tests/integration/**`, and root `tests/*.test.ts`

**Step 1: Write the failing test**

- Target suites that still hardcode `.local/*` and fail under centralized setup.

**Step 2: Run test to verify it fails**
Run: focused affected files.
Expected: FAIL due to stale path assumptions.

**Step 3: Write minimal implementation**

- Replace hardcoded path construction for test artifacts with helper/env-rooted paths.
- Preserve persona logic by keeping persona-scoped storage paths (`personas/<slug>/...`) intact and only changing root resolution/cleanup locations.

**Step 4: Run test to verify it passes**
Run: focused files including:

- `tests/unit/personas/persona-workspace.test.ts`
- `tests/integration/personas/personas-files-route-filesystem.test.ts`
- `tests/unit/channels/attachments.test.ts`
- `tests/unit/channels/attachment-consistency.test.ts`
- `tests/unit/channels/whatsapp-webhook-route.test.ts`
  Expected: PASS.

**Step 5: Commit**

- Commit migrated test paths.

### Task 5: Verify and document completion

**Files:**

- Modify: `.agent/CONTINUITY.md`

**Step 1: Run verification**
Run:

- `npm run typecheck`
- Focused `npm test -- ...` suites covering new helper/script/setup and adjusted persona/channel tests.

**Step 2: Record outcomes**

- Update continuity with plan, decisions, progress, discoveries, and outcomes for this centralization work.

**Step 3: Commit**

- Commit continuity update and any final test fixes.

---

## Implementation Status (2026-03-01)

- Task 1: Completed
- Task 2: Completed
- Task 3: Completed
- Task 4: Completed for currently failing/identified path-mismatch suites
- Task 5: Completed (`npm run typecheck`, focused regression suites, and full `npm test` are green; continuity updated)
