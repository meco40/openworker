# CONTINUITY

[PLANS]

- 2026-02-21T16:47:31Z [USER] Re-check all active docs for IST conformity, detect missing system docs, and add professional missing documentation.

- 2026-02-21T16:10:00Z [USER] Vollständige Dokumentationsprüfung aller aktiven Docs gegen IST-Zustand; alle Abweichungen korrigiert.

- 2026-02-21T14:52:37Z [USER] Restore Oxlint-based lint setup after accidental rollback to ESLint.
- 2026-02-21T14:41:42Z [USER] Fix `npm ci` failure in workspace `d:\web\clawtest`.
- 2026-02-21T14:22:41Z [USER] Audit all docs in `docs/`, archive obsolete files, and establish a professional documentation structure.
- 2026-02-21T14:22:41Z [CODE] Execution scope set to documentation-only changes (index, archive moves, plan index, audit report).
- 2026-02-21T14:29:56Z [USER] Apply one consistent professional metadata template to all active system documentations.
- 2026-02-21T14:37:34Z [USER] Verify whether active system documentations match the current implementation and feature set.
- 2026-02-21T14:45:44Z [USER] Apply all identified corrections to stale system documentations.

[DECISIONS]

- 2026-02-21T16:47:31Z [CODE] Treat API domain coverage as incomplete unless each `app/api/<domain>` surface is described in active docs beyond the route catalog.

- 2026-02-21T14:58:57Z [CODE] Keep `docs/API_REFERENCE.md` machine-derived from live `app/api/**/route.ts` exports to avoid manual drift.
- 2026-02-21T14:41:42Z [CODE] Treat `npm ci` `EPERM unlink` as file-lock root cause and resolve by terminating only locking processes instead of changing dependency graph.
- 2026-02-21T14:22:41Z [CODE] Keep active source-of-truth docs in `docs/` and move analysis/report/superseded-plan documents to `docs/archive/*`.
- 2026-02-21T14:22:41Z [ASSUMPTION] Plan files older than current active planning cycle are treated as completed or superseded unless marked otherwise in active indexes.
- 2026-02-21T14:29:56Z [CODE] Standard template fields for active system docs: `Purpose`, `Scope`, `Source of Truth`, `Last Reviewed`, `Related Runbooks`.
- 2026-02-21T14:45:44Z [CODE] Keep `WORKER_*` docs active but convert them to current-state docs that explicitly document worker removal and active replacements (`/api/ops*`, `/api/rooms*`).

[PROGRESS]

- 2026-02-21T17:20:11Z [TOOL] Ran explicit end-control verification suite (API parity, domain coverage, link integrity, non-legacy drift scan) across all active docs.
- 2026-02-21T17:20:11Z [CODE] Corrected one remaining stale reference in `docs/memory-architecture.md` from `/api/knowledge/stats` to `/api/control-plane/metrics`.
- 2026-02-21T16:47:31Z [CODE] Added `docs/AUTH_SYSTEM.md` as dedicated active system documentation for NextAuth/session/principal runtime behavior.
- 2026-02-21T16:47:31Z [CODE] Added `docs/OPS_OBSERVABILITY_SYSTEM.md` to cover previously under-documented active domains (`config`, `control-plane`, `doctor`, `health`, `logs`, `stats`, `ops`).
- 2026-02-21T16:47:31Z [CODE] Updated `docs/README.md` and `docs/CORE_HANDBOOK.md` documentation maps to include new active system docs; corrected stale Core Handbook endpoint examples.
- 2026-02-21T16:47:31Z [CODE] Marked removed worker endpoints explicitly as `Legacy, entfernt` in `docs/WORKER_SYSTEM.md` and `docs/WORKER_ORCHESTRA_SYSTEM.md` to avoid ambiguity.
- 2026-02-21T16:47:31Z [CODE] Added re-audit addendum to `docs/DOCUMENTATION_AUDIT_2026-02-21.md` to reflect new active system docs and full API-domain coverage.

