# Agent Room Swarm Workflow (Option B, V2-First, Production-Ready) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver an `Agent Room` page where operators run swarms with `New Swarm -> Deploy Agents -> automated phases`, while meeting production requirements for durability, persona integration, security, observability, and safe rollout.

**Architecture:** Keep execution on existing Agent v2 (`agent.v2.session.*`) and persist swarm state server-side in our existing `messages.db` architecture (SQLite migrations + repository query modules). Use our own personas as first-class swarm units by wiring `PersonaContext` in the UI and persona binding in session start/backend validation. Keep room UX modular (`Artifact`, `Logic Graph`, `History`, `Conflict Radar`) and recoverable after reload via persisted `sessionId` + replay.

**Tech Stack:** Next.js client components, React hooks/reducers, existing `AgentV2GatewayClient`, Agent v2 websocket methods, SQLite (`better-sqlite3`) repository/migrations, Vitest, Mermaid (client-only).

---

## Production Acceptance Gates (Must Pass)

1. **Durability:** No swarm-critical state is localStorage-only. Swarm catalog/state is persisted in `messages.db` and recoverable after tab close/reload/process restart.
2. **Persona Binding:** Swarms use our existing personas (`/api/personas`, `PersonaContext`, `conversations.persona_id`) end-to-end.
3. **Operational Safety:** Explicit validation, bounded payload sizes, graceful failure states, and kill switch.
4. **Observability:** Agent Room emits actionable telemetry (state transitions/errors) and exposes minimal control-plane metrics.
5. **Rollout Safety:** Feature flag + server guard + rollback procedure.

---

## Scope Guardrails (Revised)

- Reuse Agent v2 execution methods (`agent.v2.session.start/input/follow_up/steer/abort/list/replay/get`) for orchestration.
- Add thin swarm persistence methods under the same gateway namespace (`agent.v2.swarm.*`) instead of reviving legacy `/api/rooms/*`.
- Storage must follow existing system patterns:
  - SQLite `messages.db`
  - additive migration in `src/server/channels/messages/repository/migrations/index.ts`
  - query-module style in `src/server/channels/messages/repository/queries/*`
- No Search/Maps toggles, no native multimodal scope.
- No legacy rooms backend restoration.

---

## Storage Model (System-Fit, Required)

Add one additive table in messages repository migrations:

`agent_room_swarms`

- `id TEXT PRIMARY KEY`
- `conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE`
- `user_id TEXT NOT NULL`
- `session_id TEXT REFERENCES agent_v2_sessions(id)`
- `title TEXT NOT NULL`
- `task TEXT NOT NULL`
- `lead_persona_id TEXT NOT NULL`
- `units_json TEXT NOT NULL`
- `status TEXT NOT NULL` (`idle|running|hold|completed|aborted|error`)
- `current_phase TEXT NOT NULL`
- `consensus_score INTEGER NOT NULL DEFAULT 0`
- `hold_flag INTEGER NOT NULL DEFAULT 0`
- `artifact_json TEXT NOT NULL DEFAULT ''`
- `artifact_history_json TEXT NOT NULL DEFAULT '[]'`
- `friction_json TEXT NOT NULL DEFAULT '{}'`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

Indexes:

- `(user_id, updated_at DESC)`
- `(conversation_id, updated_at DESC)`
- optional unique partial `(session_id)` where not null

Rationale:

- Execution truth stays in `agent_v2_sessions/commands/events`.
- Room projection/state is persisted in the same DB and survives client loss.

---

## Target UX (Must Match)

1. User opens `Agent Room` in sidebar.
2. User clicks `New Swarm`.
3. Modal captures: title, task, lead persona, swarm units (from our persona list), optional template.
4. User clicks `Deploy Agents`.
5. System runs phases:
   - Analysis
   - Ideation
   - Critique
   - Best Case
   - Result
6. UI shows:
   - phase rail
   - live timeline
   - tabs (`Solution Artifact`, `Logic Graph`, `History`, `Conflict Radar`)
   - swarm list/status in left rail
7. User controls:
   - operator guidance (`steer`)
   - add specialist persona
   - abort
   - force next phase
   - force complete
   - export run JSON
   - delete swarm

