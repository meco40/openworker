# Global Codex Guidance (~/.codex/AGENTS.md)

Global working agreements for Codex CLI.

## Accuracy, recency, and sourcing (REQUIRED)

You are working on a windows system.
When a request depends on recency (e.g., "latest", "current", "today", "as of now"):

1. **Establish the current date/time** and state it explicitly in ISO format.
   - Preferred: `date -Is` (timestamp).

2. **Prefer official / primary sources** when researching:
   - Upstream vendor docs for any dependency (language runtime, framework, cloud provider, etc.)

3. **Prefer the most recent authoritative information**:
   - Use the newest versioned docs, release notes, or changelogs.
   - Cross-check at least two reputable sources when details are safety/compatibility sensitive.

### Web search policy

- Enable and use web search only when it materially improves correctness (e.g., up-to-date APIs, recent advisories, release notes).
- Prefer official docs and primary sources; otherwise use Context7 MCP or reputable, widely-cited references.
- Record source dates (publish/release dates) when relevant.

## Default autonomy and safety

- Default to read-only exploration and analysis.
- When edits are needed, prefer **workspace-scoped** write access and keep changes inside the repo.
- When interacting with remote APIs, you must use READ-only calls, unless explicitily instructed otherwise by the user. If the user requests an API WRITE-based command, perform it as a dry-run first. You must never make destructive calls to remote APIs or production data sources.

### Editing files

- Make the smallest safe change that solves the issue.
- Preserve existing style and conventions.
- Prefer patch-style edits (small, reviewable diffs) over full-file rewrites.
- After making changes, run the project’s standard checks when feasible (format/lint, unit tests, build/typecheck).

### Reading project documents (PDFs, uploads, long text, CSVs, etc)

- Read the full document first.
- Draft the output.
- **Before finalizing**, re-read the original source to verify:
  - factual accuracy,
  - no invented details,
  - wording/style is preserved unless the user explicitly asked to rewrite.
- If paraphrasing is required, label it explicitly as a paraphrase.

### Container-first policy (REQUIRED)

- Codex must **never** install system packages on the host unless explicitly instructed.
- Prefer container images to supply all tooling used by the project.
- For code projects and dependencies: **use containers by default**.
- If the repo has an existing container workflow (Dockerfile/compose/Makefile targets), follow it.
- If the repo has no container workflow, create a minimal one.
- Keep repo-specific container details in the repo’s `AGENTS.md`.

## Repository workflows and commands (`D:\web\clawtest`)

Use these workflows by default for this repository.

### Environment bootstrap

```powershell
pnpm install
Copy-Item .env.local.example .env.local
```

Required local memory settings in `.env.local`:

- `MEMORY_PROVIDER=mem0`
- `MEM0_BASE_URL=http://127.0.0.1:8010`
- `MEM0_API_KEY=local-mem0-dev-token` (or local override)
- `MODEL_HUB_ENCRYPTION_KEY=<32-byte-key>`

### Local development workflow (preferred)

1. Start local mem0 services:

```powershell
pnpm run mem0:local:up
```

2. Start app development stack:

```powershell
pnpm run dev
```

3. Start scheduler when automation behavior is in scope:

```powershell
pnpm run dev:scheduler
```

Useful runtime helpers:

```powershell
pnpm run mem0:local:logs
pnpm run mem0:local:ps
pnpm run mem0:local:down
```

### Validation workflow (after code changes)

Run focused checks first, then full checks before completion:

```powershell
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run check
pnpm run build
```

E2E lanes:

```powershell
pnpm run test:e2e:smoke
pnpm run test:e2e:browser
pnpm run test:e2e:live
```

### Container workflows

Use containerized flows instead of host package/system changes.

Production-like stack:

```powershell
docker compose up -d --build web scheduler
docker compose logs -f web scheduler
docker compose down
```

E2E in containers:

```powershell
pwsh -File scripts/e2e/run-smoke-in-container.ps1
pwsh -File scripts/e2e/run-browser-in-container.ps1
```

### Safe maintenance commands

Prefer dry runs before apply-style cleanup commands:

```powershell
pnpm run local:cleanup:dry
pnpm run test:artifacts:clean:dry
pnpm run local:cleanup
pnpm run test:artifacts:clean
pnpm run workspaces:cleanup
```

### Baseline workflow

- Start every task by determining:
  1. Goal + acceptance criteria.
  2. Constraints (time, safety, scope).
  3. What must be inspected (files, commands, tests, docs).
  4. Whether the request depends on **recency** (if yes, apply the "Accuracy, recency, and sourcing" rules).
  5. If requirements are ambiguous, ask targeted clarifying questions before making irreversible changes.

## CONTINUITY.md (REQUIRED)

Maintain a single continuity file for the current workspace: `.agent/CONTINUITY.md`.

- `.agent/CONTINUITY.md` is a living document and canonical briefing designed to survive compaction; do not rely on earlier chat/tool output unless it's reflected there.

- At the start of each assistant turn: read `.agent/CONTINUITY.md` before acting.

### File Format

Update `.agent/CONTINUITY.md` only when there is a meaningful delta in:

- `[PLANS]`: "Plans Log" is a guide for the next contributor as much as checklists for you.
- `[DECISIONS]`: "Decisions Log" is used to record all decisions made.
- `[PROGRESS]`: "Progress Log" is used to record course changes mid-implementation, documenting why and reflecting upon the implications.
- `[DISCOVERIES]`: "Discoveries Log" is for when when you discover optimizer behavior, performance tradeoffs, unexpected bugs, or inverse/unapply semantics that shaped your approach, capture those observations with short evidence snippets (test output is ideal.
- `[OUTCOMES]`: "Outcomes Log" is used at completion of a major task or the full plan, summarizing what was achieved, what remains, and lessons learned.

### Anti-drift / anti-bloat rules

- Facts only, no transcripts, no raw logs.
- Every entry must include:
  - a date in ISO timestamp (e.g., `2026-01-13T09:42Z`)
  - a provenance tag: `[USER]`, `[CODE]`, `[TOOL]`, `[ASSUMPTION]`
  - If unknown, write `UNCONFIRMED` (never guess). If something changes, supersede it explicitly (don't silently rewrite history).
- Keep the file bounded, short and high-signal (anti-bloat).
- If sections begin to become bloated, compress older items into milestone (`[MILESTONE]`) bullets.
- Do a Automatic prettier format only on that md file.

## Definition of done

A task is done when:

- the requested change is implemented or the question is answered,
  - verification is provided:
  - build attempted (when source code changed),
  - linting run (when source code changed),
  - errors/warnings addressed (or explicitly listed and agreed as out-of-scope),
  - plus tests/typecheck as applicable,
- documentation is updated exhaustively for impacted areas,
- impact is explained (what changed, where, why),
- follow-ups are listed if anything was intentionally left out.
- `.agent/CONTINUITY.md` is updated if the change materially affects goal/state/decisions.
