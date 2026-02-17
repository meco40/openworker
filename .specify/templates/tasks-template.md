---
description: 'Task list template for feature implementation'
---

# Tasks: [FEATURE NAME]

**Input**: Design documents from `/specs/[###-feature-name]/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: The examples below include test tasks. Tests are OPTIONAL - only include them if explicitly requested in the feature specification.

**Solo Lite Option**: For small, non-breaking, non-security-critical solo changes,
`tasks.md` MAY be skipped and replaced by a 3-7 step checklist in `plan.md`.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **OpenClaw layout**: `app/`, `components/`, `lib/`, `services/`, `src/`, `tests/` at repository root
- Use the existing feature location instead of introducing new top-level stacks
- Always include exact file paths from this repository in every task

<!--
  ============================================================================
  IMPORTANT: The tasks below are SAMPLE TASKS for illustration purposes only.

  The /speckit.tasks command MUST replace these with actual tasks based on:
  - User stories from spec.md (with their priorities P1, P2, P3...)
  - Feature requirements from plan.md
  - Entities from data-model.md
  - Endpoints from contracts/

  Tasks MUST be organized by user story so each story can be:
  - Implemented independently
  - Tested independently
  - Delivered as an MVP increment

  DO NOT keep these sample tasks in the generated tasks.md file.
  ============================================================================
-->

## Phase 1: Setup

**Purpose**: Minimal setup for this feature.

- [ ] T001 Confirm target files and touch points from `plan.md`
- [ ] T002 [P] Add or update test scaffold in `tests/` for the primary story
- [ ] T003 [P] Add/update required types or shared contracts in `src/` or `types/`

---

## Phase 2: User Story 1 (P1) - MVP

**Goal**: Deliver one independently testable slice of value.

### Tests (write first)

- [ ] T010 [P] [US1] Add failing integration/contract test in `tests/integration/[name].test.ts`

### Implementation

- [ ] T011 [US1] Implement route/service changes in exact files (for example `app/.../route.ts`, `services/...`)
- [ ] T012 [US1] Add validation and error handling paths
- [ ] T013 [US1] Add/update structured logging where relevant
- [ ] T014 [US1] Verify US1 independently

---

## Phase 3: Additional User Stories (P2+)

Repeat this block for each additional story:

- [ ] T020 [P] [US2] Add failing test for the story
- [ ] T021 [US2] Implement minimal code for the story
- [ ] T022 [US2] Verify story independently

---

## Phase 4: Polish

- [ ] T030 [P] Update docs (`docs/`) and runbook notes if behavior changed
- [ ] T031 Run final verification commands for changed scope
- [ ] T032 Final pass for simplicity (remove dead code, tighten naming)

---

## Dependencies & Execution Order

- Setup first.
- For each story: test first, then implementation, then verification.
- P1 must complete before optional P2+ work.
- Keep each story independently testable and shippable.

---

## Solo Execution Strategy

1. Finish Setup quickly.
2. Deliver User Story 1 end-to-end.
3. Decide if P2+ is still needed.
4. Run final checks and ship.

---

## Notes

- Keep tasks concrete, each with exact file paths.
- Prefer small tasks (2-10 minutes each).
- Avoid cross-story coupling unless explicitly required.