---

### Task 1: Navigation + Runtime/Persona Gating For Agent Room

**Files:**

- Modify: `src/shared/domain/types.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/modules/app-shell/components/AppShellViewContent.tsx`
- Modify: `src/modules/app-shell/App.tsx`
- Test: `tests/unit/components/agent-room-navigation.test.ts`
- Test: `tests/unit/components/agent-room-view-routing.test.ts`
- Test: `tests/unit/app-shell/agent-room-view-gating.test.ts`

**Step 1: Write failing tests**

Assert:

- `View.AGENT_ROOM === 'agent-room'`
- sidebar item exists
- view routing resolves to `AgentRoomView`
- `App.tsx` enables persona data/runtime/skills loading when `currentView === View.AGENT_ROOM`

**Step 2: Run tests to verify failure**

```bash
pnpm vitest run tests/unit/components/agent-room-navigation.test.ts tests/unit/components/agent-room-view-routing.test.ts tests/unit/app-shell/agent-room-view-gating.test.ts
```

**Step 3: Implement minimal wiring**

- Add `View.AGENT_ROOM`.
- Add sidebar entry and view branch.
- In `App.tsx`, include `View.AGENT_ROOM` in:
  - `shouldEnableAgentRuntime`
  - `shouldEnablePersonaData`
  - `shouldLoadSkills`

**Step 4: Run tests to verify pass**

```bash
pnpm vitest run tests/unit/components/agent-room-navigation.test.ts tests/unit/components/agent-room-view-routing.test.ts tests/unit/app-shell/agent-room-view-gating.test.ts
```

**Step 5: Commit**

```bash
git add src/shared/domain/types.ts src/components/Sidebar.tsx src/modules/app-shell/components/AppShellViewContent.tsx src/modules/app-shell/App.tsx tests/unit/components/agent-room-navigation.test.ts tests/unit/components/agent-room-view-routing.test.ts tests/unit/app-shell/agent-room-view-gating.test.ts
git commit -m "feat(agent-room): add navigation and app runtime gating"
```

---

### Task 2: Define Swarm Domain Contracts (Persona-First + Persisted IDs)

**Files:**

- Create: `src/modules/agent-room/swarmTypes.ts`
- Create: `src/modules/agent-room/swarmPhases.ts`
- Create: `src/modules/agent-room/swarmViewState.ts`
- Test: `tests/unit/agent-room/swarm-phases.test.ts`
- Test: `tests/unit/agent-room/swarm-types.test.ts`

**Step 1: Write failing tests**

Cover:

- phase order contract
- tab/view mode constants
- required fields include `leadPersonaId`, `units[{ personaId, role }]`, `sessionId`

**Step 2: Run tests to verify failure**

```bash
pnpm vitest run tests/unit/agent-room/swarm-phases.test.ts tests/unit/agent-room/swarm-types.test.ts
```

**Step 3: Implement contracts**

- `SwarmUnit` references persona IDs only (no ad-hoc free-text identities).
- `SwarmRecord` includes persisted server identifiers.

**Step 4: Run tests**

```bash
pnpm vitest run tests/unit/agent-room/swarm-phases.test.ts tests/unit/agent-room/swarm-types.test.ts
```

**Step 5: Commit**

```bash
git add src/modules/agent-room/swarmTypes.ts src/modules/agent-room/swarmPhases.ts src/modules/agent-room/swarmViewState.ts tests/unit/agent-room/swarm-phases.test.ts tests/unit/agent-room/swarm-types.test.ts
git commit -m "feat(agent-room): add persona-first swarm contracts"
```

---

### Task 3: Add SQLite Migration + Query Module For `agent_room_swarms`

**Files:**

- Modify: `src/server/channels/messages/repository/migrations/index.ts`
- Create: `src/server/channels/messages/repository/queries/agentRoom.ts`
- Modify: `src/server/channels/messages/repository/types.ts`
- Modify: `src/server/channels/messages/sqliteMessageRepository.ts`
- Test: `tests/unit/channels/agent-room-queries.test.ts`

