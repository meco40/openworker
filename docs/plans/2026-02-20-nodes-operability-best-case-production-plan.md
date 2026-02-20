# Nodes Operability Best-Case Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade the `Nodes` page from read-only diagnostics to a production-ready operability console with safe actions for exec approvals, channel bindings, and channel lifecycle controls.

**Architecture:** Extend `GET /api/ops/nodes` into a full read model (diagnostics + channels + personas + exec approvals + telegram pending pairing), then add bounded authenticated mutation actions via `POST /api/ops/nodes`. Wire new actions into `useOpsNodes` + `NodesView` with explicit pending/error states and confirmation guards for destructive operations.

**Tech Stack:** Next.js App Router, React 19, TypeScript, existing channel pairing/runtime services, exec approval manager, Vitest integration/unit tests.

---

## Production Readiness Review (Before Implementation)

- Auth boundary: all mutations must enforce `resolveRequestUserContext` (401 otherwise).
- Scope safety: all channel binding mutations must be user-scoped (`userId` from context).
- Destructive actions: require confirm UX for `disconnect`, `clear approvals`, and `reject telegram pairing`.
- Input hardening: validate channel enum, command strings, and bounded limits.
- Response contract: route returns stable typed payload so UI has no hidden coupling.
- Failure handling: route-level `ok:false,error`, UI-level error banner + disabled controls.
- Performance: keep list limits bounded (`channels` <= 200, approvals list no unbounded scans).
- Test gates: integration tests for route behavior + unit tests for nodes screen operability sections.

Decision: scope is complete for this repo’s current capabilities and can ship without depending on missing external node/device backends.

---

### Task 1: Define failing contract tests for nodes operability

**Files:**

- Modify: `tests/integration/ops/ops-routes.test.ts`
- Modify: `tests/unit/components/ops-nodes-view.test.ts`

**Step 1: Write failing integration tests**

- Add assertions that `GET /api/ops/nodes` includes:
  - `nodes.execApprovals` list metadata.
  - `nodes.personas` for binding selection.
  - channel capabilities fields for controls.
  - telegram pending pairing snapshot.
- Add failing tests for `POST /api/ops/nodes` actions:
  - `exec.approve`, `exec.revoke`, `exec.clear`.
  - `bindings.setPersona`.
  - `channels.connect`, `channels.disconnect`, `channels.rotateSecret`.
  - `telegram.rejectPending`.

**Step 2: Run tests to verify red**
Run: `npm test -- tests/integration/ops/ops-routes.test.ts tests/unit/components/ops-nodes-view.test.ts`
Expected: FAIL due missing payload fields/actions.

---

### Task 2: Implement backend read model + mutations

**Files:**

- Modify: `src/modules/ops/types.ts`
- Modify: `app/api/ops/nodes/route.ts`
- Modify: `src/server/channels/pairing/telegramCodePairing.ts`

**Step 1: Implement typed payload extensions**

- Add ops-node types for:
  - channel capabilities + accounts.
  - personas list.
  - exec approvals list + count.
  - telegram pending pairing.

**Step 2: Implement GET aggregation**

- Enrich channels to include all known channel capabilities (not only existing bindings).
- Include personas list from persona repository.
- Include `listApprovedCommands()` snapshot.
- Include telegram pairing pending state helper.

**Step 3: Implement POST action dispatcher with validation**

- Supported actions:
  - `exec.approve`, `exec.revoke`, `exec.clear`
  - `bindings.setPersona`
  - `channels.connect`, `channels.disconnect`, `channels.rotateSecret`
  - `telegram.rejectPending`
- Add strict validation and explicit error messages.
- Return updated read model after mutation for optimistic UI reset.

**Step 4: Re-run integration tests**
Run: `npm test -- tests/integration/ops/ops-routes.test.ts`
Expected: PASS.

---

### Task 3: Implement frontend operability UI + hook actions

**Files:**

- Modify: `src/modules/ops/hooks/useOpsNodes.ts`
- Modify: `src/modules/ops/components/NodesView.tsx`
- Modify: `tests/unit/components/ops-nodes-view.test.ts`

**Step 1: Extend hook state and actions**

- Add pending action state + mutation helper.
- Add methods for each backend action (`approve`, `revoke`, `clear`, `bind persona`, `connect`, `disconnect`, `rotate secret`, `reject pending`).
- Keep `refresh` behavior and stale-safe state updates.

**Step 2: Build operator-focused Nodes UI sections**

- Keep existing diagnostics cards/table.
- Add `Exec Approvals` section with create/revoke/clear controls.
- Add `Channel Controls` section with per-channel connect/disconnect/rotate + persona binding.
- Add `Telegram Pending Pairing` section with reject action.

**Step 3: Re-run unit tests**
Run: `npm test -- tests/unit/components/ops-nodes-view.test.ts`
Expected: PASS.

---

### Task 4: Verification and readiness gate

**Files:**

- Modify as needed for fixes.

**Step 1: Run focused suites**
Run: `npm test -- tests/integration/ops/ops-routes.test.ts tests/unit/components/ops-nodes-view.test.ts`
Expected: PASS.

**Step 2: Typecheck gate**
Run: `npm run typecheck`
Expected: PASS.

**Step 3: Manual production checklist**

- Confirm Nodes page supports read + mutate flows without full page reload.
- Confirm unauthorized requests are rejected.
- Confirm destructive actions require explicit user intent.
- Confirm no regression in existing nodes diagnostics.
