# Agent Room Swarm Workflow (Option B, V2-First) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver an `Agent Room` page where operators can create and run swarms with `New Swarm -> Deploy Agents -> automated phases`, including `Solution Artifact`, `Logic Graph (SVG canvas)`, `History`, and `Conflict Radar` views on top of existing Agent v2.

**Architecture:** Reuse `/ws-agent-v2` and existing `agent.v2.session.*` methods only. Keep orchestration frontend-first with a deterministic reducer + runtime hook that sequences phase prompts in one v2 session and maps event stream updates into UI panels. Implement advanced room UX (tabs, canvas, history, friction, controls) without reviving legacy rooms backend.

**Tech Stack:** Next.js client components, React hooks/reducers, existing `AgentV2GatewayClient`, Mermaid-for-SVG rendering in browser, Vitest.

---

## Scope Guardrails (MVP)

- Reuse existing v2 methods only: `agent.v2.session.start/input/follow_up/steer/abort/list/replay/get`.
- No new `/api/rooms/*` domain revival and no new `/api/agent-spawn/*` route family in MVP.
- No new mission/artifact SQLite tables in MVP.
- Swarm metadata persistence is client-side (local storage) in MVP.
- Multi-agent behavior is role-simulated in one v2 session (no parallel backend executors in MVP).

---

## Delta Analysis: Missing Functions From `2026-02-24-multi-agent-spawn`

Below are the missing functions from the inserted frontpage code and how they are now integrated into this plan:

1. `Swarm Units` sidebar with multiple swarms, selection, and per-swarm status: **was missing**, now covered in Task 6.
2. `split/chat/board` layout modes: **was missing**, now covered in Task 8.
3. Tabbed result workspace (`Solution Artifact`, `Logic Graph`, `History`, `Conflict Radar`): **partially missing**, now covered in Task 9.
4. `Logic Graph` SVG canvas with source-logic block: **was missing**, now covered in Task 10.
5. Artifact version history + restore: **was missing**, now covered in Task 11.
6. Friction/conflict model + confidence/HOLD handling: **was missing**, now covered in Task 12.
7. Dynamic swarm member management (`Add Agent`): **was missing**, now covered in Task 7 and Task 13.
8. Operator guidance input during run: **was missing**, now covered in Task 13.
9. Force-progress controls (`Force Next Phase` / force completion semantics): **was missing**, now covered in Task 13 and Task 14.
10. Mission lifecycle controls (abort/delete/export JSON): **partially missing**, now covered in Task 14.
11. Canvas preview question (SVG visual representation by agents): **was not integrated**, now explicitly in Task 10.
12. Workspace file explorer + live preview iframe: **not in MVP**, moved to Phase 2 to avoid backend expansion.
13. Full 3-pillar command board/registry/system views: **not in MVP**, moved to Phase 2.

---

## Target UX (Must Match)

1. User clicks `Agent Room` in sidebar.
2. User clicks `New Swarm`.
3. Modal captures: title, task, units, lead unit, optional template.
4. User clicks `Deploy Agents`.
5. System auto-runs phases:
   - Analysis
   - Ideation
   - Critique
   - Best Case
   - Result
6. UI shows:
   - phase rail
   - live event timeline
   - tabbed output (`Solution Artifact` / `Logic Graph` / `History` / `Conflict Radar`)
   - swarm list/status in left rail
7. User can:
   - steer run with operator input
   - add specialist units
   - abort
   - force phase advance
   - export run JSON
   - delete swarm entry

---

### Task 1: Lock Navigation + View Entry For Agent Room

**Files:**
- Modify: `src/shared/domain/types.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/modules/app-shell/components/AppShellViewContent.tsx`
- Test: `tests/unit/components/agent-room-navigation.test.ts`
- Test: `tests/unit/components/agent-room-view-routing.test.ts`

**Step 1: Write failing tests**

