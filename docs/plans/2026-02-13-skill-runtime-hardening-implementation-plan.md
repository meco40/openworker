# Skill Runtime Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the 4 priority improvements (path security, canonical tool contract, dynamic runtime registry, unified policy dispatcher) without regressing current strengths.

**Architecture:** Introduce a small runtime core for skills on the server side: `path guards` + `canonical tool naming` + `dynamic registry` + `policy gate`. Keep existing route auth, runtime-config UX, and ClawHub CLI behavior unchanged by adding characterization tests first and requiring non-regression checks after each task.

**Tech Stack:** TypeScript, Next.js API routes, Vitest, better-sqlite3, existing skill manifests/tool converters.

---

## Production Readiness Verdict

**Status vor dieser Revision:** Nicht vollständig production-ready.

**Fehlende kritische Punkte (nun in diesem Plan ergänzt):**
1. Klare Client/Server-Grenze für dynamische Tool-Registry (Browser darf keine Server-Registry direkt importieren).
2. Provider-Kompatibilitätsschicht als explizite Komponente (OpenAI/Gemini/Claude/Kimi/Grok).
3. Sicherheits-Härtung für externe Handler-Ausführung (Timeout, Ressourcenlimit, Isolationsstrategie, Kill-Switch).
4. Registry-Cache und Invalidation-Strategie (Install/Update/Uninstall ohne stale state).
5. Produktions-Rollout mit Canary, SLO-Monitoring, Runbook und klaren Go/No-Go-Kriterien.

---

## Non-Regression Guardrails (must stay green)

1. Auth gates on skill/clawhub routes must stay unchanged.
2. Runtime config UX and required-config gating must stay unchanged.
3. ClawHub CLI fallback behavior (`spawn EINVAL` -> `cmd.exe`) must stay unchanged.
4. Existing ClawHub and Skills tests must keep passing.

Verification command set (run at start and after each task touching these areas):

```bash
npm run test -- tests/integration/skills/runtime-config-route.test.ts
npm run test -- tests/unit/skills/skills-registry.test.ts
npm run test -- tests/unit/clawhub/clawhub-cli.test.ts
npm run test -- tests/integration/clawhub/clawhub-routes.test.ts
```

---

### Task 0: Architecture Contracts and Risk Controls (must be done first)

**Files:**
- Create: `docs/architecture/skills-runtime-contract.md`
- Create: `tests/contract/skills/skills-runtime-contract.test.ts`
- Modify: `docs/SKILLS_SYSTEM.md`

**Step 1: Write failing contract tests for architecture boundaries**

Add contract tests for:
- dynamic tool resolution for browser chat happens via API boundary, not direct server import.
- provider adapter interface returns provider-specific tool payloads from one canonical source.
- registry cache invalidation after install/update/uninstall events.

**Step 2: Run test to verify failure**

```bash
npm run test -- tests/contract/skills/skills-runtime-contract.test.ts
```

Expected: FAIL before contracts are introduced.

**Step 3: Define explicit architecture contract doc**

Document:
- canonical tool spec (internal),
- provider adapter contract (`toProviderTools(provider, canonicalTools)`),
- execution contract for tool handlers,
- cache invalidation triggers,
- client/server API boundaries.

**Step 4: Run test again**

```bash
npm run test -- tests/contract/skills/skills-runtime-contract.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add docs/architecture/skills-runtime-contract.md tests/contract/skills/skills-runtime-contract.test.ts docs/SKILLS_SYSTEM.md
git commit -m "docs+contract: define runtime architecture boundaries for skills"
```

---

### Task 1: Baseline Characterization for Current Good Behavior

**Files:**
- Create: `tests/integration/skills/skills-auth-guards.contract.test.ts`
- Create: `tests/unit/skills/non-regression-baseline.test.ts`
- Modify: `docs/SKILLS_SYSTEM.md`
- Test: `tests/integration/skills/runtime-config-route.test.ts`
- Test: `tests/unit/skills/skills-registry.test.ts`
- Test: `tests/unit/clawhub/clawhub-cli.test.ts`

**Step 1: Write failing auth characterization test**