**Step 1: Write failing tests**

Cover:

- create/list/get/update/delete swarm rows
- FK cascade by conversation delete
- user scoping (`user_id`)

**Step 2: Run tests to verify failure**

```bash
pnpm vitest run tests/unit/channels/agent-room-queries.test.ts
```

**Step 3: Implement migration + repository wiring**

- Add table + indexes.
- Add query methods in repository style:
  - `createAgentRoomSwarm`
  - `listAgentRoomSwarms`
  - `getAgentRoomSwarm`
  - `updateAgentRoomSwarm`
  - `deleteAgentRoomSwarm`

**Step 4: Run tests**

```bash
pnpm vitest run tests/unit/channels/agent-room-queries.test.ts
```

**Step 5: Commit**

```bash
git add src/server/channels/messages/repository/migrations/index.ts src/server/channels/messages/repository/queries/agentRoom.ts src/server/channels/messages/repository/types.ts src/server/channels/messages/sqliteMessageRepository.ts tests/unit/channels/agent-room-queries.test.ts
git commit -m "feat(agent-room): add persisted swarm storage in messages db"
```

---

### Task 4: Add Gateway Methods `agent.v2.swarm.*` (Thin Persistence API)

**Files:**

- Modify: `src/server/gateway/methods/agent-v2.ts`
- Test: `tests/unit/gateway/agent-v2-methods.test.ts`

**Step 1: Write failing tests**

Cover new methods:

- `agent.v2.swarm.create`
- `agent.v2.swarm.list`
- `agent.v2.swarm.get`
- `agent.v2.swarm.update`
- `agent.v2.swarm.delete`

**Step 2: Run tests**

```bash
pnpm vitest run tests/unit/gateway/agent-v2-methods.test.ts
```

**Step 3: Implement methods**

- Keep protocol `v2`.
- Validate request payloads and user scoping.
- Use repository query methods only (no new REST routes).

**Step 4: Run tests**

```bash
pnpm vitest run tests/unit/gateway/agent-v2-methods.test.ts
```

**Step 5: Commit**

```bash
git add src/server/gateway/methods/agent-v2.ts tests/unit/gateway/agent-v2-methods.test.ts
git commit -m "feat(agent-room): add agent.v2.swarm persistence methods"
```

---

### Task 5: Persona-Aware Session Start (Use Our Personas End-to-End)

**Files:**

- Modify: `src/server/agent-v2/sessionManager.ts`
- Modify: `src/server/gateway/methods/agent-v2.ts`
- Test: `tests/unit/agent-v2/session-manager-persona.test.ts`

**Step 1: Write failing tests**

Cover:

- `agent.v2.session.start` accepts `personaId` and optional `conversationId`
- conversation persona is set (`setPersonaId`) before first command
- invalid persona => request error

**Step 2: Run tests**

```bash
pnpm vitest run tests/unit/agent-v2/session-manager-persona.test.ts tests/unit/gateway/agent-v2-methods.test.ts
```

**Step 3: Implement**

- Extend `startSession` input with `personaId` and optional `conversationId`.
- If `conversationId` exists, resolve and validate ownership.
- Apply selected persona via message service before enqueueing work.

**Step 4: Run tests**

```bash
pnpm vitest run tests/unit/agent-v2/session-manager-persona.test.ts tests/unit/gateway/agent-v2-methods.test.ts
```

**Step 5: Commit**

```bash
git add src/server/agent-v2/sessionManager.ts src/server/gateway/methods/agent-v2.ts tests/unit/agent-v2/session-manager-persona.test.ts tests/unit/gateway/agent-v2-methods.test.ts
git commit -m "feat(agent-room): bind agent v2 sessions to selected personas"
```

---

### Task 6: Runtime Hook With Backend-Backed Catalog (No localStorage Truth)

**Files:**

- Create: `src/modules/agent-room/hooks/useAgentRoomRuntime.ts`
- Create: `src/modules/agent-room/hooks/useSwarmCatalogState.ts`
- Test: `tests/unit/modules/agent-room/use-agent-room-runtime-contract.test.ts`

**Step 1: Write failing tests**