Add/adjust tests so they assert:
- `View.AGENT_ROOM === 'agent-room'`
- sidebar contains label `Agent Room`
- AppShell routes `View.AGENT_ROOM` to `AgentRoomView`

**Step 2: Run tests to verify failure**

```bash
pnpm vitest run tests/unit/components/agent-room-navigation.test.ts tests/unit/components/agent-room-view-routing.test.ts
```

Expected: FAIL until enum/sidebar/routing are wired.

**Step 3: Implement minimal wiring**

- Add enum entry in `src/shared/domain/types.ts`.
- Add sidebar item in `src/components/Sidebar.tsx`.
- Add dynamic import + view branch in `AppShellViewContent.tsx`.

**Step 4: Run tests to verify pass**

```bash
pnpm vitest run tests/unit/components/agent-room-navigation.test.ts tests/unit/components/agent-room-view-routing.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/shared/domain/types.ts src/components/Sidebar.tsx src/modules/app-shell/components/AppShellViewContent.tsx tests/unit/components/agent-room-navigation.test.ts tests/unit/components/agent-room-view-routing.test.ts
git commit -m "feat(agent-room): add navigation and app-shell routing"
```

---

### Task 2: Define Swarm Domain Contracts (Rooms, Phases, Tabs, Run State)

**Files:**
- Create: `src/modules/agent-room/swarmTypes.ts`
- Create: `src/modules/agent-room/swarmPhases.ts`
- Create: `src/modules/agent-room/swarmViewState.ts`
- Test: `tests/unit/agent-room/swarm-phases.test.ts`
- Test: `tests/unit/agent-room/swarm-view-state.test.ts`

**Step 1: Write failing tests**

Create tests for:
- exact phase order contract
- `nextPhase`, `isTerminalPhase`
- tab constants: `draft|diagram|history|friction`
- view modes: `split|chat|board`

Example assertions:

```ts
expect(SWARM_PHASES).toEqual(['analysis', 'ideation', 'critique', 'best_case', 'result']);
expect(SWARM_OUTPUT_TABS).toEqual(['draft', 'diagram', 'history', 'friction']);
expect(nextPhase('analysis')).toBe('ideation');
```

**Step 2: Run tests to verify failure**

```bash
pnpm vitest run tests/unit/agent-room/swarm-phases.test.ts tests/unit/agent-room/swarm-view-state.test.ts
```

Expected: FAIL because modules are missing.

**Step 3: Implement minimal contracts**

`swarmTypes.ts` includes:
- `SwarmPhase`, `SwarmStatus`, `SwarmOutputTab`, `SwarmViewMode`
- `SwarmUnitRole`, `SwarmUnit`
- `NewSwarmForm`
- `SwarmRunState`, `SwarmArtifactState`, `SwarmFrictionState`

`swarmPhases.ts` includes:
- `SWARM_PHASES`
- `nextPhase(phase)`
- `isTerminalPhase(phase)`

`swarmViewState.ts` includes:
- `SWARM_OUTPUT_TABS`
- `SWARM_VIEW_MODES`
- labels for UI rendering

**Step 4: Run tests to verify pass**

```bash
pnpm vitest run tests/unit/agent-room/swarm-phases.test.ts tests/unit/agent-room/swarm-view-state.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/agent-room/swarmTypes.ts src/modules/agent-room/swarmPhases.ts src/modules/agent-room/swarmViewState.ts tests/unit/agent-room/swarm-phases.test.ts tests/unit/agent-room/swarm-view-state.test.ts
git commit -m "feat(agent-room): define swarm room, phase, and view contracts"
```

---

### Task 3: Add Prompt Templates For Role-Based Phases

**Files:**
- Create: `src/modules/agent-room/swarmPrompts.ts`
- Test: `tests/unit/agent-room/swarm-prompts.test.ts`

**Step 1: Write failing tests**

