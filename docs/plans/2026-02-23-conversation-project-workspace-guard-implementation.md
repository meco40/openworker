# Conversation-Scoped Project Workspace Guard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Introduce explicit `/project` orchestration so project workspaces are user-controlled, conversation-scoped, persona-isolated, and enforced by a hybrid approval guard when no project is active.

**Architecture:** Persist projects as first-class records linked to personas, persist active project state per conversation, and route all tool execution through the conversation's active project workspace. Add a server-side "no active project" guard for code/build intents that emits existing approval metadata for WebUI and supports text confirmation for Telegram.

**Tech Stack:** Next.js API routes, MessageService runtime, SQLite repositories/migrations, Vitest, existing gateway approval flow (`chat.approval.respond`).

---

### Task 1: Add `/project` Command Routing

**Files:**

- Modify: `src/server/channels/messages/messageRouter.ts`
- Modify: `tests/messageRouter.test.ts`

**Step 1: Write failing router tests**

Add RED cases in `tests/messageRouter.test.ts`:

- `/project new Notes` routes to `project-command`
- `/project list` routes to `project-command`
- `/project use notes` routes to `project-command`
- `/project status` routes to `project-command`

**Step 2: Run test to verify failure**

Run:

```bash
pnpm vitest run tests/messageRouter.test.ts
```

Expected: FAIL because `RouteResult.target` does not yet include `project-command`.

**Step 3: Implement minimal routing**

Update `src/server/channels/messages/messageRouter.ts`:

- Extend `RouteResult.target` union with `project-command`.
- Parse `/project` prefix and route payload.

**Step 4: Run test to verify pass**

Run:

```bash
pnpm vitest run tests/messageRouter.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/channels/messages/messageRouter.ts tests/messageRouter.test.ts
git commit -m "feat(chat): route /project commands in message router"
```

### Task 2: Persist Projects And Conversation Project State

**Files:**

- Modify: `src/server/channels/messages/repository/migrations/index.ts`
- Modify: `src/server/channels/messages/repository/types.ts`
- Modify: `src/server/channels/messages/repository.ts`
- Modify: `src/server/channels/messages/messageRowMappers.ts`
- Modify: `src/shared/domain/types.ts`
- Modify: `src/server/channels/messages/sqliteMessageRepository.ts`
- Create: `src/server/channels/messages/repository/queries/projects.ts`
- Test: `tests/unit/channels/project-repository.test.ts`

**Step 1: Write failing repository tests**

Create `tests/unit/channels/project-repository.test.ts` for:

- create/list persona-scoped projects
- set/get active project for conversation
- reset guard approval on project switch
- reject cross-persona `use`

**Step 2: Run test to verify failure**

Run:

```bash
pnpm vitest run tests/unit/channels/project-repository.test.ts
```

Expected: FAIL due to missing tables/repository methods.

**Step 3: Implement schema and query module**

In migrations add:

- `conversation_projects` table
- `persona_projects` table + indexes

In `queries/projects.ts` implement:

- `createProject`
- `listProjectsByPersona`
- `getProjectByIdOrSlug`
- `setActiveProjectForConversation`
- `getConversationProjectState`
- `clearActiveProjectForConversation`
- `markGuardApprovedWithoutProject`

Wire methods through repository interfaces and `SqliteMessageRepository`.

**Step 4: Run test to verify pass**

Run:

```bash
pnpm vitest run tests/unit/channels/project-repository.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/channels/messages/repository/migrations/index.ts src/server/channels/messages/repository/queries/projects.ts src/server/channels/messages/repository/types.ts src/server/channels/messages/repository.ts src/server/channels/messages/messageRowMappers.ts src/shared/domain/types.ts src/server/channels/messages/sqliteMessageRepository.ts tests/unit/channels/project-repository.test.ts
git commit -m "feat(projects): persist persona projects and conversation active project state"
```

### Task 3: Project Workspace Service As Explicit Command-Only Creator

**Files:**

- Modify: `src/server/personas/personaProjectWorkspace.ts`
- Test: `tests/unit/personas/persona-project-workspace.test.ts`

**Step 1: Write failing tests for explicit project creation contract**

Add RED cases:

- create from explicit name and persona slug
- deterministic metadata for command handler consumption
- no implicit creation APIs for non-command paths

**Step 2: Run test to verify failure**

Run:

```bash
pnpm vitest run tests/unit/personas/persona-project-workspace.test.ts
```

Expected: FAIL where API shape mismatches explicit command needs.

**Step 3: Implement minimal service refinements**

Adjust API signatures for command-driven flow:

- `createPersonaProjectWorkspace({ personaSlug, task, requestedName })`
- return stable `projectId`, `projectSlug`, `absolutePath`, `relativePath`, `createdAt`

**Step 4: Run test to verify pass**

Run:

```bash
pnpm vitest run tests/unit/personas/persona-project-workspace.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/personas/personaProjectWorkspace.ts tests/unit/personas/persona-project-workspace.test.ts
git commit -m "refactor(projects): harden persona project workspace service for explicit command flow"
```