- 2026-02-21T16:10:00Z [CODE] ARCHITECTURE_DIAGRAM.md: Ersetzte stales "Orchestra Worker System"-Subgraph durch "Rooms Orchestrator"; aktualisierte Connections und System-Modules-Beschreibung.
- 2026-02-21T16:10:00Z [CODE] AUTOMATION_SYSTEM.md: Fehlende `GET /api/automations/metrics`-Route in API-Referenztabelle ergänzt.
- 2026-02-21T16:10:00Z [CODE] CORE_HANDBOOK.md: 15 gezielte Korrekturen — Status-Datum, Worker-Domain, Email-Channel, Frame-Typen (rpc_request→req/res/event/stream), Projektstruktur (worker, services/, App.tsx, gateway/, upload/), Linting (eslint→oxlint), Coverage-Schwellenwerte (70%→60%), Tests-Struktur (load→e2e), @dagrejs/dagre-Eintrag entfernt, Python-Services-Abschnitt entfernt.
- 2026-02-21T16:10:00Z [CODE] DEPLOYMENT_OPERATIONS.md: Datum aktualisiert; worker_queue und Worker-Threads-Box aus ASCII-Diagramm entfernt; worker_queue_size-Metrik und WorkerQueueBacklog-Alert entfernt; worker-JSON aus sample health response entfernt.
- 2026-02-21T16:10:00Z [CODE] OMNICHANNEL_GATEWAY_OPERATIONS.md: `Stand: 2026-02-17` → `2026-02-21`.
- 2026-02-21T16:10:00Z [CODE] 5 veraltete Runbooks ins Archiv verschoben: openai-worker-local-runbook, openai-worker-slos, openai-worker-rollout, openai-worker-data-governance, worker-orchestra-v1-rollout. Alle Querverweise in README.md, WORKER_ORCHESTRA_SYSTEM.md, PERSONA_ROOMS_SYSTEM.md, MODEL_HUB_SYSTEM.md, DOCUMENTATION_AUDIT aktualisiert.
- 2026-02-21T16:10:00Z [CODE] src/server/skills/builtInSkills.ts: Code-Kommentar "8 real skills" → "9 real skills" korrigiert.

- 2026-02-21T14:58:57Z [CODE] Corrected Model Hub endpoint parameter references to `/api/model-hub/accounts/[accountId]*` in `docs/MODEL_HUB_SYSTEM.md`.
- 2026-02-21T14:52:37Z [CODE] Regenerated `.oxlintrc.json` from `eslint.config.js` via `@oxlint/migrate` (`--with-nursery --js-plugins --details`), switched `package.json` scripts and `lint-staged` back to Oxlint, and removed `eslint.config.js`.
- 2026-02-21T14:52:37Z [TOOL] Ran `npm install` to refresh lockfile and install Oxlint-related dependencies (`oxlint`, `ts-api-utils`).
- 2026-02-21T14:52:37Z [CODE] Fixed Oxlint blocking error in `src/server/knowledge/sqliteKnowledgeRepository.ts` (`let` -> `const` in loop initializer).
- 2026-02-21T14:48:20Z [TOOL] Verified lint stack state after user report: `package.json` scripts and `lint-staged` currently point to ESLint, not Oxlint.
- 2026-02-21T14:41:42Z [TOOL] Reproduced `npm ci` failure with `EPERM unlink` for native `.node` binaries under `node_modules`.
- 2026-02-21T14:41:42Z [TOOL] Correlated lock holders to `Code.exe` processes via module scan (`tailwindcss-oxide` and earlier `lightningcss`).
- 2026-02-21T14:41:42Z [TOOL] Stopped lock-holding `Code.exe` PIDs and reran `npm ci` successfully.
- 2026-02-21T14:22:41Z [TOOL] Moved 19 previously active docs into `docs/archive/analysis`, `docs/archive/reports`, and `docs/archive/plans/*`.
- 2026-02-21T14:22:41Z [CODE] Updated `docs/README.md`, `docs/plans/README.md`, and `docs/archive/README.md` to reflect the new structure.
- 2026-02-21T14:25:00Z [CODE] Added `docs/DOCUMENTATION_AUDIT_2026-02-21.md` with per-file keep/archive decisions for all 51 audited docs.
- 2026-02-21T14:29:56Z [CODE] Added standardized `## Metadata` block to 12 active system docs without changing their technical body content.
- 2026-02-21T14:37:34Z [TOOL] Completed code-vs-doc audit for all 12 active system docs using API route inventory and direct source file checks.
- 2026-02-21T14:45:44Z [CODE] Rewrote `docs/WORKER_SYSTEM.md` and `docs/WORKER_ORCHESTRA_SYSTEM.md` to match current codebase (no `/api/worker*`, rooms+ops architecture).
- 2026-02-21T14:45:44Z [CODE] Corrected targeted mismatches in `docs/KNOWLEDGE_BASE_SYSTEM.md`, `docs/PERSONA_ROOMS_SYSTEM.md`, `docs/SKILLS_SYSTEM.md`, and `docs/SECURITY_SYSTEM.md`.