Create tests for prompt builder guarantees:
- includes operator task
- includes units and lead unit
- includes phase name
- includes collaboration instructions (idea exchange, critique, consensus)

**Step 2: Run test to verify failure**

```bash
pnpm vitest run tests/unit/agent-room/swarm-prompts.test.ts
```

Expected: FAIL because builder module is missing.

**Step 3: Implement minimal prompt builder**

Implement:

```ts
export function buildPhasePrompt(input: {
  phase: SwarmPhase;
  task: string;
  units: SwarmUnit[];
}): string;
```

Per phase templates enforce:
- structured unit responses
- cross-review between units
- explicit vote/consensus marker
- handoff to next phase

**Step 4: Run test to verify pass**

```bash
pnpm vitest run tests/unit/agent-room/swarm-prompts.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/agent-room/swarmPrompts.ts tests/unit/agent-room/swarm-prompts.test.ts
git commit -m "feat(agent-room): add role-based phase prompts"
```

---

### Task 4: Build Deterministic Swarm Orchestrator Reducer (Pure Logic)

**Files:**
- Create: `src/modules/agent-room/swarmOrchestratorState.ts`
- Test: `tests/unit/agent-room/swarm-orchestrator-state.test.ts`

**Step 1: Write failing tests**

Cover reducer transitions:
- `deploy_requested` -> running `analysis`
- `phase_completed` moves to next phase
- `phase_failed` sets failed state
- `abort_requested` / `aborted`
- `force_next_phase`
- `result` phase marks run complete

**Step 2: Run test to verify failure**

```bash
pnpm vitest run tests/unit/agent-room/swarm-orchestrator-state.test.ts
```

Expected: FAIL because reducer does not exist.

**Step 3: Implement minimal reducer**

Add pure reducer with action union:
- `DEPLOY_REQUESTED`
- `PHASE_ENQUEUED`
- `PHASE_COMPLETED`
- `PHASE_FAILED`
- `FORCE_NEXT_PHASE`
- `ABORT_REQUESTED`
- `ABORTED`
- `RUN_COMPLETED`

No network code in this file.

**Step 4: Run test to verify pass**

```bash
pnpm vitest run tests/unit/agent-room/swarm-orchestrator-state.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/agent-room/swarmOrchestratorState.ts tests/unit/agent-room/swarm-orchestrator-state.test.ts
git commit -m "feat(agent-room): add deterministic orchestrator state machine"
```

---

### Task 5: Extend Runtime Hook With `deploySwarm()` Sequencer (v2-only)

**Files:**
- Create: `src/modules/agent-room/hooks/useAgentRoomRuntime.ts`
- Create: `tests/unit/modules/agent-room/use-agent-room-runtime-swarm-contract.test.ts`

**Step 1: Write failing contract test**

Assert source contains v2-only orchestration path:
- `agent.v2.session.start`
- first dispatch via `agent.v2.session.input`
- subsequent phases via `agent.v2.session.follow_up`
- steering via `agent.v2.session.steer`
- stop via `agent.v2.session.abort`
- no `/api/agent-spawn` usage

**Step 2: Run test to verify failure**

```bash
pnpm vitest run tests/unit/modules/agent-room/use-agent-room-runtime-swarm-contract.test.ts
```

Expected: FAIL because hook is missing.

**Step 3: Implement minimal sequencer**

Add hook API:

```ts
deploySwarm(form: NewSwarmForm): Promise<void>;
abortCurrentSwarm(): Promise<void>;
forceNextPhase(): Promise<void>;
sendOperatorGuidance(text: string): Promise<void>;
```

Flow:
1. `session.start`
2. enqueue `analysis` with `session.input`
3. on `agent.v2.command.completed`, enqueue next phase via `session.follow_up`
4. stop after `result`
5. stream events into timeline model

**Step 4: Run test to verify pass**