### Task 4: Implement `/project` Command Handler In MessageService

**Files:**

- Modify: `src/server/channels/messages/service/commandHandlers.ts`
- Modify: `src/server/channels/messages/service/index.ts`
- Test: `tests/unit/channels/message-service-project-command.test.ts`

**Step 1: Write failing command-handler tests**

Create `tests/unit/channels/message-service-project-command.test.ts` for:

- `/project new Notes` creates project, sets active project, returns status
- `/project list` returns persona-only projects
- `/project use <id|slug>` switches active project
- `/project status` shows active/none
- reject when no active persona in conversation

**Step 2: Run test to verify failure**

Run:

```bash
pnpm vitest run tests/unit/channels/message-service-project-command.test.ts
```

Expected: FAIL because handler and route target integration missing.

**Step 3: Implement minimal command handler**

In `commandHandlers.ts` add `handleProjectCommand`.
In `service/index.ts` route `project-command` to this handler.

Handler rules:

- enforce persona-bound project access
- set active project immediately on `/project new`
- clear `guard_approved_without_project` when project becomes active

**Step 4: Run test to verify pass**

Run:

```bash
pnpm vitest run tests/unit/channels/message-service-project-command.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/channels/messages/service/commandHandlers.ts src/server/channels/messages/service/index.ts tests/unit/channels/message-service-project-command.test.ts
git commit -m "feat(projects): add /project command lifecycle to message service"
```

### Task 5: Remove Implicit Subagent Project Creation And Reuse Active Project

**Files:**

- Modify: `src/server/channels/messages/service/subagentManager.ts`
- Modify: `src/server/agents/subagentRegistry.ts`
- Modify: `tests/unit/channels/message-service-subagents.test.ts`

**Step 1: Write failing tests for new subagent behavior**

RED expectations:

- subagent spawn without active project does not auto-create a project
- subagent spawn with active project inherits `workspacePath` from conversation project state

**Step 2: Run test to verify failure**

Run:

```bash
pnpm vitest run tests/unit/channels/message-service-subagents.test.ts
```

Expected: FAIL due to current implicit folder creation.

**Step 3: Implement minimal behavior change**

Remove implicit `createPersonaProjectWorkspace` call from subagent spawn.
Pass active project workspace only when already set for conversation.

**Step 4: Run test to verify pass**

Run:

```bash
pnpm vitest run tests/unit/channels/message-service-subagents.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/channels/messages/service/subagentManager.ts src/server/agents/subagentRegistry.ts tests/unit/channels/message-service-subagents.test.ts
git commit -m "fix(subagents): stop implicit project creation and inherit active project workspace"
```

### Task 6: Add Conversation-Level No-Project Guard With Approval Metadata

**Files:**

- Modify: `src/server/channels/messages/service/index.ts`
- Modify: `src/server/channels/messages/service/types.ts`
- Create: `src/server/channels/messages/service/projectGuard.ts`
- Test: `tests/unit/channels/message-service-project-guard.test.ts`

**Step 1: Write failing guard tests**

Create guard tests:

- build intent + no active project + no prior approval => approval_required response
- non-build message bypasses guard
- approval flag allows subsequent build message in same conversation
- switching/setting active project resets guard-approved-without-project

**Step 2: Run test to verify failure**

Run:

```bash
pnpm vitest run tests/unit/channels/message-service-project-guard.test.ts
```

Expected: FAIL because guard layer is not implemented.

**Step 3: Implement minimal guard**

Implement `projectGuard.ts`:

- `isProjectRequiredIntent(content)`
- `buildGuardPrompt(lastProjects)`

Integrate in `MessageService.handleInbound` before AI dispatch.
Emit approval metadata compatible with existing UI parser:

- `status: "approval_required"`
- `approvalToken`
- `approvalPrompt`
- `approvalToolFunction: "project_workspace_guard"`

**Step 4: Run test to verify pass**

Run:

```bash
pnpm vitest run tests/unit/channels/message-service-project-guard.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/channels/messages/service/index.ts src/server/channels/messages/service/types.ts src/server/channels/messages/service/projectGuard.ts tests/unit/channels/message-service-project-guard.test.ts
git commit -m "feat(project-guard): require approval for build intents without active project"
```

### Task 7: Hybrid Approvals (WebUI + Telegram Text Confirm)

**Files:**

- Modify: `src/server/channels/messages/service/approval/handler.ts`
- Modify: `src/server/channels/messages/service/toolManager.ts`
- Modify: `src/server/channels/messages/messageRouter.ts`
- Modify: `src/server/channels/messages/service/commandHandlers.ts`
- Modify: `tests/messageRouter.test.ts`
- Create: `tests/unit/channels/message-service-project-approval-command.test.ts`

**Step 1: Write failing tests**

Add RED tests for:

- `/approve <token>` and `/deny <token>` routing/handling
- `respondToolApproval` accepting `project_workspace_guard` pending token
- guard approval updates conversation state and resumes next request path

**Step 2: Run tests to verify failure**

Run:

