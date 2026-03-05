# CONTINUITY

## [PLANS]

- 2026-03-05T13:15:17Z [USER] Update `AGENTS.md` with new workflows and commands for this workspace.
- 2026-03-05T13:15:17Z [ASSUMPTION] Interpreted "new workflows and commands" as adding repo-specific operational playbooks derived from current scripts and compose files.

## [DECISIONS]

- 2026-03-05T13:15:17Z [CODE] Keep global guidance intact and append a dedicated `D:\web\clawtest` section instead of rewriting existing policy blocks.
- 2026-03-05T13:15:17Z [CODE] Include command sets for bootstrap, dev stack, validation, container usage, and safe cleanup (dry-run first).

## [PROGRESS]

- 2026-03-05T13:15:17Z [TOOL] Read `.agent/CONTINUITY.md`, `AGENTS.md`, `package.json`, `README.md`, `docker-compose*.yml`, and `Dockerfile` to map actual workflows.
- 2026-03-05T13:15:17Z [CODE] Patched `AGENTS.md` with repository-specific workflow and command sections.

## [DISCOVERIES]

- 2026-03-05T13:15:17Z [TOOL] Repository already exposes explicit workflows via scripts: mem0 lifecycle, e2e container scripts, and cleanup commands with dry-run variants.

## [OUTCOMES]

- 2026-03-05T13:15:17Z [CODE] `AGENTS.md` now contains concrete, copy-ready commands and a default workflow order aligned to the repo's existing tooling.