```bash
pnpm vitest run tests/unit/modules/agent-room/use-agent-room-runtime-swarm-contract.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/agent-room/hooks/useAgentRoomRuntime.ts tests/unit/modules/agent-room/use-agent-room-runtime-swarm-contract.test.ts
git commit -m "feat(agent-room): add v2-only swarm runtime sequencer"
```

---

### Task 6: Build Swarm Units Sidebar + Local Persistence

**Files:**
- Create: `src/modules/agent-room/hooks/useSwarmCatalogState.ts`
- Modify: `src/modules/agent-room/components/AgentRoomView.tsx`
- Test: `tests/unit/modules/agent-room/use-swarm-catalog-state.test.ts`
- Test: `tests/unit/components/agent-room-sidebar.test.ts`

**Step 1: Write failing tests**

Cover:
- add/select/delete swarm cards
- status/phase/consensus display on cards
- localStorage roundtrip (`agent_room_swarms_v1`)

**Step 2: Run tests to verify failure**

```bash
pnpm vitest run tests/unit/modules/agent-room/use-swarm-catalog-state.test.ts tests/unit/components/agent-room-sidebar.test.ts
```

Expected: FAIL because catalog state/store is missing.

**Step 3: Implement minimal sidebar state**

- Create catalog hook for CRUD/select + persistence.
- Render left rail with `New Swarm` and swarm list cards.
- Keep persistence strictly client-side for MVP.

**Step 4: Run tests to verify pass**

```bash
pnpm vitest run tests/unit/modules/agent-room/use-swarm-catalog-state.test.ts tests/unit/components/agent-room-sidebar.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/agent-room/hooks/useSwarmCatalogState.ts src/modules/agent-room/components/AgentRoomView.tsx tests/unit/modules/agent-room/use-swarm-catalog-state.test.ts tests/unit/components/agent-room-sidebar.test.ts
git commit -m "feat(agent-room): add swarm units sidebar with local persistence"
```

---

### Task 7: Build `New Swarm` Modal (Task + Lead + Units + Template)

**Files:**
- Create: `src/modules/agent-room/components/NewSwarmModal.tsx`
- Modify: `src/modules/agent-room/components/AgentRoomView.tsx`
- Test: `tests/unit/components/new-swarm-modal.test.tsx`

**Step 1: Write failing tests**

Cover:
- required `task`
- optional `title`
- lead unit selector
- unit roster editor
- template picker
- `Deploy Agents` submit callback

**Step 2: Run test to verify failure**

```bash
pnpm vitest run tests/unit/components/new-swarm-modal.test.tsx
```

Expected: FAIL until modal exists.

**Step 3: Implement minimal UI**

Fields:
- `swarmTitle` (optional)
- `task` (required)
- `leadUnit` (required)
- `units` (editable list)
- `template` (optional presets)

Submit button: `Deploy Agents`.

**Step 4: Run test to verify pass**

```bash
pnpm vitest run tests/unit/components/new-swarm-modal.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/agent-room/components/NewSwarmModal.tsx src/modules/agent-room/components/AgentRoomView.tsx tests/unit/components/new-swarm-modal.test.tsx
git commit -m "feat(agent-room): add advanced new swarm modal"
```

---

### Task 8: Add Main Layout Modes (`split`, `chat`, `board`)

**Files:**
- Modify: `src/modules/agent-room/components/AgentRoomView.tsx`
- Test: `tests/unit/components/agent-room-layout-modes.test.tsx`

**Step 1: Write failing tests**

Cover:
- mode toggles exist
- toggling changes visible pane composition
- active mode state survives tab changes

**Step 2: Run test to verify failure**

```bash
pnpm vitest run tests/unit/components/agent-room-layout-modes.test.tsx
```

Expected: FAIL because layout mode controls are missing.

**Step 3: Implement minimal mode toggles**

- Add three mode buttons.
- Bind visibility widths for chat pane and board pane.
- Keep responsive fallback on small screens.