Cover:

- catalog loaded via `agent.v2.swarm.list`
- deploy updates persisted swarm row
- runtime holds `sessionId` and `lastSeq` for replay recovery

**Step 2: Run tests**

```bash
pnpm vitest run tests/unit/modules/agent-room/use-agent-room-runtime-contract.test.ts
```

**Step 3: Implement**

- Move catalog source of truth to backend methods.
- Keep local state only as cache, not authoritative storage.
- Persist `sessionId` and replay cursor in swarm row updates.

**Step 4: Run tests**

```bash
pnpm vitest run tests/unit/modules/agent-room/use-agent-room-runtime-contract.test.ts
```

**Step 5: Commit**

```bash
git add src/modules/agent-room/hooks/useAgentRoomRuntime.ts src/modules/agent-room/hooks/useSwarmCatalogState.ts tests/unit/modules/agent-room/use-agent-room-runtime-contract.test.ts
git commit -m "feat(agent-room): use backend-backed swarm catalog and replay metadata"
```

---

### Task 7: New Swarm Modal Uses Real Persona Registry

**Files:**

- Create: `src/modules/agent-room/components/NewSwarmModal.tsx`
- Modify: `src/modules/agent-room/components/AgentRoomView.tsx`
- Test: `tests/unit/components/new-swarm-modal.test.tsx`

**Step 1: Write failing tests**

Cover:

- persona list comes from `usePersona().personas`
- lead persona required
- units are selected from existing personas only

**Step 2: Run tests**

```bash
pnpm vitest run tests/unit/components/new-swarm-modal.test.tsx
```

**Step 3: Implement**

- Remove free-text unit identities.
- Use persona IDs and labels from context.
- Block deploy when persona catalog is empty/unloaded.

**Step 4: Run tests**

```bash
pnpm vitest run tests/unit/components/new-swarm-modal.test.tsx
```

**Step 5: Commit**

```bash
git add src/modules/agent-room/components/NewSwarmModal.tsx src/modules/agent-room/components/AgentRoomView.tsx tests/unit/components/new-swarm-modal.test.tsx
git commit -m "feat(agent-room): wire new swarm modal to persona registry"
```

---

### Task 8: Deploy Sequencer + Idempotent Phase Queueing

**Files:**

- Modify: `src/modules/agent-room/hooks/useAgentRoomRuntime.ts`
- Create: `tests/unit/agent-room/swarm-sequencer.test.ts`

**Step 1: Write failing tests**

Cover:

- `start -> input -> follow_up` sequence
- idempotency keys per phase
- abort path
- hold/failure state transitions

**Step 2: Run tests**

```bash
pnpm vitest run tests/unit/agent-room/swarm-sequencer.test.ts
```

**Step 3: Implement**

- Deterministic phase sequencer.
- Persist phase transitions via `agent.v2.swarm.update`.
- Use `idempotencyKey` on queued commands.

**Step 4: Run tests**

```bash
pnpm vitest run tests/unit/agent-room/swarm-sequencer.test.ts
```

**Step 5: Commit**

```bash
git add src/modules/agent-room/hooks/useAgentRoomRuntime.ts tests/unit/agent-room/swarm-sequencer.test.ts
git commit -m "feat(agent-room): add idempotent phased deploy sequencer"
```

---

### Task 9: Recovery On Reload (List/Get/Replay Rehydrate)

**Files:**

- Modify: `src/modules/agent-room/hooks/useAgentRoomRuntime.ts`
- Modify: `src/modules/gateway/ws-agent-v2-client.ts`
- Test: `tests/unit/modules/agent-room/swarm-rehydrate.test.ts`

**Step 1: Write failing tests**

Cover:

- load swarm + session snapshot from backend
- replay from persisted `lastSeq`
- gracefully handle replay window expiry by fallback to `session.get`

**Step 2: Run tests**

```bash
pnpm vitest run tests/unit/modules/agent-room/swarm-rehydrate.test.ts
```

**Step 3: Implement**

- Rehydrate active swarm on view mount.
- Mark stale/incomplete states with clear operator message.

**Step 4: Run tests**