Add tests for unauthenticated access returning `401` for:
- `GET /api/skills`
- `POST /api/skills`
- `POST /api/skills/execute`
- `GET/PUT/DELETE /api/skills/runtime-config`
- `GET/POST` ClawHub routes in the same style

**Step 2: Run test to verify failure (if assumptions mismatch)**

Run:

```bash
npm run test -- tests/integration/skills/skills-auth-guards.contract.test.ts
```

Expected: first run may fail due to missing test scaffolding/mocks.

**Step 3: Implement test scaffolding only**

Mirror mocking style from `tests/integration/clawhub/clawhub-routes.test.ts` and set `resolveRequestUserContext` to `null`.

**Step 4: Run targeted baseline suite**

Run:

```bash
npm run test -- tests/integration/skills/skills-auth-guards.contract.test.ts
npm run test -- tests/integration/skills/runtime-config-route.test.ts
npm run test -- tests/unit/skills/skills-registry.test.ts
npm run test -- tests/unit/clawhub/clawhub-cli.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tests/integration/skills/skills-auth-guards.contract.test.ts tests/unit/skills/non-regression-baseline.test.ts docs/SKILLS_SYSTEM.md
git commit -m "test: add non-regression characterization for auth and skill baseline"
```

---

### Task 2: Path Security Fix (P0)

**Files:**
- Create: `src/server/skills/pathGuards.ts`
- Create: `tests/unit/skills/path-guards.test.ts`
- Modify: `src/server/skills/handlers/fileRead.ts`
- Modify: `src/server/skills/handlers/dbQuery.ts`
- Test: `tests/unit/skills/path-guards.test.ts`

**Step 1: Write failing path guard test**

