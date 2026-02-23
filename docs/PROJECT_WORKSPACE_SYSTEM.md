# Project Workspace System

## Metadata

- Purpose: Define the conversation-scoped project workspace workflow for persona-driven build tasks.
- Scope: `/project` lifecycle, no-project guard approvals, workspace cwd propagation for tool execution.
- Last Reviewed: 2026-02-23

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

---

## 2. User Commands

### 2.1 Project lifecycle

- `/project new <name>`
  - Creates workspace under persona projects root.
  - Persists project record.
  - Sets project active for the current conversation.
- `/project list`
  - Lists projects for the current persona only.
- `/project use <id|slug>`
  - Activates an existing project for the current conversation.
- `/project clear`
  - Clears active project for the current conversation.
- `/project` or `/project status`
  - Shows current project status.

### 2.2 Approval commands (hybrid UI + chat)

- `/approve <token>`
  - Approves pending guard/tool token.
- `/deny <token>`
  - Denies pending guard/tool token.

These commands are required for text-only channels (for example Telegram) where UI approval buttons are unavailable.

---

## 3. No-Project Guard

For coding/build intent messages:

- If no active conversation project exists and no prior guard approval exists:
  - Runtime returns `approval_required` metadata with token.
  - Prompt offers:
    - `/project new <name>`
    - `/project use <id|slug>`
    - `/approve <token>` (temporary continue without project)
    - `/deny <token>`

Guard approval behavior:

- Approval is stored in `conversation_project_state.guard_approved_without_project = 1`.
- Approval is conversation-scoped.
- Setting or switching a project resets this flag to `0`.

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

## 7. E2E Runbook

- `docs/runbooks/project-workspace-e2e-checklist.md`