```bash
pnpm vitest run tests/unit/modules/agent-room/swarm-rehydrate.test.ts
```

**Step 5: Commit**

```bash
git add src/modules/agent-room/hooks/useAgentRoomRuntime.ts src/modules/gateway/ws-agent-v2-client.ts tests/unit/modules/agent-room/swarm-rehydrate.test.ts
git commit -m "fix(agent-room): recover active swarms via persisted session replay"
```

---

### Task 10: Output Shell + Layout Modes + Tabs

**Files:**

- Modify: `src/modules/agent-room/components/AgentRoomView.tsx`
- Test: `tests/unit/components/agent-room-layout-modes.test.tsx`
- Test: `tests/unit/components/agent-room-output-tabs.test.tsx`

**Step 1: Write failing tests**

Cover:

- split/chat/board modes
- 4 output tabs and stable switching

**Step 2: Run tests**

```bash
pnpm vitest run tests/unit/components/agent-room-layout-modes.test.tsx tests/unit/components/agent-room-output-tabs.test.tsx
```

**Step 3: Implement**

- Render composable panel layout.
- Keep responsive behavior.

**Step 4: Run tests**

```bash
pnpm vitest run tests/unit/components/agent-room-layout-modes.test.tsx tests/unit/components/agent-room-output-tabs.test.tsx
```

**Step 5: Commit**

```bash
git add src/modules/agent-room/components/AgentRoomView.tsx tests/unit/components/agent-room-layout-modes.test.tsx tests/unit/components/agent-room-output-tabs.test.tsx
git commit -m "feat(agent-room): add layout modes and output tab shell"
```

---

### Task 11: Logic Graph Canvas (Mermaid, Client-Safe)

**Files:**

- Modify: `package.json`
- Create: `src/modules/agent-room/logicGraph.ts`
- Create: `src/modules/agent-room/components/LogicGraphPanel.tsx`
- Modify: `src/modules/agent-room/components/AgentRoomView.tsx`
- Test: `tests/unit/agent-room/logic-graph.test.ts`

**Step 1: Write failing tests**

Cover:

- mermaid block extraction/sanitization
- invalid graph fallback behavior

**Step 2: Run tests**

```bash
pnpm vitest run tests/unit/agent-room/logic-graph.test.ts
```

**Step 3: Implement**

- Add Mermaid dependency.
- Load/render Mermaid client-only (`useEffect` + guarded import).
- Show source logic text panel.

**Step 4: Run tests**

```bash
pnpm vitest run tests/unit/agent-room/logic-graph.test.ts
```

**Step 5: Commit**

```bash
git add package.json src/modules/agent-room/logicGraph.ts src/modules/agent-room/components/LogicGraphPanel.tsx src/modules/agent-room/components/AgentRoomView.tsx tests/unit/agent-room/logic-graph.test.ts
git commit -m "feat(agent-room): add client-safe mermaid logic graph panel"
```

---

### Task 12: Artifact History + Conflict Radar Persisted Projection

**Files:**

- Create: `src/modules/agent-room/artifactHistory.ts`
- Create: `src/modules/agent-room/conflictRadar.ts`
- Modify: `src/modules/agent-room/swarmOrchestratorState.ts`
- Modify: `src/modules/agent-room/hooks/useAgentRoomRuntime.ts`
- Test: `tests/unit/agent-room/artifact-history.test.ts`
- Test: `tests/unit/agent-room/conflict-radar.test.ts`

**Step 1: Write failing tests**

Cover:

- bounded artifact history with restore
- friction/confidence/HOLD transitions
- projection persisted by swarm update method

**Step 2: Run tests**

```bash
pnpm vitest run tests/unit/agent-room/artifact-history.test.ts tests/unit/agent-room/conflict-radar.test.ts
```

**Step 3: Implement**

- Keep reducer pure.
- Persist projection snapshots to `agent_room_swarms` row.

**Step 4: Run tests**

```bash
pnpm vitest run tests/unit/agent-room/artifact-history.test.ts tests/unit/agent-room/conflict-radar.test.ts
```

**Step 5: Commit**

