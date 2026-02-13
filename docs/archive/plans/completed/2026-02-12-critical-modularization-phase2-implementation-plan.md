# Critical Modularization Phase 2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce remaining oversized high-risk files (`healthChecks`, `orchestrator`, `LogsView`, `PersonasView`) by extracting cohesive modules without behavior regressions.

**Architecture:** Keep runtime behavior unchanged and isolate only cohesive concerns: pure helpers, diagnostics parsing, row/tooling helpers, and UI subcomponents. Use TDD for each new extracted module (red-green-refactor), then run targeted + full verification.

**Tech Stack:** TypeScript, React, Vitest, ESLint

---

### Task 1: Extract Health Checks Helpers

**Files:**

- Create: `src/commands/health/checkHelpers.ts`
- Modify: `src/commands/healthChecks.ts`
- Test: `tests/unit/commands/health-check-helpers.test.ts`

1. Write failing tests for helper exports.
2. Run helper test and verify failing import/errors.
3. Implement helper module and rewire `healthChecks.ts`.
4. Re-run helper + existing health command tests.

### Task 2: Extract Orchestrator Turn Utilities

**Files:**

- Create: `src/server/rooms/orchestratorUtils.ts`
- Modify: `src/server/rooms/orchestrator.ts`
- Test: `tests/unit/rooms/orchestrator-utils.test.ts`

1. Write failing tests for utility exports.
2. Run utility test and verify failure.
3. Implement module and integrate orchestrator call sites.
4. Re-run orchestrator tests.

### Task 3: Extract LogsView Modules

**Files:**

- Create: `components/logs/diagnostics.ts`
- Create: `components/logs/DiagnosticsSummaryPanel.tsx`
- Modify: `components/LogsView.tsx`
- Test: `tests/unit/components/logs-diagnostics-data.test.ts`
- Test: `tests/unit/components/logs-diagnostics-panel.test.ts`

1. Add failing tests for extracted diagnostics exports (or adapt existing tests to new module).
2. Implement extraction and keep `LogsView` re-exports for compatibility.
3. Verify existing logs component tests pass.

### Task 4: Extract PersonasView Modules

**Files:**

- Create: `components/personas/personaLabels.ts`
- Create: `components/personas/PersonasSidebar.tsx`
- Create: `components/personas/PersonaEditorPane.tsx`
- Modify: `components/PersonasView.tsx`
- Test: `tests/unit/components/personas-view-smoke.test.ts`

1. Add failing smoke test for view render invariants.
2. Extract sidebar/editor panes with prop-driven composition.
3. Verify smoke test + relevant UI tests pass.

### Task 5: Full Verification

**Files:**

- Verify: repository-wide

1. Run targeted test suites for touched domains.
2. Run `npm run lint`.
3. Run `npm run typecheck`.
4. Run `npm test`.
5. Report exact pass/fail evidence.
