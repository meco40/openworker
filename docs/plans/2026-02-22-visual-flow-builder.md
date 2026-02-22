# Visual Flow Builder - Optimized Implementation Plan

> For Claude: REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Date:** 2026-02-22
**Revision:** 2026-02-22 (optimized)
**Goal:** Build a production-safe visual flow editor on top of the existing automation engine without breaking current cron rules.
**Architecture:** Persist a typed flow graph in `automation_rules.flow_graph`, validate it server-side, compile it into existing rule fields (`prompt`, optional `cronExpression`), and reuse current execution/runtime paths.
**Tech Stack:** Next.js App Router, TypeScript, better-sqlite3, @xyflow/react, Vitest.

---

## 1. Scope

### In scope

- Visual editor (nodes + edges) for automation rules.
- Typed `FlowGraph` model in server + frontend.
- Server validation and compile step.
- API for flow get/save.
- Integration into existing cron UI.

### Out of scope

- New executor runtime.
- New scheduling backend.
- New skill system.
- Multi-user collaborative editing.

---

## 2. Existing Assets To Reuse

- `src/server/automation/service.ts`
- `src/server/automation/sqliteAutomationRepository.ts`
- `src/server/automation/cronEngine.ts`
- `src/modules/cron/components/CronView.tsx`
- `src/modules/cron/hooks/useCronRules.ts`
- `src/skills/definitions.ts`
- API namespace `app/api/automations/**`
- Dependency `@xyflow/react` (already installed)

Decision: no parallel automation system. All flow behavior stays inside existing automation domain.

---

## 3. Target Data Model

### Flow graph (single source of truth)

File: `src/server/automation/flowTypes.ts`

- `FlowNodeType` union:
  - `trigger.cron`
  - `trigger.webhook`
  - `trigger.manual`
  - `condition.filter`
  - `condition.ai_classifier`
  - `condition.regex`
  - `action.run_prompt`
  - `action.skill`
  - `action.send_message`
  - `action.notify`
- `FlowNode` = `{ id, type, position, data: { label, config } }`
- `FlowEdge` = `{ id, source, target, sourceHandle?, label? }`
- `FlowGraph` = `{ version: 1, nodes, edges }`

### Rule extensions

- `AutomationRule.flowGraph: FlowGraph | null`
- `UpdateAutomationRuleInput.flowGraph?: FlowGraph | null`

### DB

Migration in `sqliteAutomationRepository`:

- add nullable `flow_graph TEXT` column (idempotent)

---

## 4. Core Runtime Rules

- Exactly one trigger node per graph.
- Graph must be acyclic.
- `trigger.cron` must pass existing cron validation.
- `trigger.manual` and `trigger.webhook` must not force cron rewrite.
- Flow save must not silently corrupt existing cron-only rules.

---

## 5. Compile Strategy (Flow -> Existing Rule)

File: `src/server/automation/flowCompiler.ts`

Output:

- `prompt` (compiled from non-trigger nodes)
- `enabled`
- optional `cronExpression/timezone` only if trigger is `trigger.cron`

Important:

- Manual/webhook flows do not revalidate or overwrite cron unnecessarily.
- Existing executor remains unchanged.

---

## 6. API Contract

Path: `app/api/automations/[id]/flow/route.ts`

### GET

- Returns `flowGraph` for rule (or null)

### PUT

- Body: `{ flowGraph: FlowGraph }`
- Parse JSON with try/catch
- Validate graph
- Reject payload > 500 KB with `413`
- Compile graph
- Persist graph + compiled patch via service

Error shape should be stable and typed (validation failures, parsing errors, internal errors).

---

## 7. Frontend Architecture

New module: `src/modules/flow-builder/`

- `types.ts`
- `useFlowEditor.ts`
- `FlowBuilderView.tsx`
- `components/FlowEditorCanvas.tsx`
- `components/NodePalette.tsx`
- `components/NodeConfigPanel.tsx`
- `components/FlowToolbar.tsx`
- `nodes/TriggerNode.tsx`
- `nodes/ConditionNode.tsx`
- `nodes/SkillNode.tsx`
- `nodes/PromptNode.tsx`
- `nodes/ChannelActionNode.tsx`

Notes:

- No `as const` trap for `NODE_TYPES` map.
- Add nodes via `screenToFlowPosition()` to respect pan/zoom.
- Show explicit `loadError` and `saveError` states.

Integration:

- `CronView` opens `FlowBuilderView` via dynamic import (`ssr: false`).

---

## 8. Task Plan (TDD, bite-sized)

### Task 1: Type System + Mapper + Repository Surface

Files:

- Create: `src/server/automation/flowTypes.ts`
- Modify: `src/server/automation/types.ts`
- Modify: `src/server/automation/automationRowMappers.ts`
- Modify: `src/server/automation/repository.ts`

Steps:

1. Write failing unit tests for `toRule` flow parsing and legacy-null behavior.
2. Run targeted tests and confirm RED.
3. Add types and mapper parsing with corrupt JSON fallback to null.
4. Re-run tests to GREEN.
5. Commit.