[DISCOVERIES]

- 2026-02-21T17:20:11Z [TOOL] Final end-control found exactly one residual stale active-doc endpoint reference before fix: `docs/memory-architecture.md` line ~592 (`/api/knowledge/stats`).
- 2026-02-21T16:47:31Z [TOOL] Active API domains `auth` and `stats` had no dedicated active system docs (outside `API_REFERENCE`) prior to this pass.
- 2026-02-21T16:47:31Z [TOOL] `CORE_HANDBOOK.md` still contained stale/non-existent endpoint examples (`/api/health/gateway`, `/api/llm`) before correction.
- 2026-02-21T16:47:31Z [TOOL] Legacy worker-route lists in active Worker docs were technically correct but visually ambiguous until explicit legacy labels were added per-route.

- 2026-02-21T16:10:00Z [TOOL] ARCHITECTURE_DIAGRAM.md hatte stalen "Orchestra Worker System"-Subgraph, obwohl src/server/worker nicht existiert.
- 2026-02-21T16:10:00Z [TOOL] CORE_HANDBOOK.md war das umfangreichst veraltete Dokument: falsches Datum, Worker-Domain-Box, falsche Frame-Typen (rpc_request statt req), Email-Channel, fehlende Module (cron, ops, exposure, tasks, telemetry), @dagrejs/dagre nicht installiert, Python-Services-Sektion, stale Project-Structure.
- 2026-02-21T16:10:00Z [TOOL] 5 Runbooks referenzierten services/openai_worker/ und /api/worker/openai/\* — Service vollständig entfernt, Runbooks in docs/archive/runbooks/ verschoben.
- 2026-02-21T16:10:00Z [TOOL] Gateway Frame Types: tatsächliche Typen sind req/res/event/stream (protocol.ts), nicht rpc_request/rpc_response/error.

[OUTCOMES]

- 2026-02-21T17:20:11Z [TOOL] End-control pass result after fix: `ROUTE_FILES=71`, `API_REFERENCE_ROWS=71`, `UNCOVERED_DOMAINS=0`, `MISSING_LOCAL_LINKS=0`, `NONLEGACY_UNKNOWN_API_REFS=0`.
- 2026-02-21T16:47:31Z [TOOL] Verification passed after additions: `ROUTE_FILES=71`, `API_REFERENCE_ROWS=71`, `UNCOVERED_DOMAINS=0`, `MISSING_LOCAL_LINKS=0`.
- 2026-02-21T16:47:31Z [CODE] Active documentation set now includes dedicated auth and ops/observability system references aligned with current runtime and API surface.
- 2026-02-21T16:47:31Z [TOOL] Final drift scan result: `NONLEGACY_UNKNOWN_API_REFS=0` across active docs.

- 2026-02-21T16:10:00Z [CODE] Alle 8 aktiven System-Docs plus CORE_HANDBOOK und DEPLOYMENT_OPERATIONS geprüft und wo nötig korrigiert.
- 2026-02-21T16:10:00Z [CODE] Aktiver Runbook-Stand: nur chat-cli-smoke-approval.md und gateway-config-production-rollout.md verbleiben als aktive Runbooks.
- 2026-02-21T16:10:00Z [CODE] Bekannte verbleibende Abweichungen: keine (alle identifizierten Drift-Punkte korrigiert).