Add tests for:
- `D:\web\clawtest2\...` style prefix collision must be rejected.
- `..\` traversal must be rejected.
- in-root relative path must pass.

**Step 2: Run test to verify it fails**

```bash
npm run test -- tests/unit/skills/path-guards.test.ts
```

Expected: FAIL because helper does not exist.

**Step 3: Add minimal path guard utility**

Create `resolveWorkspacePathOrThrow(workspaceRoot, userPath)` using:
- `path.resolve` + `path.relative`
- reject when relative is empty? no (root file allowed)
- reject when relative starts with `..` or is absolute
- optional `fs.realpathSync.native` for symlink-hardening (behind safe try/catch)

**Step 4: Replace duplicated `ensureWorkspacePath` in handlers**

Update:
- `src/server/skills/handlers/fileRead.ts`
- `src/server/skills/handlers/dbQuery.ts`

Only swap path resolution logic; keep runtime behavior/messages unchanged.

**Step 5: Run tests**

```bash
npm run test -- tests/unit/skills/path-guards.test.ts
npm run test -- tests/integration/skills/runtime-config-route.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/server/skills/pathGuards.ts src/server/skills/handlers/fileRead.ts src/server/skills/handlers/dbQuery.ts tests/unit/skills/path-guards.test.ts
git commit -m "fix: harden workspace path validation for skill handlers"
```

---

### Task 3: Canonical Tool Contract and Name Unification (P1)

**Files:**
- Create: `src/shared/toolContract.ts`
- Create: `tests/unit/skills/tool-contract.test.ts`
- Modify: `src/server/worker/workerExecutor.ts`
- Modify: `skills/browser/index.ts`
- Modify: `skills/filesystem/index.ts`
- Modify: `skills/python-runtime/index.ts`
- Modify: `skills/shell-access/index.ts`
- Modify: `skills/sql-bridge/index.ts`
- Modify: `skills/vision/index.ts`
- Modify: `skills/github-manager/index.ts`

**Step 1: Write failing contract test**

Add tests asserting:
- canonical names include `browser_snapshot`, `file_read`, `shell_execute`, `python_execute`, `db_query`, `github_query`, `vision_analyze`.
- legacy aliases map to canonical (`browser_fetch` -> `browser_snapshot`, `search_web` -> provider built-in path or explicit no-op mapping).

**Step 2: Run test to verify failure**

```bash
npm run test -- tests/unit/skills/tool-contract.test.ts
```

Expected: FAIL because contract file does not exist.

**Step 3: Implement canonical contract**

Create `toolContract.ts` with:
- `CANONICAL_TOOL_NAMES`
- `LEGACY_TOOL_ALIASES`
- helper `normalizeToolName(name: string): string`

**Step 4: Update worker tool definitions**

`workerExecutor.ts`:
- replace `browser_fetch` with canonical `browser_snapshot`
- replace `search_web` usage with canonical strategy:
  - either built-in search adapter call, or
  - explicit internal tool name `web_search_fallback` with alias mapping and clear documentation
- keep backward compatibility by accepting aliases in dispatcher via `normalizeToolName`.

**Step 5: Run tests**

```bash
npm run test -- tests/unit/skills/tool-contract.test.ts
npm run test -- tests/unit/worker/worker-executor-clawhub-prompt.test.ts
npm run test -- tests/skills-definitions.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/shared/toolContract.ts src/server/worker/workerExecutor.ts tests/unit/skills/tool-contract.test.ts skills/browser/index.ts skills/filesystem/index.ts skills/python-runtime/index.ts skills/shell-access/index.ts skills/sql-bridge/index.ts skills/vision/index.ts skills/github-manager/index.ts
git commit -m "refactor: introduce canonical tool contract and align worker tool names"
```

---

### Task 4: Dynamic Runtime Registry for Built-in + External Skills (P2)

**Files:**
- Create: `src/server/skills/runtimeRegistry.ts`
- Create: `src/server/skills/externalSkillLoader.ts`
- Create: `src/server/skills/providerAdapters.ts`
- Create: `app/api/skills/tools/route.ts`
- Create: `skills/runtime-tools-client.ts`
- Create: `tests/unit/skills/runtime-registry.test.ts`
- Create: `tests/integration/skills/external-skill-runtime.test.ts`
- Create: `tests/integration/skills/tools-route.test.ts`
- Modify: `skills/definitions.ts`
- Modify: `skills/execute.ts`
- Modify: `app/api/skills/route.ts`
- Modify: `app/api/skills/[id]/route.ts`
- Modify: `src/server/skills/executeSkill.ts`
- Modify: `src/server/rooms/toolExecutor.ts`
- Modify: `src/modules/app-shell/useAgentRuntime.ts`

**Step 1: Write failing registry tests**

Cover:
- built-ins are resolved dynamically.
- DB-installed external skill with `handlerPath` becomes executable.
- missing/invalid handler returns structured error, does not crash registry.
- name conflict detection (external cannot shadow canonical core tool unless explicit override flag).

**Step 2: Run test to verify failure**

```bash
npm run test -- tests/unit/skills/runtime-registry.test.ts
```

Expected: FAIL because registry does not exist.

**Step 3: Implement minimal runtime registry**

`runtimeRegistry.ts`:
- load built-ins from existing manifests.
- load DB skills from `getSkillRepository()`.
- merge + validate + convert with `convertTools`.
- add in-memory cache with version token and explicit invalidation method.

`externalSkillLoader.ts`:
- load handler module from `handlerPath` under workspace constraints.
- require exported `execute(args)` (or configurable symbol).
- return typed `SkillExecutor`.

`providerAdapters.ts`:
- canonical -> provider transformation for current providers.
- normalize provider/tool quirks in one place.
- explicit extension point for additional providers (e.g. Kimi, Grok).

**Step 4: Wire registry into existing call sites**

Replace static maps in:
- `skills/definitions.ts` delegates to new `/api/skills/tools` client when in browser context.
- `skills/execute.ts` uses environment split:
  - browser path -> existing API execution (`/api/skills/execute`),
  - server path -> runtime registry executor.
- `app/api/skills/route.ts` + `app/api/skills/[id]/route.ts` invalidate runtime registry cache after install/update/delete.
- `src/server/skills/executeSkill.ts` (`dispatchSkill` uses registry)
- keep route contracts unchanged.
- add `GET /api/skills/tools?provider=...` for client runtime tool hydration.

**Step 5: Run tests**

```bash
npm run test -- tests/unit/skills/runtime-registry.test.ts
npm run test -- tests/integration/skills/external-skill-runtime.test.ts
npm run test -- tests/integration/skills/tools-route.test.ts
npm run test -- tests/skills-definitions.test.ts
npm run test -- tests/integration/skills/execute-router.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/server/skills/runtimeRegistry.ts src/server/skills/externalSkillLoader.ts src/server/skills/providerAdapters.ts app/api/skills/tools/route.ts app/api/skills/route.ts app/api/skills/[id]/route.ts skills/runtime-tools-client.ts skills/definitions.ts skills/execute.ts src/server/skills/executeSkill.ts src/server/rooms/toolExecutor.ts src/modules/app-shell/useAgentRuntime.ts tests/unit/skills/runtime-registry.test.ts tests/integration/skills/external-skill-runtime.test.ts tests/integration/skills/tools-route.test.ts
git commit -m "feat: add dynamic skill runtime registry with external handler execution"
```

---

### Task 5: Unified Security/Policy Dispatcher (P3)

**Files:**
- Create: `src/server/skills/policy.ts`
- Create: `src/server/skills/policyTypes.ts`
- Create: `tests/unit/skills/policy.test.ts`
- Modify: `src/server/skills/executeSkill.ts`
- Modify: `src/server/rooms/toolExecutor.ts`
- Modify: `src/server/worker/workerExecutor.ts`
- Modify: `src/server/skills/handlers/shellExecute.ts`

**Step 1: Write failing policy tests**

Cover:
- default deny for unknown tool.
- allow by context (chat/room/worker) + persona permissions.
- shell commands requiring approval route through one policy decision point.
- structured policy decision output (`allow`, `reason`, `requiresApproval`).

**Step 2: Run test to verify failure**

```bash
npm run test -- tests/unit/skills/policy.test.ts
```

Expected: FAIL because policy module does not exist.

**Step 3: Implement policy core**

`policy.ts`:
- `evaluateToolCall({ context, toolName, args, actor, permissions })`
- centralize deny/allow/approval logic.
- keep existing behavior parity first (do not broaden permissions).

**Step 4: Integrate policy in all dispatch paths**

Apply before execution in:
- API skill execution path.
- Rooms tool execution path.
- Worker tool dispatch path.

Keep existing worker approval flow, but trigger it through policy output to avoid duplicated command checks.

**Step 5: Run tests**

```bash
npm run test -- tests/unit/skills/policy.test.ts
npm run test -- tests/integration/rooms/rooms-runtime.test.ts
npm run test -- tests/unit/worker/worker-state-machine.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/server/skills/policy.ts src/server/skills/policyTypes.ts src/server/skills/executeSkill.ts src/server/rooms/toolExecutor.ts src/server/worker/workerExecutor.ts src/server/skills/handlers/shellExecute.ts tests/unit/skills/policy.test.ts
git commit -m "refactor: unify tool execution policy and approval decisions"
```

---

### Task 6: External Handler Execution Hardening (production safety gate)

**Files:**
- Create: `src/server/skills/executionSandbox.ts`
- Create: `tests/unit/skills/execution-sandbox.test.ts`
- Modify: `src/server/skills/externalSkillLoader.ts`
- Modify: `src/server/skills/runtimeRegistry.ts`
- Modify: `src/logging/logService.ts`

**Step 1: Write failing sandbox tests**

Cover:
- timeout enforcement on external handlers.
- max payload size / output size guard.
- cancellation support via abort signal.
- structured failure response (no raw stack leakage to clients).

**Step 2: Run test to verify failure**

```bash
npm run test -- tests/unit/skills/execution-sandbox.test.ts
```

Expected: FAIL before sandbox exists.

**Step 3: Implement execution sandbox wrapper**

Add wrapper around external handler execution with:
- timeout budget per tool,
- output truncation and size caps,
- panic/fault isolation path,
- consistent error codes.
- trusted-source controls:
  - optional allowlist for external skill sources/packages,
  - optional hash pinning for downloaded handlers,
  - explicit deny path with clear error code if trust policy fails.

**Step 4: Add structured observability**

Emit log events for:
- `skills.tool_call.started`
- `skills.tool_call.completed`
- `skills.tool_call.failed`
- include provider/model/tool/context/duration/error_code.

**Step 5: Run tests**

```bash
npm run test -- tests/unit/skills/execution-sandbox.test.ts
npm run test -- tests/unit/skills/policy.test.ts
npm run test -- tests/integration/skills/execute-router.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/server/skills/executionSandbox.ts src/server/skills/externalSkillLoader.ts src/server/skills/runtimeRegistry.ts src/logging/logService.ts tests/unit/skills/execution-sandbox.test.ts
git commit -m "feat: harden external skill execution with sandbox guards and telemetry"
```

---

### Task 7: Final Regression, Docs, and Rollout Safety

**Files:**
- Modify: `docs/SKILLS_SYSTEM.md`
- Modify: `docs/plans/2026-02-13-openclaw-tooling-transfer-review.md`
- Create: `docs/architecture/skills-runtime-registry.md`
- Create: `docs/runbooks/skills-runtime-production-rollout.md`

**Step 1: Add migration notes**

Document:
- canonical tool naming and aliases
- external handler loading contract
- policy decision flow
- what remained intentionally unchanged (auth routes, runtime config UX, ClawHub CLI fallback)

**Step 2: Run full targeted suite**

```bash
npm run test -- tests/unit/skills/path-guards.test.ts tests/unit/skills/tool-contract.test.ts tests/unit/skills/runtime-registry.test.ts tests/unit/skills/policy.test.ts
npm run test -- tests/integration/skills/execute-router.test.ts tests/integration/skills/runtime-config-route.test.ts tests/integration/clawhub/clawhub-routes.test.ts
npm run test -- tests/unit/clawhub/clawhub-cli.test.ts tests/unit/skills/skills-registry.test.ts tests/skills-definitions.test.ts
npm run test -- tests/integration/skills/tools-route.test.ts tests/unit/skills/execution-sandbox.test.ts tests/contract/skills/skills-runtime-contract.test.ts
```

Expected: PASS.

**Step 3: Run type/lint checks**

```bash
npm run typecheck
npm run lint
```

Expected: PASS.

**Step 4: Commit**

```bash
git add docs/SKILLS_SYSTEM.md docs/plans/2026-02-13-openclaw-tooling-transfer-review.md docs/architecture/skills-runtime-registry.md docs/runbooks/skills-runtime-production-rollout.md
git commit -m "docs: add skill runtime registry and policy architecture notes"
```

---

## Rollout Strategy (no regression in production behavior)

1. Ship `P0` and `P1` first behind zero-feature flags (safe refactors).
2. Ship `P2` behind `SKILLS_DYNAMIC_REGISTRY=1`; keep static path as fallback for one release.
3. Ship `P3` in observe mode first (`policy logs only`), then enforce mode.
4. Ship sandbox hardening with `SKILLS_EXTERNAL_EXEC_SANDBOX=1` (staging -> canary -> full rollout).
5. Canary rollout: 10% traffic for 30 minutes; monitor error rate, timeout rate, p95 tool latency.
6. Rollback order:
   - disable `SKILLS_EXTERNAL_EXEC_SANDBOX`,
   - disable `SKILLS_DYNAMIC_REGISTRY`,
   - redeploy previous build.
7. Remove fallback paths only after one stable release cycle.

## Go/No-Go Production Checklist

Go only if all are true:
1. Regression suite green for auth/runtime-config/clawhub/tooling.
2. Contract tests green for provider adapter and client/server boundary.
3. No increase >10% in tool failure rate during canary.
4. No new P1/P0 security findings in external skill execution path.
5. Runbook for incidents and rollback is published and reviewed.
6. External skill trust policy (allowlist/hash mode) is configured for production environment.

## Success Criteria

1. External GitHub/npm skills are executable through the same runtime as built-ins.
2. No path traversal/prefix-collision bypass for workspace-scoped tools.
3. Chat/Rooms/Worker call the same canonical tools (aliases only for compatibility).
4. Provider-specific tool payloads are produced via one adapter layer from canonical definitions.
5. External handler execution is bounded (timeout/size/error-code discipline).
6. Runtime registry cache is invalidated correctly after install/toggle/delete operations.
7. Existing strong behaviors remain intact:
   - route auth still enforced,
   - runtime config UX unchanged,
   - ClawHub CLI fallback unchanged,
   - existing tests stay green.