**Step 4: Run test to verify pass**

```bash
pnpm vitest run tests/unit/components/agent-room-layout-modes.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/agent-room/components/AgentRoomView.tsx tests/unit/components/agent-room-layout-modes.test.tsx
git commit -m "feat(agent-room): add split chat board layout modes"
```

---

### Task 9: Add Output Tabs (`Artifact`, `Logic Graph`, `History`, `Conflict Radar`)

**Files:**
- Modify: `src/modules/agent-room/components/AgentRoomView.tsx`
- Test: `tests/unit/components/agent-room-output-tabs.test.tsx`

**Step 1: Write failing tests**

Cover:
- four tab headers render
- tab switching updates content region
- tab state is preserved while run updates stream

**Step 2: Run test to verify failure**

```bash
pnpm vitest run tests/unit/components/agent-room-output-tabs.test.tsx
```

Expected: FAIL because tabbed output container is missing.

**Step 3: Implement minimal tab container**

- Build stable tab shell with placeholders for each panel.
- Connect tab state to `SwarmOutputTab`.

**Step 4: Run test to verify pass**

```bash
pnpm vitest run tests/unit/components/agent-room-output-tabs.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/agent-room/components/AgentRoomView.tsx tests/unit/components/agent-room-output-tabs.test.tsx
git commit -m "feat(agent-room): add artifact logic graph history conflict tabs"
```

---

### Task 10: Implement Logic Graph Canvas (Mermaid -> SVG) + Source Logic

**Files:**
- Create: `src/modules/agent-room/components/LogicGraphPanel.tsx`
- Create: `src/modules/agent-room/logicGraph.ts`
- Modify: `src/modules/agent-room/components/AgentRoomView.tsx`
- Test: `tests/unit/agent-room/logic-graph.test.ts`
- Test: `tests/unit/components/logic-graph-panel.test.tsx`

**Step 1: Write failing tests**

Cover:
- extracts first Mermaid block from phase outputs
- renders SVG container when Mermaid exists
- shows source logic text block
- graceful fallback for invalid diagrams

**Step 2: Run tests to verify failure**

```bash
pnpm vitest run tests/unit/agent-room/logic-graph.test.ts tests/unit/components/logic-graph-panel.test.tsx
```

Expected: FAIL because parser/panel are missing.

**Step 3: Implement minimal canvas path**

- `logicGraph.ts`: parse/sanitize Mermaid block from artifact text.
- `LogicGraphPanel.tsx`: render SVG via Mermaid client runtime.
- Include explicit `SVG Render Protocol` badge and source text section.

**Step 4: Run tests to verify pass**

```bash
pnpm vitest run tests/unit/agent-room/logic-graph.test.ts tests/unit/components/logic-graph-panel.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/agent-room/components/LogicGraphPanel.tsx src/modules/agent-room/logicGraph.ts src/modules/agent-room/components/AgentRoomView.tsx tests/unit/agent-room/logic-graph.test.ts tests/unit/components/logic-graph-panel.test.tsx
git commit -m "feat(agent-room): add logic graph svg canvas and source preview"
```

---

### Task 11: Implement Artifact Version History + Restore

**Files:**
- Create: `src/modules/agent-room/artifactHistory.ts`
- Modify: `src/modules/agent-room/swarmOrchestratorState.ts`
- Modify: `src/modules/agent-room/components/AgentRoomView.tsx`
- Test: `tests/unit/agent-room/artifact-history.test.ts`
- Test: `tests/unit/components/agent-room-history-tab.test.tsx`

**Step 1: Write failing tests**

Cover:
- snapshot current artifact when a newer one arrives
- keep bounded history depth (e.g. max 10)
- restore previous version to active artifact

**Step 2: Run tests to verify failure**

```bash
pnpm vitest run tests/unit/agent-room/artifact-history.test.ts tests/unit/components/agent-room-history-tab.test.tsx
```