- 2026-02-21T14:52:37Z [TOOL] `npm run lint` now executes Oxlint successfully with 0 errors but 31 warnings in current branch state.
- 2026-02-21T14:48:20Z [TOOL] Oxlint artifacts are currently absent (`.oxlintrc.json` missing, no `oxlint` in `package.json`), while `eslint.config.js` exists again.
- 2026-02-21T14:41:42Z [TOOL] Active VS Code processes (`Code.exe`) can map workspace native modules (`@tailwindcss/oxide`, `lightningcss`) and block `npm ci` cleanup on Windows (`EPERM`, errno -4048).
- 2026-02-21T14:22:41Z [TOOL] Active docs contained significant duplication from historical analyses and implementation reports; these were mixed with source-of-truth docs before this cleanup.
- 2026-02-21T14:25:00Z [TOOL] Link validation for `docs/README.md` and `docs/plans/README.md` passed with no missing local targets.
- 2026-02-21T14:25:00Z [TOOL] `npx prettier --check` for modified markdown failed due missing `prettier-plugin-tailwindcss` resolution in local environment (UNCONFIRMED package state).
- 2026-02-21T14:29:56Z [TOOL] Metadata presence check passed for all 12 targeted system files; referenced runbook paths resolve locally.
- 2026-02-21T14:37:34Z [TOOL] `docs/WORKER_SYSTEM.md` and `docs/WORKER_ORCHESTRA_SYSTEM.md` are stale: documented `/api/worker*` routes are absent in `app/api`, and referenced `src/server/worker/*` files do not exist.
- 2026-02-21T14:37:34Z [TOOL] `docs/KNOWLEDGE_BASE_SYSTEM.md` claims no public knowledge routes, but `app/api/knowledge/graph/route.ts` is implemented.
- 2026-02-21T14:37:34Z [TOOL] Additional drift found: persona permissions routes documented but not implemented; skills default state for `shell` mismatches seed config; security webhook sample uses legacy webhook path.
- 2026-02-21T14:45:44Z [TOOL] Post-fix check: updated docs now reflect `/api/channels/telegram/webhook`, `/api/knowledge/graph`, and `/api/skills/[id]`; persona permissions routes removed from docs.

[OUTCOMES]

- 2026-02-21T14:58:57Z [TOOL] Verification matched generated API documentation against route files (`ROUTE_FILES=71`, `DOC_ROUTE_ROWS=71`).
- 2026-02-21T14:58:57Z [CODE] Active API + Model Hub system docs now reflect current account route parameter naming (`[accountId]`) and live endpoint surface.
- 2026-02-21T14:52:37Z [CODE] Oxlint migration state restored: `.oxlintrc.json` present, `eslint.config.js` removed, `lint`/`lint:fix` and `lint-staged` now use Oxlint again.
- 2026-02-21T14:41:42Z [TOOL] `npm ci` now completes successfully in this workspace after releasing file locks; install finished with 0 vulnerabilities.
- 2026-02-21T14:22:41Z [CODE] Added `docs/DOCUMENTATION_AUDIT_2026-02-21.md` with per-file decisions so the archive rationale is explicit and traceable.
- 2026-02-21T14:25:00Z [CODE] Active plans reduced to two current items in `docs/plans/`; obsolete plans moved to `docs/archive/plans/completed|superseded`.
- 2026-02-21T14:25:00Z [TOOL] Post-cleanup counts: 51 audited legacy-active docs; 19 moved to archive; 33 current non-archive docs (includes new audit document).
- 2026-02-21T14:29:56Z [CODE] All active domain system documentations now share one professional header template and common governance fields.
- 2026-02-21T14:37:34Z [TOOL] Current documentation status: mixed; core domains mostly aligned, but Worker/Orchestra and parts of Knowledge/Persona/Skills/Security need corrective updates.
- 2026-02-21T14:45:44Z [CODE] The six identified stale system docs are now corrected to the current implementation and route surface.
