# CONTINUITY

## [PLANS]

- 2026-03-05T13:15:17Z [USER] Update `AGENTS.md` with new workflows and commands for this workspace.
- 2026-03-05T13:15:17Z [ASSUMPTION] Interpreted "new workflows and commands" as adding repo-specific operational playbooks derived from current scripts and compose files.
- 2026-03-05T15:58:37Z [USER] Investigate and fix OAuth failure (`{"error":"Unauthorized"}`) on `openai-codex` at `/api/model-hub/oauth/callback`.

## [DECISIONS]

- 2026-03-05T13:15:17Z [CODE] Keep global guidance intact and append a dedicated `D:\web\clawtest` section instead of rewriting existing policy blocks.
- 2026-03-05T13:15:17Z [CODE] Include command sets for bootstrap, dev stack, validation, container usage, and safe cleanup (dry-run first).
- 2026-03-05T15:58:37Z [CODE] Treat `/api/model-hub/oauth/callback` as a public proxy path so OAuth redirects can reach route-level auth checks even when middleware bearer checks would otherwise reject them.

## [PROGRESS]

- 2026-03-05T13:15:17Z [TOOL] Read `.agent/CONTINUITY.md`, `AGENTS.md`, `package.json`, `README.md`, `docker-compose*.yml`, and `Dockerfile` to map actual workflows.
- 2026-03-05T13:15:17Z [CODE] Patched `AGENTS.md` with repository-specific workflow and command sections.
- 2026-03-05T15:58:37Z [CODE] Added `tests/unit/auth/proxy-oauth-callback.test.ts` to reproduce the callback 401 path through `proxy.ts`.
- 2026-03-05T15:58:37Z [CODE] Updated `proxy.ts` `PUBLIC_API_PREFIXES` to include `/api/model-hub/oauth/callback`.
- 2026-03-05T15:58:37Z [TOOL] Verified with `pnpm vitest run tests/unit/auth/proxy-oauth-callback.test.ts tests/unit/auth/proxy-policy.test.ts tests/integration/model-hub/oauth-callback-route.test.ts`, `pnpm run typecheck`, and `pnpm run lint`.
- 2026-03-05T15:58:37Z [TOOL] Build verification passed via `pnpm run build`.

## [DISCOVERIES]

- 2026-03-05T13:15:17Z [TOOL] Repository already exposes explicit workflows via scripts: mem0 lifecycle, e2e container scripts, and cleanup commands with dry-run variants.
- 2026-03-05T15:58:37Z [CODE] `proxy.ts` returned JSON `401 Unauthorized` before `app/api/model-hub/oauth/callback/route.ts` executed, matching the user-facing failure shape.
- 2026-03-05T15:58:37Z [TOOL] `pnpm run build` reports one pre-existing Turbopack warning about broad pattern matching in `src/server/ci/harnessDomainRegistry.ts` import traces.

## [OUTCOMES]

- 2026-03-05T13:15:17Z [CODE] `AGENTS.md` now contains concrete, copy-ready commands and a default workflow order aligned to the repo's existing tooling.
- 2026-03-05T15:58:37Z [CODE] OAuth callback requests for Model Hub now bypass proxy token enforcement and proceed to route-level user-context handling, eliminating the premature middleware 401 for Codex OAuth callback redirects.
