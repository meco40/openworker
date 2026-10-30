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

## Repository workflows and commands (`E:\web\clawtest`)

Use these workflows by default for this repository.

### Environment bootstrap

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.local.example .env.local
```

Required local memory settings in `.env.local`:

- `MEMORY_PROVIDER=postgres`
- `WORLD_MODEL_ENABLED=true`, `WORLD_MODEL_MODE=canonical`
- `CANONICAL_DATABASE_URL` as in the example for the local development database
- Own `NEXTAUTH_SECRET`, `AUTH_DEFAULT_EMAIL`, `AUTH_DEFAULT_PASSWORD`
- `MODEL_HUB_ENCRYPTION_KEY=<32-byte-key>`

### Local development workflow (preferred)

1. Start the local development PostgreSQL database and migrate it:

```powershell
docker compose -f docker-compose.postgres.yml up -d
pnpm run world-model:migrate
```

2. Start the development stack; import the Node-era data once after the first start:

```powershell
pnpm run dev                 # builds the Rust binaries (dev profile) and watches rust/crates
pnpm run dev:import-legacy   # once, with the stack stopped: personas, conversations, master runs, model hub
```

With `cargo` on the host (toolchain pinned in `rust/rust-toolchain.toml`), `pnpm run dev`
builds gateway and scheduler with the incremental dev profile, runs copies from
`.local/rust-dev/bin` and rebuilds and restarts both when a file below `rust/crates`
changes (about 10 to 20 seconds; the first build takes a few minutes). A failed build
keeps the running processes. Without `cargo` the stack uses the release binary or the
container image (`pnpm run rust:build`). The host gateway keeps its own stores in
`.local/rust-dev` (`scripts/dev-host-data.mjs`); the Node-era files directly in `.local`
stay untouched. Loopback requests need no login: the anonymous principal is the admin
of that store, so the imported data is visible. Stop the stack with Ctrl+C, so it ends
its child processes.

`pnpm run dev` starts the Rust gateway on `127.0.0.1:3000`, the Next.js UI on
port 3001 in proxy mode (`BETACLAW_UI_MODE=proxy`) and the scheduler. The gateway
owns the public listener, answers all 113 API routes natively in Rust, terminates
`/ws`, and reverse proxies frontend pages and HMR to the Next.js dev server.
`pnpm run dev:static` builds the static export (`pnpm run build:export`) and starts
the Rust gateway in static mode (`BETACLAW_UI_MODE=static`), serving the UI natively
from `out/` without a Node application server. `pnpm run dev:node` keeps the previous Node-only stack
available for debugging.

#### Background Job Runtime Ownership

Background jobs support tri-state ownership via `BETACLAW_TELEGRAM_POLLER`,
`BETACLAW_SWARM_RUNNER`, and `BETACLAW_WORKSPACE_CLEANUP` (`rust` | `node` | `off`):

- In `docker-compose.yml`, they default to `rust`.
- In native development (`pnpm run dev`), they can be configured in `.env.local`.
- If set to `node`, Node.js handles them (legacy mode).
- If set to `rust`, Rust handles them exclusively without conflict (no Telegram 409).
- If unset, both implementations resolve to `node`; `off` disables the job.
- Keep the values identical in all processes. `SWARM_RUNNER=server|scheduler`
  selects the swarm process; Compose selects `scheduler`. Cleanup runs in the scheduler.
- UI mode and `UI_STATIC_DIR` are resolved at startup. `static` serves the export,
  `proxy` forwards to Next. Without a mode, an existing
  export selects static serving. `dev:static` always rebuilds it.

#### Port conflicts

Port 3000 is only the default, not a fixed contract, because it is frequently
taken by another application on the machine.

- Development stack: set `GATEWAY_PORT` (or `PORT`) to a free port.
  `pnpm run dev` probes the port first and aborts with instructions instead of
  letting the gateway die with a bare "address in use".
- Compose: set `GATEWAY_PUBLISHED_PORT` in `.env.local`. Only the published host
  port changes; the container still listens on 3000, so the internal upstream
  wiring is unaffected.
- When the published port differs from 3000, also set `NEXTAUTH_URL` and
  `APP_URL` to the matching origin, because they are the OAuth callback origin.
- The browser derives its WebSocket URL from the page origin, so no client or
  frontend configuration has to change for a different port.

3. Start the scheduler separately only when `pnpm run dev:scheduler` is needed
   for a focused automation run. The default `pnpm run dev` already includes it.

Optional Mem0 compatibility runs require explicit `MEMORY_PROVIDER=mem0`, URL,
API key and configured LLM/embedding providers. See README for that branch.
Mem0 is not a prerequisite for the canonical workflow. Optional runtime helpers:

```powershell
pnpm run mem0:local:logs
pnpm run mem0:local:ps
pnpm run mem0:local:down
```

### Rust backend rules

The backend is being migrated to Rust. The plan, the slice order and the
per-slice removal criteria live in `docs/RUST_MIGRATION.md`. While that migration
is in progress:

- Do not add a Rust dependency when an existing crate in the workspace already
  covers the need. Check `rust/Cargo.toml` first.
- Port behaviour, not just signatures. Every Rust module names the TypeScript
  file it mirrors so drift is reviewable.
- Verify foreign details instead of assuming them. Session cookies are checked
  against a fixture generated with the real `next-auth@4.24.15`; shared constants
  are generated, not transcribed. After changing either, regenerate the fixture
  and confirm CI's freshness check passes.
- Never weaken a security boundary: loopback marker, origin policy, RLS scope,
  exec approvals, webhook signatures and secret handling stay as they are in the
  TypeScript implementation.
- The dev gateway is built natively with the toolchain pinned in
  `rust/rust-toolchain.toml`. Gates (`rust:test`, `rust:clippy`, `rust:fmt:check`)
  run through the pinned container image.

### Validation workflow (after code changes)

Run focused checks first, then full checks before completion:

```powershell
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run check
pnpm run build

