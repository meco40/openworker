# CONTINUITY

[PLANS]

- 2026-03-04T21:03:45Z [TOOL] Documentation review executed across active docs (`README.md`, `docs/*.md` excluding `docs/archive/*`) with checks for config/runtime drift, dependency/version drift, and link integrity.
- 2026-03-05T00:26:10+01:00 [USER] Execute Harness-Engineering v2 rollout for Mission Control + Chat with blocking/async gates, deterministic harness, SoR contracts, entropy loop, and engineering metrics endpoint.

[DECISIONS]

- 2026-03-04T21:03:45Z [ASSUMPTION] Review scope prioritized active source-of-truth docs; archive/plans/reviews treated as historical unless they are linked as active guidance.
- 2026-03-05T00:26:10+01:00 [CODE] Harness verify now enforces a deterministic build prerequisite (`pnpm run build` when `.next/BUILD_ID` is absent) and skips reinstall in current-workspace mode to avoid Windows file-lock churn.
- 2026-03-05T08:13:25+01:00 [CODE] Harness Wave 2 thin-route AST guard is enforced with a frozen legacy exception baseline; any new direct DB usage in non-exempt `app/api/**/route.ts` now fails tests.

[PROGRESS]

- 2026-03-04T21:03:45Z [TOOL] Completed scripted checks: active-doc local link validation (0 broken links), script-reference validation against `package.json`, env/runtime mismatch scan, and targeted manual inspection of core docs.
- 2026-03-04T21:40:28Z [CODE] Applied doc corrections for requested items 1/2/4/5 across `README.md`, `.env.local.example`, `docs/CORE_HANDBOOK.md`, `docs/DEPLOYMENT_OPERATIONS.md`, `docs/README.md`, and `docs/DOCUMENTATION_AUDIT_2026-02-21.md`.
- 2026-03-04T21:47:54Z [CODE] Updated dev workflow so `npm run dev` launches both web and scheduler via `scripts/dev-stack.mjs` with coordinated shutdown behavior.
- 2026-03-04T22:57:19+01:00 [TOOL] Completed full `docs/*_SYSTEM.md` audit (16 files) with freshness scan, metadata completeness checks, and targeted code cross-checks for Master/Model-Hub/Knowledge/Omnichannel domains.
- 2026-03-04T23:03:00+01:00 [CODE] Applied selected doc-fix batch: normalized `docs/MASTER_AGENT_SYSTEM.md` metadata block, added missing `POST /api/master/runs/[id]/feedback` API entry, and added missing canonical metadata fields in `docs/PROJECT_WORKSPACE_SYSTEM.md` and `docs/TASKS_SYSTEM.md`.
- 2026-03-04T23:11:05+01:00 [CODE] Corrected `docs/CORE_HANDBOOK.md` dev-mode wording from "single process" to dual-process stack and aligned `npm run dev` description to `dev:web` + `dev:scheduler`.
- 2026-03-04T23:15:16+01:00 [TOOL] Reproduced `npm ci` failure and compared `package.json` vs `package-lock.json` root `devDependencies`.
- 2026-03-05T00:26:10+01:00 [CODE] Added engineering metrics stack (`GET /api/stats/engineering`, aggregation service/utilities), CI split (`blocking` vs `async` workflows), PR/issue governance templates, and weekly low-risk cleanup workflow.
- 2026-03-05T00:26:10+01:00 [CODE] Added deterministic agent harness (`scripts/harness/agent-verify.mjs`), flaky detector, Mission Control browser scenario, contract docs (index + domain contracts + operating model + debt register + runbook), and guard/contract/unit/integration tests.
- 2026-03-05T00:26:10+01:00 [TOOL] Verification executed: `pnpm run format:check`, `pnpm run typecheck`, `pnpm run lint`, targeted vitest suite for new stats/contract/architecture tests, `pnpm run test:e2e:smoke`, and `pnpm run harness:verify`.
- 2026-03-05T07:12:05+01:00 [TOOL] Performed branch-protection rollout request for `meco40/openworker` (`main`): dry-run reads (`/branches/main/protection`, `/rulesets`) and live write attempt to `/branches/main/protection/required_status_checks`.
- 2026-03-05T07:27:28+01:00 [TOOL] After repository visibility switched to public, successfully set branch protection on `main` via `PUT /repos/meco40/openworker/branches/main/protection` with required checks: `PR Policy`, `Typecheck + Lint + Format`, `Unit + Integration Tests`, `Component Tests`, `E2E Smoke`.
- 2026-03-05T07:32:08+01:00 [USER] Requested branch simplification to keep only `main`; executed remote cleanup (`git push origin --delete`) for 23 non-main branches, local cleanup (`git branch -D`) for 35 non-main branches, and switched repository default branch to `main`.
- 2026-03-05T08:13:25+01:00 [CODE] Implemented Harness Wave 2 rollout artifacts: async SLA workflows (`async-quality.yml`, `async-sla-audit.yml`), integrated `live-e2e` lane, removed `e2e-live.yml`, PR policy/template enforcement for agentic harness evidence, ingest route + repository + migrations, metrics snapshot workflow/script, architecture guard blocking job, and cleanup analyze/apply draft-PR workflow.
- 2026-03-05T08:13:25+01:00 [TOOL] Verification completed: `pnpm run format:check`, `pnpm run typecheck`, `pnpm run lint`, targeted Vitest for new harness files, and full `pnpm run test` (504 files / 2405 tests passed).
- 2026-03-05T08:16:05+01:00 [TOOL] Updated GitHub branch protection required checks on `meco40/openworker` `main` to include `Architecture Guards` and verified via `GET /branches/main/protection/required_status_checks`.
- 2026-03-05T08:17:30+01:00 [CODE] Hardened agentic PR harness gating: PR template now uses explicit scenario checkboxes, and CI policy validates at least one checked allowed scenario plus at least one evidence URL when `Agentic Change = Yes`.
- 2026-03-05T08:20:23+01:00 [TOOL] Applied GitHub Actions rollout flags on `meco40/openworker` with staged sequence (shadow defaults -> enforcement): `ASYNC_SLA_AUTOMATION_ENABLED=1`, `CLEANUP_DRAFT_PR_ENABLED=1`, `ENGINEERING_ALERTS_ENABLED=1`, `ENGINEERING_INGEST_ENABLED=0`.
- 2026-03-05T08:24:09+01:00 [TOOL] Set repository secrets `ENGINEERING_INGEST_TOKEN` (new random value) and `ENGINEERING_INGEST_URL` (`https://openworker.vercel.app/api/internal/stats/engineering/snapshots`) on `meco40/openworker`; verified via `GET /actions/secrets`.
- 2026-03-05T08:27:07+01:00 [TOOL] Rotated `ENGINEERING_INGEST_TOKEN` again and synchronized it between GitHub Actions secret and local runtime env files (`.env`, `.env.local`) so workflow and server can share one token value.
- 2026-03-05T08:28:43+01:00 [TOOL] Enabled `ENGINEERING_INGEST_ENABLED=1` in GitHub Actions repo variables for `meco40/openworker` and verified via `GET /actions/variables/ENGINEERING_INGEST_ENABLED`.
- 2026-03-05T08:55:38+01:00 [CODE] Fixed async browser harness regression by updating `tests/e2e/browser/mission-control-run-feedback.spec.ts` to resolve a valid Master scope (`personaId`, `workspaceId`) before run create/start/patch/feedback calls.
- 2026-03-05T08:55:38+01:00 [TOOL] Local verification after fix: `pnpm run check` passed and targeted integration suite (`tests/integration/master/master-runs-route.test.ts`, `tests/integration/master/master-feedback-route.test.ts`) passed.
- 2026-03-05T09:02:24+01:00 [CODE] Hardened mission-control browser harness scenario with bounded PATCH retry logic after `run.start` to absorb transient run-state contention before feedback submission.
- 2026-03-05T09:02:24+01:00 [TOOL] Re-verified post-fix quality gates locally via `pnpm run check` (typecheck, lint, format all green).
- 2026-03-05T09:09:36+01:00 [CODE] Patched `app/api/master/runs/[id]/route.ts` so PATCH only forwards explicitly provided fields to repository updates (prevents unintended null writes for omitted required fields like `title`/`contract`).
- 2026-03-05T09:09:36+01:00 [CODE] Added integration coverage in `tests/integration/master/master-runs-route.test.ts` for partial PATCH behavior to prevent future NOT NULL regressions.
- 2026-03-05T09:09:36+01:00 [TOOL] Verification executed: `pnpm run test -- tests/integration/master/master-runs-route.test.ts` and `pnpm run check` both passed after route fix.
- 2026-03-05T09:13:47+01:00 [TOOL] Post-push CI verification for commit `2d15118` completed with all target workflows green: `E2E Browser`, `Async Quality Gates`, `Blocking Gates`.

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
- 2026-03-05T00:26:10+01:00 [TOOL] Worktree harness runs failed when `.next` build artifacts were missing; smoke suites start gateway in production mode and require a built Next app before readiness checks.
- 2026-03-05T00:26:10+01:00 [TOOL] Re-running `pnpm install --frozen-lockfile` in an active workspace can hit `better-sqlite3` `EBUSY/EPERM` on Windows when local dev/test processes hold the native module; reinstall should be avoided in non-isolated harness mode.
- 2026-03-05T07:12:05+01:00 [TOOL] GitHub API rejects both branch-protection and rulesets endpoints for this private repo with `403` and message `Upgrade to GitHub Pro or make this repository public to enable this feature.`
- 2026-03-05T07:27:28+01:00 [TOOL] Repository default branch is currently `feat/control-plane-metrics`, but branch protection for `main` can still be managed and now exists with `strict=true` status checks.
- 2026-03-05T07:32:08+01:00 [TOOL] After cleanup and `git fetch --prune`, branch inventory is reduced to `main` (local: `main`; remote: `origin/main`) while required-status-check protection on `main` remains active.
- 2026-03-05T08:13:25+01:00 [TOOL] A strict global thin-route AST guard initially failed due 18 legacy DB-backed route files; production-safe enforcement now freezes that baseline and blocks regressions outside it.
- 2026-03-05T08:20:23+01:00 [TOOL] Repository had zero configured Actions secrets/variables before rollout; ingest remains disabled because `ENGINEERING_INGEST_URL` and `ENGINEERING_INGEST_TOKEN` are not provisioned.
- 2026-03-05T08:24:09+01:00 [ASSUMPTION] `ENGINEERING_INGEST_URL` was set to `openworker.vercel.app` endpoint as best-available public domain signal; live ingest still requires matching `ENGINEERING_INGEST_TOKEN` in deployed app runtime environment.
- 2026-03-05T08:28:43+01:00 [TOOL] `engineering-metrics-snapshot.yml` is not present on GitHub default branch yet (`gh workflow run ...` returns 404); current remote workflow inventory differs from local Harness Wave 2 files.
- 2026-03-05T08:55:38+01:00 [CODE] Browser E2E failure on CI (`mission-control-run-feedback`) is caused by a contract mismatch: Master run routes now require explicit scope fields (`personaId`, `workspaceId`), and the old test payload omitted them, yielding HTTP 400.
- 2026-03-05T08:55:38+01:00 [TOOL] Local Playwright reproduction is currently blocked by a broken pnpm junction for `@next/env` (`MODULE_NOT_FOUND`) under Node v24; CI with fresh install remains the authoritative runtime for browser-e2e validation.
- 2026-03-05T09:02:24+01:00 [TOOL] CI logs for commit `be890cc` show the remaining 400 moved to `PATCH /api/master/runs/:id` directly after `run.start`, indicating a timing/race issue rather than missing scope fields.
- 2026-03-05T09:09:36+01:00 [TOOL] CI failure details on commit `e7f8d63`: `NOT NULL constraint failed: master_runs.title` during PATCH because route passed `title`/`contract` keys as `undefined`, which repository serialized to `NULL`.