```bash
pnpm vitest run tests/messageRouter.test.ts tests/unit/channels/message-service-project-approval-command.test.ts tests/unit/channels/message-service-tool-approval.test.ts
```

Expected: FAIL due to missing approval command path for project guard.

**Step 3: Implement minimal hybrid approval support**

- Add `approval-command` route target for `/approve` and `/deny`.
- Add command handler to call existing approval responder.
- Extend approval storage/dispatch so `project_workspace_guard` tokens are validated and processed.

**Step 4: Run tests to verify pass**

Run:

```bash
pnpm vitest run tests/messageRouter.test.ts tests/unit/channels/message-service-project-approval-command.test.ts tests/unit/channels/message-service-tool-approval.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/channels/messages/messageRouter.ts src/server/channels/messages/service/commandHandlers.ts src/server/channels/messages/service/approval/handler.ts src/server/channels/messages/service/toolManager.ts tests/messageRouter.test.ts tests/unit/channels/message-service-project-approval-command.test.ts
git commit -m "feat(approval): support project guard approvals via ui and /approve commands"
```

### Task 8: Route Main-Agent Tool Execution To Active Project Workspace

**Files:**

- Modify: `src/server/channels/messages/service/dispatchers/aiDispatcher.ts`
- Modify: `src/server/channels/messages/service/commandHandlers.ts`
- Modify: `src/server/channels/messages/service/index.ts`
- Modify: `src/server/channels/messages/service/approval/handler.ts`
- Modify: `src/server/skills/types.ts`
- Modify: `src/server/skills/handlers/executionCwd.ts`
- Modify: `src/server/skills/handlers/shellExecute.ts`
- Modify: `src/server/skills/handlers/pythonExecute.ts`
- Create: `tests/unit/channels/message-service-project-workspace-cwd.test.ts`

**Step 1: Write failing runtime tests**

Create tests that verify:

- main AI tool call uses active project `workspaceCwd`
- `/shell` command uses active project `workspaceCwd`
- approval replay path also uses active project `workspaceCwd`

**Step 2: Run test to verify failure**

Run:

```bash
pnpm vitest run tests/unit/channels/message-service-project-workspace-cwd.test.ts tests/unit/channels/message-service-shell-command.test.ts tests/unit/skills/shell-execute-security.test.ts
```

Expected: FAIL where context does not carry active project workspace.

**Step 3: Implement minimal wiring**

Resolve active project workspace in `MessageService` and pass `workspaceCwd` to:

- direct shell execution
- AI tool loop
- approval replay
- inferred shell flow

Keep `executionCwd` guard strict to persona root.

**Step 4: Run test to verify pass**

Run:

```bash
pnpm vitest run tests/unit/channels/message-service-project-workspace-cwd.test.ts tests/unit/channels/message-service-shell-command.test.ts tests/unit/skills/shell-execute-security.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/channels/messages/service/dispatchers/aiDispatcher.ts src/server/channels/messages/service/commandHandlers.ts src/server/channels/messages/service/index.ts src/server/channels/messages/service/approval/handler.ts src/server/skills/types.ts src/server/skills/handlers/executionCwd.ts src/server/skills/handlers/shellExecute.ts src/server/skills/handlers/pythonExecute.ts tests/unit/channels/message-service-project-workspace-cwd.test.ts
git commit -m "feat(workspace): enforce active conversation project cwd across tool execution paths"
```

### Task 9: End-To-End Verification And Documentation

**Files:**

- Create: `docs/PROJECT_WORKSPACE_SYSTEM.md`
- Modify: `.agent/CONTINUITY.md`
- Modify: `docs/WORKER_ORCHESTRA_SYSTEM.md` (cross-link only)

**Step 1: Write documentation first draft**

Document:

- `/project` command contract
- conversation-scoped active project model
- guard and approval lifecycle
- Telegram/WebUI confirmation behavior

**Step 2: Run full targeted verification**

Run:

```bash
pnpm vitest run tests/messageRouter.test.ts tests/unit/channels/project-repository.test.ts tests/unit/channels/message-service-project-command.test.ts tests/unit/channels/message-service-project-guard.test.ts tests/unit/channels/message-service-project-approval-command.test.ts tests/unit/channels/message-service-project-workspace-cwd.test.ts tests/unit/channels/message-service-subagents.test.ts tests/unit/channels/message-service-tool-approval.test.ts tests/unit/skills/shell-execute-security.test.ts tests/unit/personas/persona-project-workspace.test.ts
pnpm typecheck
pnpm lint
```

Expected:

- all targeted tests pass
- typecheck pass
- lint passes with only pre-existing warnings (if unchanged baseline)

**Step 3: Commit**

```bash
git add docs/PROJECT_WORKSPACE_SYSTEM.md docs/WORKER_ORCHESTRA_SYSTEM.md .agent/CONTINUITY.md
git commit -m "docs(projects): document conversation-scoped project workflow and guard approvals"
```

---

Plan complete and saved to `docs/plans/2026-02-23-conversation-project-workspace-guard-implementation.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