Expected: FAIL because history logic is missing.

**Step 3: Implement minimal history flow**

- Add helper to append bounded history.
- Reducer stores `artifactHistory`.
- History tab lists versions and exposes `Restore`.

**Step 4: Run tests to verify pass**

```bash
pnpm vitest run tests/unit/agent-room/artifact-history.test.ts tests/unit/components/agent-room-history-tab.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/agent-room/artifactHistory.ts src/modules/agent-room/swarmOrchestratorState.ts src/modules/agent-room/components/AgentRoomView.tsx tests/unit/agent-room/artifact-history.test.ts tests/unit/components/agent-room-history-tab.test.tsx
git commit -m "feat(agent-room): add artifact version history and restore"
```

---

### Task 12: Implement Conflict Radar + Confidence/HOLD Logic

**Files:**
- Create: `src/modules/agent-room/conflictRadar.ts`
- Modify: `src/modules/agent-room/swarmOrchestratorState.ts`
- Modify: `src/modules/agent-room/components/AgentRoomView.tsx`
- Test: `tests/unit/agent-room/conflict-radar.test.ts`
- Test: `tests/unit/components/agent-room-conflict-radar.test.tsx`

**Step 1: Write failing tests**

Cover:
- friction increments from disagreement markers
- confidence score recomputation
- HOLD state triggered under threshold
- HOLD banner shown in UI

**Step 2: Run tests to verify failure**

```bash
pnpm vitest run tests/unit/agent-room/conflict-radar.test.ts tests/unit/components/agent-room-conflict-radar.test.tsx
```

Expected: FAIL because radar logic is missing.

**Step 3: Implement minimal conflict model**

- Parse disagreement signals from responses/events.
- Track friction pairs + confidence score.
- If score `< 70`, set `hold` flag and pause automatic phase progression until operator action.

**Step 4: Run tests to verify pass**

```bash
pnpm vitest run tests/unit/agent-room/conflict-radar.test.ts tests/unit/components/agent-room-conflict-radar.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/agent-room/conflictRadar.ts src/modules/agent-room/swarmOrchestratorState.ts src/modules/agent-room/components/AgentRoomView.tsx tests/unit/agent-room/conflict-radar.test.ts tests/unit/components/agent-room-conflict-radar.test.tsx
git commit -m "feat(agent-room): add conflict radar with confidence hold gating"
```

---

### Task 13: Add Runtime Controls (Add Unit, Guidance, Force Phase)

**Files:**
- Modify: `src/modules/agent-room/components/AgentRoomView.tsx`
- Modify: `src/modules/agent-room/hooks/useAgentRoomRuntime.ts`
- Test: `tests/unit/components/agent-room-controls.test.tsx`

**Step 1: Write failing tests**

Cover:
- add specialist unit while idle
- send operator guidance dispatches `session.steer`
- force next phase action available to operator

**Step 2: Run tests to verify failure**

```bash
pnpm vitest run tests/unit/components/agent-room-controls.test.tsx
```

Expected: FAIL until controls are wired.

**Step 3: Implement minimal control bar**

- `Add Agent` modal/list using existing persona roster in frontend.
- Operator guidance input triggers `sendOperatorGuidance`.
- `Force Next Phase` triggers reducer `FORCE_NEXT_PHASE`.

**Step 4: Run tests to verify pass**

```bash
pnpm vitest run tests/unit/components/agent-room-controls.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/agent-room/components/AgentRoomView.tsx src/modules/agent-room/hooks/useAgentRoomRuntime.ts tests/unit/components/agent-room-controls.test.tsx
git commit -m "feat(agent-room): add swarm controls and operator guidance workflow"
```

---

### Task 14: Mission Lifecycle Controls (Abort, Delete, Force Complete, Export JSON)

