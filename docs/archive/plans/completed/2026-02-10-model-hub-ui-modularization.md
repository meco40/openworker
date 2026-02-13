# ModelHub UI Modularization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor `components/ModelHub.tsx` into modular UI files while preserving all existing behavior and interactions.

**Architecture:** Keep orchestration state and API side effects in `ModelHub.tsx`, but move view concerns into composable presentational modules under `components/model-hub/`. Extract pure derivation logic into testable utility functions.

**Tech Stack:** React 19, TypeScript, Vitest, existing Tailwind UI.

---

### Task 1: Define modular UI boundaries

**Files:**
- Modify: `components/ModelHub.tsx`
- Create: `components/model-hub/types.ts`
- Create: `components/model-hub/constants.ts`

**Step 1: Map current local types/constants into dedicated modules**

**Step 2: Keep public component API unchanged (`export default ModelHub`)**

### Task 2: TDD for pure derivation utilities

**Files:**
- Create: `components/model-hub/utils.ts`
- Create: `tests/unit/model-hub/ui-utils.test.ts`

**Step 1: Write failing tests for default model and live model filtering behavior**
Run: `npm run test -- tests/unit/model-hub/ui-utils.test.ts`
Expected: FAIL due missing utility module or exports.

**Step 2: Implement minimal utility functions to pass tests**

**Step 3: Re-run utility tests**
Run: `npm run test -- tests/unit/model-hub/ui-utils.test.ts`
Expected: PASS.

### Task 3: Extract render sections into modules

**Files:**
- Create: `components/model-hub/sections/HeaderSection.tsx`
- Create: `components/model-hub/sections/PipelineSection.tsx`
- Create: `components/model-hub/sections/SidebarSection.tsx`
- Create: `components/model-hub/modals/AddModelModal.tsx`
- Modify: `components/ModelHub.tsx`

**Step 1: Move JSX sections without changing event handlers or class names**

**Step 2: Type props from shared types and keep all conditional rendering paths**

### Task 4: Wire orchestrator and keep behavior parity

**Files:**
- Modify: `components/ModelHub.tsx`

**Step 1: Replace inline section JSX with extracted components**

**Step 2: Keep all async actions and effects in parent component**

### Task 5: Verify no regressions and compare with backup

**Files:**
- Compare: `backups/2026-02-10-model-hub-ui-pre-refactor/components/ModelHub.tsx.bak`
- Compare: `components/ModelHub.tsx`

**Step 1: Run unit tests for UI utils + existing model-hub tests**
Run: `npm run test -- tests/unit/model-hub/ui-utils.test.ts tests/unit/model-hub tests/integration/model-hub`
Expected: PASS.

**Step 2: Run typecheck**
Run: `npm run typecheck`
Expected: PASS.

**Step 3: Confirm `ModelHub.tsx` significantly reduced and all handlers still reachable**