### Task 2: SQLite Migration + Flow CRUD in Repository

Files:

- Modify: `src/server/automation/sqliteAutomationRepository.ts`
- Test: `tests/unit/automation/*`

Steps:

1. Write failing tests for `getFlowGraph/saveFlowGraph` and migration idempotency.
2. Run tests (RED).
3. Implement column migration + methods.
4. Run tests (GREEN).
5. Commit.

### Task 3: Service Methods for Flow Save/Get

Files:

- Modify: `src/server/automation/service.ts`
- Test: `tests/unit/automation/service*.test.ts`

Steps:

1. Write failing tests for service flow save/get behavior.
2. Implement minimal service methods and compile integration.
3. Verify tests pass.
4. Commit.

### Task 4: Graph Validator

Files:

- Create: `src/server/automation/flowValidator.ts`
- Create: `tests/unit/automation/flowValidator.test.ts`

Validator checks:

- missing trigger
- multiple triggers
- cycle detection
- invalid cron on cron trigger

Steps:

1. RED tests per rule.
2. Implement validator.
3. GREEN tests.
4. Commit.

### Task 5: Compiler

Files:

- Create: `src/server/automation/flowCompiler.ts`
- Create: `tests/unit/automation/flowCompiler.test.ts`

Compiler checks:

- cron extraction from `trigger.cron`
- manual/webhook semantics
- deterministic prompt step generation in topological order

Steps:

1. RED tests.
2. Minimal compiler.
3. GREEN tests.
4. Commit.

### Task 6: Flow API Route

Files:

- Create: `app/api/automations/[id]/flow/route.ts`
- Create: `tests/integration/flow-api.test.ts`

Checks:

- GET/PUT happy paths
- invalid JSON
- invalid graph
- payload too large

Steps:

1. RED integration tests.
2. Implement route with size guard and error handling.
3. GREEN tests.
4. Commit.

### Task 7: Frontend Types + Hook

Files:

- Create: `src/modules/flow-builder/types.ts`
- Create: `src/modules/flow-builder/useFlowEditor.ts`
- Test: `tests/unit/modules/flow-builder/*.test.ts` (if present) or integration-level assertions

Checks:

- load graph
- edit state dirty tracking
- save graph
- error states

Steps:

1. RED tests.
2. Implement hook.
3. GREEN tests.
4. Commit.

### Task 8: Canvas + Palette + Node Components

Files:

- Create: components and node files under `src/modules/flow-builder/`

Checks:

- node rendering by type
- add node at viewport-aware coordinates
- connect edges
- select node for config panel

Steps:

1. RED component tests for basic interactions.
2. Implement minimal components.
3. GREEN tests.
4. Commit.

### Task 9: FlowBuilderView + CronView Integration

Files:

- Create: `src/modules/flow-builder/FlowBuilderView.tsx`
- Modify: `src/modules/cron/components/CronView.tsx`

Checks:

- open builder from cron view
- save and return
- legacy cron edit path still functional

Steps:

1. RED integration test.
2. Implement dynamic load and view wiring.
3. GREEN test.
4. Commit.

### Task 10: End-to-End Verification and Cleanup

Files:

- Docs and touched files from previous tasks

Steps:

1. Run full checks.
2. Fix regressions.
3. Update docs summary and API references.
4. Commit.

---

## 9. Verification Commands

Targeted:

- `npx vitest run tests/unit/automation/flowTypes.test.ts`
- `npx vitest run tests/unit/automation/flowValidator.test.ts`
- `npx vitest run tests/unit/automation/flowCompiler.test.ts`
- `npx vitest run tests/integration/flow-api.test.ts`

Full:

- `npm run typecheck`
- `npm run lint`
- `npm run test`
- `npm run build`

---

## 10. Rollout Strategy

Phase 1:

- Deploy with flow support and keep existing cron rules untouched.

Phase 2:

- Create new flows on selected non-critical rules.

Phase 3:

- Migrate existing complex rules to flow graphs where useful.

Rollback:

- Ignore `flow_graph` and continue executing legacy `prompt + cron` data.
- No destructive migration rollback required because `flow_graph` is additive/nullable.

---

## 11. Risks and Mitigations

1. Risk: invalid flow JSON corrupts reads.

- Mitigation: mapper parse guard -> `flowGraph: null`.

2. Risk: trigger semantics accidentally disable scheduling.

- Mitigation: strict validator + compiler tests per trigger type.

3. Risk: UI saves oversized graph payloads.

- Mitigation: 500 KB route guard and explicit error feedback.

4. Risk: regressions in existing cron UI.

- Mitigation: integration test for legacy path + flow path.

---

## 12. Definition of Done

- Flow graph can be created, edited, saved, and reloaded.
- Backend validates and compiles graph safely.
- Existing cron-only rules remain functional.
- All targeted tests pass.
- Full checks pass:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run test`
  - `npm run build`
- Documentation and API behavior are updated and consistent.