```bash
git add src/modules/agent-room/artifactHistory.ts src/modules/agent-room/conflictRadar.ts src/modules/agent-room/swarmOrchestratorState.ts src/modules/agent-room/hooks/useAgentRoomRuntime.ts tests/unit/agent-room/artifact-history.test.ts tests/unit/agent-room/conflict-radar.test.ts
git commit -m "feat(agent-room): persist artifact history and conflict radar projection"
```

---

### Task 13: Runtime Controls + Lifecycle Controls

**Files:**

- Modify: `src/modules/agent-room/components/AgentRoomView.tsx`
- Modify: `src/modules/agent-room/hooks/useAgentRoomRuntime.ts`
- Test: `tests/unit/components/agent-room-controls.test.tsx`
- Test: `tests/unit/components/agent-room-lifecycle-controls.test.tsx`

**Step 1: Write failing tests**

Cover:

- add persona unit
- send guidance (`session.steer`)
- force next phase
- abort/delete/force complete/export

**Step 2: Run tests**

```bash
pnpm vitest run tests/unit/components/agent-room-controls.test.tsx tests/unit/components/agent-room-lifecycle-controls.test.tsx
```

**Step 3: Implement**

- Implement controls with persisted backend updates.
- Keep explicit warning UX for force-complete.

**Step 4: Run tests**

```bash
pnpm vitest run tests/unit/components/agent-room-controls.test.tsx tests/unit/components/agent-room-lifecycle-controls.test.tsx
```

**Step 5: Commit**

```bash
git add src/modules/agent-room/components/AgentRoomView.tsx src/modules/agent-room/hooks/useAgentRoomRuntime.ts tests/unit/components/agent-room-controls.test.tsx tests/unit/components/agent-room-lifecycle-controls.test.tsx
git commit -m "feat(agent-room): add runtime and lifecycle controls"
```

---

### Task 14: Security Hardening (Validation + Limits + Abuse Guards)

**Files:**

- Modify: `src/server/gateway/methods/agent-v2.ts`
- Modify: `src/modules/agent-room/hooks/useAgentRoomRuntime.ts`
- Test: `tests/unit/gateway/agent-room-security.test.ts`

**Step 1: Write failing tests**

Cover:

- reject empty/oversized task or guidance payloads
- reject invalid persona IDs and malformed units JSON
- enforce user ownership on swarm/session operations

**Step 2: Run tests**

```bash
pnpm vitest run tests/unit/gateway/agent-room-security.test.ts
```

**Step 3: Implement**

- Add strict input guards and size caps.
- Return explicit domain errors.

**Step 4: Run tests**

```bash
pnpm vitest run tests/unit/gateway/agent-room-security.test.ts
```

**Step 5: Commit**

```bash
git add src/server/gateway/methods/agent-v2.ts src/modules/agent-room/hooks/useAgentRoomRuntime.ts tests/unit/gateway/agent-room-security.test.ts
git commit -m "hardening(agent-room): add validation and ownership guards"
```

---

### Task 15: Observability + Control-Plane Signals

**Files:**

- Modify: `src/server/gateway/events.ts`
- Modify: `src/server/gateway/broadcast.ts`
- Modify: `app/api/control-plane/metrics/route.ts`
- Modify: `src/shared/domain/types.ts`
- Test: `tests/integration/control-plane-metrics-route.test.ts`

**Step 1: Write failing tests**

Cover:

- metrics payload includes minimal Agent Room counters:
  - running swarms
  - swarms in hold
  - last swarm error timestamp

**Step 2: Run tests**

```bash
pnpm vitest run tests/integration/control-plane-metrics-route.test.ts
```

**Step 3: Implement**

- Emit and aggregate low-cost counters from persisted swarm rows.
- Keep backward compatibility for existing metrics consumers.

**Step 4: Run tests**

```bash
pnpm vitest run tests/integration/control-plane-metrics-route.test.ts
```

**Step 5: Commit**

```bash
git add src/server/gateway/events.ts src/server/gateway/broadcast.ts app/api/control-plane/metrics/route.ts src/shared/domain/types.ts tests/integration/control-plane-metrics-route.test.ts
git commit -m "feat(agent-room): add control-plane observability metrics"
```