# Rust backend
pnpm run rust:fmt:check
pnpm run rust:clippy
pnpm run rust:test
```

When a slice changes a route that both implementations serve, run the parity
check as well:

```powershell
pnpm run verify:logs-parity
```

E2E lanes:

```powershell
pnpm run test:e2e:smoke
pnpm run test:e2e:browser
pnpm run test:e2e:production
pnpm run test:e2e:live
```

### Container workflows

Use containerized flows instead of host package/system changes.

Production-like stack: set all unique secrets and first-admin credentials listed
in README in `.env.local`. Compose requires them and keeps admin DB credentials
in the separate migration service:

```powershell
docker compose --env-file .env.local up -d --build gateway scheduler
docker compose --env-file .env.local logs -f gateway scheduler
docker compose --env-file .env.local down
```

Compose starts PostgreSQL, migrations and role provisioning, then the Rust
gateway and scheduler. Rust serves the static UI, declared API handlers and
WebSocket. Route coverage checks declarations; behavior requires parity and smoke tests.
The image includes Python and Node/Playwright/Chromium for on-demand tool subprocesses.
No Node application server starts in the standard stack. The optional legacy Next.js server can be started for regression
checks via `--profile legacy-node-ui`. Use
`GATEWAY_PUBLISHED_PORT` when port 3000 is occupied (see the port conflicts
section above). Runtime roles are
`world_model_app` and `world_model_worker`; their RLS grants are tested
separately. Three named volumes hold persistent data; `down` preserves them.
Follow README's backup/restore requirement before upgrades.
The public production smoke creates its own isolated project and empty volumes,
verifies real login/WebSocket/chat/embeddings and Python/Chromium, then removes
only that project's volumes. Its HTTP model fixture is not a live-model quality test.

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

## Migrationsstand

Der Stand der Backend-Migration nach Rust wird in `docs/RUST_MIGRATION.md` gepflegt. Dort werden Slices, Testzahlen und offene Punkte in Abschnitt 7 ergänzt. Es gibt keine separate Zustandsdatei mehr. Stand und Begründung kommen aus der Git-Historie und dieser Datei.

Keine Zeitstempel-/Provenienz-Vorgaben mehr.

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
- docs/RUST_MIGRATION.md ist aktualisiert, wenn sich Slice-Stand, Testzahl oder offene Punkte ändern.
