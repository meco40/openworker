# Project Workspace System

## Metadata

- Purpose: Define the conversation-scoped project workspace workflow for persona-driven build tasks and Master Agent isolation.
- Scope: `/project` lifecycle, no-project guard approvals, workspace cwd propagation for tool execution, Master-Workspace-Isolation.
- Last Reviewed: 2026-03-03

---

## 1. Core Model

Project state is split into two levels:

- Persona projects (`persona_projects`):
  - Long-lived project records per user+persona (`id`, `slug`, `workspace_path`).
- Conversation project state (`conversation_project_state`):
  - Current active project per conversation.
  - `guard_approved_without_project` flag for temporary no-project approval.

This enables:

- Strict persona isolation for projects.
- Conversation-specific active project (important when a user switches channels/devices).

### 1.1 Master-Workspace-Isolation

Der Master Agent verwendet eine erweiterte Workspace-Isolation:

- **Scope-Auflösung**: `resolveMasterWorkspaceScope` kanonisiert auf `persona:<personaId>:<workspaceId>`
- **Workspace-Cwd**: Wird auf Persona-Root begrenzt (`PERSONAS_ROOT_PATH/<persona-slug>`)
- **Isolation-Gate**: Jede Master-Action validiert den Workspace-Scope vor Ausfuehrung
- **Task-Bindung**: Tasks erben den Master-Workspace-Scope bei der Erstellung

```typescript
// Scope-Auflösung für Master Actions
const scope = resolveMasterWorkspaceScope({
  personaId: 'persona_123',
  workspaceId: 'ws_456',
});
// Ergebnis: 'persona:persona_123:ws_456'
```

Vorteile:

- Strikte Isolation zwischen Persona-Workspaces
- Verhindert unbeabsichtigten Zugriff auf fremde Projekte
- Ermöglicht sichere Multi-User-Umgebungen

---

## 2. User Commands

### 2.1 Project lifecycle

- `/project new <name>`
  - Creates workspace under persona projects root.
  - Persists project record.
  - Sets project active for the current conversation.
- `/project list`
  - Lists projects for the current persona only.
- `/project use <id|slug|index>`
  - Activates an existing project for the current conversation.
- `/project delete <id|slug|index>`
  - Deletes project record and recursively removes the project workspace folder.
  - If deleted project was active in the conversation, active project state is cleared.
- `/project clear`
  - Clears active project for the current conversation.
- `/project` or `/project status`
  - Shows current project status.

### 2.2 Build intent without active project (single clarification)

When coding/build intent is detected and no active project exists:

- Runtime asks exactly once for project name (`project_clarification_required`).
- User replies with project name (or `auto`).
- Runtime creates and activates project automatically.
- Original task is replayed and executed in autonomous mode.

### 2.2 Approval commands (hybrid UI + chat)

- `/approve <token>`
  - Approves pending guard/tool token.
- `/deny <token>`
  - Denies pending guard/tool token.

These commands are required for text-only channels (for example Telegram) where UI approval buttons are unavailable.

---

## 3. No-Project Guard

For coding/build intent messages without active project, runtime now prefers a
single-shot clarification flow over approval-token guard:

- Ask once for project name.
- Auto-create project and continue execution.
- Existing approval-token infrastructure is still used for tool-level approvals (for example shell command approval).

Legacy `guard_approved_without_project` DB state remains backward compatible, but is no longer the primary UX path.

---

## 4. Workspace CWD Routing

Active conversation project workspace is propagated as `workspaceCwd` to:

- Main AI tool loop (`dispatchToAI` -> `runModelToolLoop`).
- `/shell` command path.
- Inferred shell path.
- Approval replay path (`respondToolApproval`).
- Subagent runs (inherit active conversation project when present).

Execution safety:

- Effective cwd must resolve inside persona workspace root.
- Out-of-root cwd requests are rejected.

For build intent with active project:

- Runtime performs a workspace preflight shell probe before AI dispatch.
- AI dispatch receives an autonomous execution directive to implement end-to-end
  work and report concise status without code blocks by default.

Tool loop reliability:

- Empty final responses are replaced by structured statuses (`tool_limit_reached`, `empty_model_response`) instead of `(empty response)`.
- Autonomous build mode uses a higher tool-call budget (default `120`, configurable via `OPENCLAW_AUTONOMOUS_MAX_TOOL_CALLS` up to hard cap `500`).
- Repeated identical failed tool calls are short-circuited with `tool_stuck_repetition` to prevent infinite retry loops.
- `shell_execute` runtime for build-heavy tasks is configurable via:
  - `OPENCLAW_SHELL_TIMEOUT_MS` (default `600000`)
  - `OPENCLAW_SHELL_MAX_BUFFER_BYTES` (default `10000000`)

---

## 5. Worktree Position

Git worktrees are intentionally not a platform-level special feature here.

- User and agent can still run worktree commands through normal tool execution.
- Project workspace system only defines where tasks run by default.

---

## 6. Verification Commands

```bash
pnpm vitest run tests/messageRouter.test.ts tests/unit/channels/project-repository.test.ts tests/unit/channels/message-service-project-command.test.ts tests/unit/channels/message-service-project-guard.test.ts tests/unit/channels/message-service-project-approval-command.test.ts tests/unit/channels/message-service-project-workspace-cwd.test.ts tests/unit/channels/message-service-subagents.test.ts tests/unit/channels/message-service-tool-approval.test.ts tests/unit/channels/message-service-shell-command.test.ts tests/unit/skills/shell-execute-security.test.ts tests/unit/personas/persona-project-workspace.test.ts
pnpm typecheck
pnpm lint
```

### 6.1 Master-Workspace-Isolation Tests

```bash
pnpm vitest run tests/unit/master/master-workspace-scope.test.ts
pnpm vitest run tests/integration/master/master-workspace-isolation.test.ts
```

## 7. E2E Runbook

- `docs/runbooks/project-workspace-e2e-checklist.md`