---

### Task 16: Rollout Safety (Feature Flag + Kill Switch)

**Files:**

- Modify: `src/components/Sidebar.tsx`
- Modify: `src/modules/app-shell/components/AppShellViewContent.tsx`
- Modify: `src/server/gateway/methods/agent-v2.ts`
- Modify: `.env.local.example`
- Test: `tests/unit/components/agent-room-feature-flag.test.ts`

**Step 1: Write failing tests**

Cover:

- `NEXT_PUBLIC_AGENT_ROOM_ENABLED=false` hides UI entrypoint
- `AGENT_ROOM_ENABLED=false` rejects `agent.v2.swarm.*` with explicit error

**Step 2: Run tests**

```bash
pnpm vitest run tests/unit/components/agent-room-feature-flag.test.ts tests/unit/gateway/agent-v2-methods.test.ts
```

**Step 3: Implement**

- Add frontend and backend flag checks.
- Keep fast rollback path via env toggles.

**Step 4: Run tests**

```bash
pnpm vitest run tests/unit/components/agent-room-feature-flag.test.ts tests/unit/gateway/agent-v2-methods.test.ts
```

**Step 5: Commit**

```bash
git add src/components/Sidebar.tsx src/modules/app-shell/components/AppShellViewContent.tsx src/server/gateway/methods/agent-v2.ts .env.local.example tests/unit/components/agent-room-feature-flag.test.ts tests/unit/gateway/agent-v2-methods.test.ts
git commit -m "feat(agent-room): add rollout flag and server kill switch"
```

---

### Task 17: Runbook + Verification + Continuity

**Files:**

- Modify: `docs/AGENT_V2_RUNBOOK.md`
- Modify: `docs/plans/2026-02-24-agent-room-option-b-v2-implementation.md`
- Modify: `.agent/CONTINUITY.md`

**Step 1: Update docs**

Include:

- architecture and storage layout
- persona binding contract
- failure/recovery procedures
- feature flag rollout/rollback
- known limits (no multimodal, no Search/Maps, no legacy rooms)

**Step 2: Run verification**

```bash
pnpm vitest run tests/unit/components/agent-room-navigation.test.ts tests/unit/components/agent-room-view-routing.test.ts tests/unit/app-shell/agent-room-view-gating.test.ts tests/unit/agent-room/swarm-phases.test.ts tests/unit/agent-room/swarm-types.test.ts tests/unit/channels/agent-room-queries.test.ts tests/unit/gateway/agent-v2-methods.test.ts tests/unit/agent-v2/session-manager-persona.test.ts tests/unit/modules/agent-room/use-agent-room-runtime-contract.test.ts tests/unit/components/new-swarm-modal.test.tsx tests/unit/agent-room/swarm-sequencer.test.ts tests/unit/modules/agent-room/swarm-rehydrate.test.ts tests/unit/components/agent-room-layout-modes.test.tsx tests/unit/components/agent-room-output-tabs.test.tsx tests/unit/agent-room/logic-graph.test.ts tests/unit/agent-room/artifact-history.test.ts tests/unit/agent-room/conflict-radar.test.ts tests/unit/components/agent-room-controls.test.tsx tests/unit/components/agent-room-lifecycle-controls.test.tsx tests/unit/gateway/agent-room-security.test.ts tests/unit/components/agent-room-feature-flag.test.ts tests/integration/control-plane-metrics-route.test.ts
pnpm typecheck
pnpm lint
```

**Step 3: Commit**

```bash
git add docs/AGENT_V2_RUNBOOK.md .agent/CONTINUITY.md
git commit -m "docs(agent-room): finalize production-ready plan and runbook"
```

---

## Phase 2 (Deferred, Not In Current Scope)

- Workspace explorer + live preview iframe with strict workspace boundary checks.
- True parallel multi-session swarm execution (currently role-simulated phase flow over one active session per swarm deploy chain).
- Dedicated mission-board/registry/system mega-views.

---

Plan complete and saved to `docs/plans/2026-02-24-agent-room-option-b-v2-implementation.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
