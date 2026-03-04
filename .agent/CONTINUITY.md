# CONTINUITY

[PLANS]

- 2026-03-04T21:03:45Z [TOOL] Documentation review executed across active docs (`README.md`, `docs/*.md` excluding `docs/archive/*`) with checks for config/runtime drift, dependency/version drift, and link integrity.

[DECISIONS]

- 2026-03-04T21:03:45Z [ASSUMPTION] Review scope prioritized active source-of-truth docs; archive/plans/reviews treated as historical unless they are linked as active guidance.

[PROGRESS]

- 2026-03-04T21:03:45Z [TOOL] Completed scripted checks: active-doc local link validation (0 broken links), script-reference validation against `package.json`, env/runtime mismatch scan, and targeted manual inspection of core docs.
- 2026-03-04T21:40:28Z [CODE] Applied doc corrections for requested items 1/2/4/5 across `README.md`, `.env.local.example`, `docs/CORE_HANDBOOK.md`, `docs/DEPLOYMENT_OPERATIONS.md`, `docs/README.md`, and `docs/DOCUMENTATION_AUDIT_2026-02-21.md`.
- 2026-03-04T21:47:54Z [CODE] Updated dev workflow so `npm run dev` launches both web and scheduler via `scripts/dev-stack.mjs` with coordinated shutdown behavior.
- 2026-03-04T22:57:19+01:00 [TOOL] Completed full `docs/*_SYSTEM.md` audit (16 files) with freshness scan, metadata completeness checks, and targeted code cross-checks for Master/Model-Hub/Knowledge/Omnichannel domains.
- 2026-03-04T23:03:00+01:00 [CODE] Applied selected doc-fix batch: normalized `docs/MASTER_AGENT_SYSTEM.md` metadata block, added missing `POST /api/master/runs/[id]/feedback` API entry, and added missing canonical metadata fields in `docs/PROJECT_WORKSPACE_SYSTEM.md` and `docs/TASKS_SYSTEM.md`.
- 2026-03-04T23:11:05+01:00 [CODE] Corrected `docs/CORE_HANDBOOK.md` dev-mode wording from "single process" to dual-process stack and aligned `npm run dev` description to `dev:web` + `dev:scheduler`.
- 2026-03-04T23:15:16+01:00 [TOOL] Reproduced `npm ci` failure and compared `package.json` vs `package-lock.json` root `devDependencies`.

[DISCOVERIES]

- 2026-03-04T21:03:45Z [CODE] Runtime role env var in code is `SWARM_RUNNER` (`server.ts:180`, `scheduler.ts:24`, `src/server/agent-room/swarmRuntime.ts:4`) while active docs and compose reference `ROOMS_RUNNER`.
- 2026-03-04T21:03:45Z [CODE] Mem0 API path default in runtime is `/v1` (`src/server/memory/mem0/client.ts:69`, `:300`), but `README.md` and `.env.local.example` document default `/`.
- 2026-03-04T21:03:45Z [CODE] `docs/CORE_HANDBOOK.md` dependency table contains stale/missing entries (`@google/genai` version drift, `archiver` missing in `package.json`, `@typescript-eslint/*` not present).
- 2026-03-04T21:40:28Z [TOOL] Post-fix grep confirms active docs no longer contain `ROOMS_RUNNER`; only archive files still reference it.
- 2026-03-04T21:47:54Z [TOOL] Windows `spawn` for npm required `shell: true` in the dev-stack launcher to avoid `EINVAL` during child-process startup.
- 2026-03-04T22:57:19+01:00 [TOOL] `docs/MASTER_AGENT_SYSTEM.md` uses non-canonical top-level `**Status**/**Scope**` instead of metadata block and omits required metadata keys (`Purpose`, `Source of Truth`, `Last Reviewed`, `Related Runbooks`).
- 2026-03-04T22:57:19+01:00 [TOOL] `docs/PROJECT_WORKSPACE_SYSTEM.md` metadata is incomplete (missing `Source of Truth` and `Related Runbooks`).
- 2026-03-04T22:57:19+01:00 [TOOL] `docs/TASKS_SYSTEM.md` uses `Related Docs` but omits canonical `Related Runbooks` metadata field.
- 2026-03-04T22:57:19+01:00 [TOOL] Active Master API includes `POST /api/master/runs/[id]/feedback` but this endpoint is missing from `docs/MASTER_AGENT_SYSTEM.md` API surface section.
- 2026-03-04T23:15:16+01:00 [TOOL] `npm ci` fails with `EUSAGE` because lockfile is out of sync: `package.json` includes `@testing-library/jest-dom`, `@testing-library/react`, and `jsdom`, but these are missing from root `devDependencies` in `package-lock.json`, causing cascading "Missing ... from lock file" entries.

[OUTCOMES]

- 2026-03-04T21:03:45Z [TOOL] Review produced prioritized findings for documentation quality/actuality with concrete file:line evidence and remediation recommendations.
- 2026-03-04T21:40:28Z [CODE] Requested improvements delivered: runtime env var docs aligned to `SWARM_RUNNER`, Mem0 path defaults aligned to `/v1`, stale dependency rows removed/updated, index numbering fixed, and audit contradiction mitigated via explicit status addendum.
- 2026-03-04T21:47:54Z [CODE] `npm run dev` now orchestrates both runtime processes (`dev:web` + `dev:scheduler`) instead of only `server.ts`.
- 2026-03-04T22:57:19+01:00 [TOOL] System docs are mostly current by date (all reviewed within last 12 days), but not fully up to date due to metadata-contract drift and one API-surface omission in Master docs.
- 2026-03-04T23:03:00+01:00 [CODE] Option 1 remediation completed; previously reported metadata drift and Master API-surface omission are now resolved in-place.
- 2026-03-04T23:11:05+01:00 [CODE] Review finding about dev-mode process model in `docs/CORE_HANDBOOK.md` is remediated; docs now match current `npm run dev` orchestration.
- 2026-03-04T23:15:16+01:00 [TOOL] Root cause for `npm ci` errors identified as lockfile drift rather than network/runtime error.