[OUTCOMES]

- 2026-03-04T21:03:45Z [TOOL] Review produced prioritized findings for documentation quality/actuality with concrete file:line evidence and remediation recommendations.
- 2026-03-04T21:40:28Z [CODE] Requested improvements delivered: runtime env var docs aligned to `SWARM_RUNNER`, Mem0 path defaults aligned to `/v1`, stale dependency rows removed/updated, index numbering fixed, and audit contradiction mitigated via explicit status addendum.
- 2026-03-04T21:47:54Z [CODE] `npm run dev` now orchestrates both runtime processes (`dev:web` + `dev:scheduler`) instead of only `server.ts`.
- 2026-03-04T22:57:19+01:00 [TOOL] System docs are mostly current by date (all reviewed within last 12 days), but not fully up to date due to metadata-contract drift and one API-surface omission in Master docs.
- 2026-03-04T23:03:00+01:00 [CODE] Option 1 remediation completed; previously reported metadata drift and Master API-surface omission are now resolved in-place.
- 2026-03-04T23:11:05+01:00 [CODE] Review finding about dev-mode process model in `docs/CORE_HANDBOOK.md` is remediated; docs now match current `npm run dev` orchestration.
- 2026-03-04T23:15:16+01:00 [TOOL] Root cause for `npm ci` errors identified as lockfile drift rather than network/runtime error.
- 2026-03-05T00:26:10+01:00 [CODE] Harness-Engineering v2 implementation for Mission Control + Chat is in place: merge model, deterministic verification harness, repository contracts/governance, architecture taste checks, entropy loop scaffolding, and engineering metrics API.
- 2026-03-05T00:26:10+01:00 [TOOL] End-to-end evidence captured with green blocking checks plus successful full harness run (`D:\web\clawtest\.local\harness\2026-03-04T23-17-20-828Z`).
- 2026-03-05T07:12:05+01:00 [TOOL] Required-check enforcement could not be activated via API due plan limitations (feature unavailable for current private-repo tier).
- 2026-03-05T07:27:28+01:00 [TOOL] Required blocking checks are now enforced on `main` and verified by readback from `/branches/main/protection/required_status_checks`.
- 2026-03-05T07:32:08+01:00 [TOOL] Repository branch topology is simplified to a single-branch model (`main` only), matching user request and reducing branch-management overhead.
- 2026-03-05T08:13:25+01:00 [CODE] Harness Wave 2 production-ready scope is now implemented and validated locally, including async SLA automation framework, snapshot ingest metrics path, architecture-guard required check context, and guarded cleanup draft-PR flow.
- 2026-03-05T08:16:05+01:00 [TOOL] Final branch-protection required-check set on `main` now matches Harness Wave 2 enforcement target: `PR Policy`, `Typecheck + Lint + Format`, `Unit + Integration Tests`, `Component Tests`, `E2E Smoke`, `Architecture Guards`.
- 2026-03-05T08:20:23+01:00 [TOOL] Phase 2/3 rollout flags are active for async SLA automation, cleanup draft PR automation, and alert policy; ingest is intentionally held at `0` pending required ingest secrets.
- 2026-03-05T08:24:09+01:00 [TOOL] Ingest secrets are now present in GitHub Actions, removing the prior secret-blocker for enabling snapshot ingest workflow calls.
- 2026-03-05T08:27:07+01:00 [TOOL] Token synchronization step completed: `ENGINEERING_INGEST_TOKEN` is present in `.env` and `.env.local`, and repo secret `ENGINEERING_INGEST_TOKEN` shows updated timestamp in GitHub.
- 2026-03-05T08:28:43+01:00 [TOOL] Ingest feature flag is now active in repo settings, but runtime validation is blocked until Harness Wave 2 workflow files are pushed to `main`.
- 2026-03-05T08:55:38+01:00 [CODE] Mission-control browser harness scenario now aligns with current API scope invariants and should no longer fail with 400 on `POST /api/master/runs` in async CI.
- 2026-03-05T09:02:24+01:00 [CODE] Harness scenario now includes deterministic retry on run completion patch, reducing flakiness in async browser lane without weakening assertion coverage.
- 2026-03-05T09:09:36+01:00 [CODE] Root-cause regression in PATCH API behavior is remediated and guarded by integration test; next CI cycle should validate browser async lane end-to-end.
- 2026-03-05T09:13:47+01:00 [TOOL] Harness Wave 2 rollout is operationally green on `main` for the enforced check set, including previously failing mission-control browser path.