**Files:**
- Modify: `src/modules/agent-room/components/AgentRoomView.tsx`
- Modify: `src/modules/agent-room/hooks/useSwarmCatalogState.ts`
- Test: `tests/unit/components/agent-room-lifecycle-controls.test.tsx`

**Step 1: Write failing tests**

Cover:
- abort dispatches `agent.v2.session.abort`
- delete removes swarm from catalog
- force complete marks terminal phase/result state
- export downloads JSON payload with phases/events/artifacts

**Step 2: Run tests to verify failure**

```bash
pnpm vitest run tests/unit/components/agent-room-lifecycle-controls.test.tsx
```

Expected: FAIL until controls/export are implemented.

**Step 3: Implement minimal lifecycle controls**

- Keep existing abort path.
- Add delete confirmation modal.
- Add force complete command (UI-level terminalization with warning).
- Add export generator for current swarm object.

**Step 4: Run tests to verify pass**

```bash
pnpm vitest run tests/unit/components/agent-room-lifecycle-controls.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/agent-room/components/AgentRoomView.tsx src/modules/agent-room/hooks/useSwarmCatalogState.ts tests/unit/components/agent-room-lifecycle-controls.test.tsx
git commit -m "feat(agent-room): add mission lifecycle controls and export"
```

---

### Task 15: Documentation + Verification

**Files:**
- Modify: `docs/AGENT_V2_RUNBOOK.md`
- Modify: `docs/plans/2026-02-24-agent-room-option-b-v2-implementation.md` (final touchups)
- Modify: `.agent/CONTINUITY.md`

**Step 1: Update runbook docs**

Add `Agent Room` section:
- swarm setup flow (`New Swarm` -> `Deploy Agents`)
- phase automation contract
- output tabs contract
- logic graph SVG behavior
- conflict HOLD behavior
- MVP constraints

**Step 2: Run verification**

```bash
pnpm vitest run tests/unit/components/agent-room-navigation.test.ts tests/unit/components/agent-room-view-routing.test.ts tests/unit/agent-room/swarm-phases.test.ts tests/unit/agent-room/swarm-view-state.test.ts tests/unit/agent-room/swarm-prompts.test.ts tests/unit/agent-room/swarm-orchestrator-state.test.ts tests/unit/modules/agent-room/use-agent-room-runtime-swarm-contract.test.ts tests/unit/modules/agent-room/use-swarm-catalog-state.test.ts tests/unit/components/new-swarm-modal.test.tsx tests/unit/components/agent-room-sidebar.test.ts tests/unit/components/agent-room-layout-modes.test.tsx tests/unit/components/agent-room-output-tabs.test.tsx tests/unit/agent-room/logic-graph.test.ts tests/unit/components/logic-graph-panel.test.tsx tests/unit/agent-room/artifact-history.test.ts tests/unit/components/agent-room-history-tab.test.tsx tests/unit/agent-room/conflict-radar.test.ts tests/unit/components/agent-room-conflict-radar.test.tsx tests/unit/components/agent-room-controls.test.tsx tests/unit/components/agent-room-lifecycle-controls.test.tsx tests/unit/gateway/agent-v2-methods.test.ts
pnpm typecheck
pnpm lint
```

Expected:
- targeted tests pass
- typecheck passes
- no new lint errors from Agent Room additions

**Step 3: Commit**

```bash
git add docs/AGENT_V2_RUNBOOK.md .agent/CONTINUITY.md
git commit -m "docs(agent-room): document full swarm room workflow on v2 runtime"
```

---

## Phase 2 (Post-MVP, Explicitly Deferred)

- Workspace explorer + live preview iframe backed by safe project/workspace read API.
- Backend-resilient swarm execution command (`swarm_run`) so runs survive tab close.
- True parallel unit execution (multi-session orchestrated swarm) instead of single-session role simulation.
- 3-pillar command board/registry/system views.

---

Plan complete and saved to `docs/plans/2026-02-24-agent-room-option-b-v2-implementation.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
