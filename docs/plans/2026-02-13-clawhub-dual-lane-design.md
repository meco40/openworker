# ClawHub Dual-Lane Integration Design

## Goal

Integrate ClawHub into the current OpenClaw Gateway Control Plane with low regression risk, while preserving the existing executable tool-skill runtime.

The target is split into two phases:

- Phase 1.0: Production-ready ClawHub management lane (discover/install/update/list) with a new `ClawHub` tab in the existing Skill Registry UI.
- Phase 1.5: Minimal, safe `SKILL.md` prompt hydration so ClawHub skills influence agent behavior (chat, rooms, worker) without forcing a full runtime migration.

## Current-State Constraints

The current system is strongly tool/function-call oriented:

- Tool definitions are built from installed skill rows (`skills/definitions.ts`).
- Execution is routed through static function-name mappings (`skills/execute.ts`, `src/server/skills/executeSkill.ts`).
- Chat, rooms, and worker consume provider tool schemas, not `SKILL.md` content.

ClawHub installs primarily `SKILL.md` and metadata files (`_meta.json`, `.clawhub/lock.json`), which do not match the current `functionName + handlerPath` manifest model.

This mismatch means a direct "replace with ClawHub" strategy is high risk and would break existing behavior. The best approach is a dual-lane architecture.

## Architecture Decision

### Decision

Use dual-lane architecture:

- Lane A (`tool` lane): existing executable skills remain unchanged.
- Lane B (`clawhub` lane): ClawHub `SKILL.md` skills are managed and optionally injected into prompts.

### Why this is best case

- Preserves production behavior of existing tool execution.
- Enables fast ClawHub adoption with minimal invasive changes.
- Avoids fragile automatic conversion of free-form `SKILL.md` into executable tools.
- Provides a clear path to later unify or extend behavior.

### Alternatives considered

1. Unified single `skills` table with `kind=tool|instruction`.

- Rejected for Phase 1 due migration complexity and high regression surface.

2. Filesystem-only ClawHub management (no repository layer).

- Rejected for weak UI state consistency and hard-to-test behavior.

3. Automatic `SKILL.md` -> tool conversion.

- Rejected due correctness and security risks.

## Component Design

### New server domain

Create `src/server/clawhub/`:

- `clawhubCli.ts`
  - CLI adapter with hybrid strategy:
    - first try `clawhub`
    - fallback to `npx -y clawhub`
  - supports: `search`, `explore`, `list`, `install`, `update`
  - enforces timeout and command argument validation

- `clawhubRepository.ts`
  - SQLite table for indexed UI/cache metadata:
    - `slug`, `version`, `title`, `installed_at`, `status`, `last_action_at`, `last_error`, `local_path`
  - this is not source-of-truth for actual local installation contents

- `clawhubService.ts`
  - orchestration layer:
    - execute CLI command
    - sync from `.clawhub/lock.json` and `skills/*/_meta.json`
    - persist normalized state into repository
  - emits warnings when parser confidence is low

- `searchParser.ts`
  - deterministic parser for `clawhub search` text output
  - returns parsed records plus parse warnings

### API surface

Add routes under `app/api/clawhub/`:

- `GET /api/clawhub/search?q=&limit=`
- `GET /api/clawhub/explore?limit=&sort=`
- `GET /api/clawhub/installed`
- `POST /api/clawhub/install`
- `POST /api/clawhub/update`

All routes:

- use `runtime = 'nodejs'`
- require `resolveRequestUserContext()`
- return `{ ok: true, ... }` or `{ ok: false, error, code, details? }`

### UI changes

Update `skills/SkillsRegistry.tsx`:

- keep existing install tabs (`GitHub`, `npm`, `Paste Manifest`)
- add new install tab: `ClawHub`
- add ClawHub panel actions:
  - search/discover
  - install
  - list installed
  - update single/all
- show explicit lane badge:
  - `Tool Skill` vs `ClawHub Skill`

## Data Flow

### Install flow

1. UI sends `POST /api/clawhub/install` with `{ slug, version?, force? }`.
2. Service runs CLI install via hybrid executor.
3. Service syncs local truth:
   - `.clawhub/lock.json`
   - `skills/<slug>/_meta.json`
4. Repository is updated from sync result.
5. API responds with normalized record and warnings.

### Update flow

1. UI sends `POST /api/clawhub/update` with `{ slug?, all?, version?, force? }`.
2. Service validates argument combinations.
3. CLI update runs.
4. Full lockfile-based sync runs.
5. API returns updated skill records.

### Installed list flow

1. UI calls `GET /api/clawhub/installed`.
2. Service performs light sync or cached-read with staleness policy.
3. Response returns normalized installed records.

### Search and discovery flow

- `explore`: uses JSON output (`clawhub explore --json`) as stable path.
- `search`: uses text output parser with warnings and confidence fallback.

## Prompt Hydration Plan (Phase 1.5)

Add `src/server/clawhub/clawhubPromptBuilder.ts`:

- reads enabled ClawHub skills
- extracts safe subset:
  - skill name
  - short description
  - selected metadata hints
  - bounded excerpt from `SKILL.md`
- hard caps total bytes/tokens
- strips unsupported/unsafe sections where needed

Inject into three runtime paths:

- chat path (`src/modules/app-shell/useAgentRuntime.ts`)
- rooms orchestrator (`src/server/rooms/orchestrator.ts`)
- worker executor (`src/server/worker/workerExecutor.ts`)

Prompt composition rule:

- core system/developer policies always have precedence
- ClawHub block appended as advisory capability context

## API Contracts

### GET `/api/clawhub/search`

Response:

```json
{
  "ok": true,
  "items": [{ "slug": "calendar", "version": "1.0.0", "title": "Calendar", "score": 0.52 }],
  "source": "search-text",
  "parseWarnings": []
}
```

### GET `/api/clawhub/explore`

Response:

```json
{
  "ok": true,
  "items": [{ "slug": "calendar", "latestVersion": "1.0.0", "title": "Calendar" }],
  "source": "explore-json"
}
```

### GET `/api/clawhub/installed`

Response:

```json
{
  "ok": true,
  "skills": [
    {
      "slug": "calendar",
      "version": "1.0.0",
      "status": "installed",
      "localPath": "skills/calendar"
    }
  ]
}
```

### POST `/api/clawhub/install`

Body:

```json
{ "slug": "calendar", "version": "1.0.0", "force": false }
```

### POST `/api/clawhub/update`

Body:

```json
{ "all": true, "force": false }
```

## Error Model

Use stable HTTP/status mapping:

- `400` invalid input
- `401` unauthorized
- `404` slug not found (operation-specific)
- `409` local conflict (requires `force`)
- `502` CLI/registry command failed
- `504` CLI timeout
- `500` unexpected server error

Error payload shape:

```json
{ "ok": false, "error": "Install failed", "code": "CLAW_INSTALL_FAILED", "details": {} }
```

## Security Model

Phase 1.0 security controls:

- allowlisted command builder (no raw shell string concatenation)
- strict timeout and bounded output capture
- install/update only through validated args
- auth required on all ClawHub endpoints
- warning banner in UI for external skill trust

Phase 1.5 additional controls:

- explicit enable/disable toggle per ClawHub skill for prompt inclusion
- content length limits and sanitization for injected skill text
- optional static code scan at install time for suspicious patterns
- hard precedence of system security instructions over skill content

## Testing Strategy

### Unit tests

- `searchParser` fixtures:
  - normal output
  - spacing variations
  - malformed lines
- service sync logic:
  - lockfile only
  - lockfile + `_meta`
  - missing/corrupt files

### Integration tests

- API route tests for all `/api/clawhub/*` endpoints
- CLI adapter mocked with deterministic stdout/stderr
- status code and payload contract assertions

### Regression tests

- existing skill route tests still pass
- existing tool mapping and execution tests still pass
- ensure ClawHub management does not alter tool execution path

### Phase 1.5 tests

- behavior-delta test:
  - same prompt with ClawHub skill disabled vs enabled
  - assert expected capability mention/usage shift

## Rollout Plan

### Phase 1.0 acceptance criteria

- New `ClawHub` tab works end-to-end.
- Install/update/list stable from lockfile sync.
- No regression in existing tool-skill runtime.
- Search parser emits warnings instead of crashing.

### Phase 1.5 acceptance criteria

- Enabled ClawHub skills influence chat/rooms/worker prompts.
- Prompt injection is bounded, safe, and opt-in.
- Core safety instructions remain dominant.

## Out of Scope (for now)

- Automatic conversion of `SKILL.md` into executable function tools
- publish/login flows in UI
- full OpenClaw parity for every advanced skill lifecycle feature

## Final Recommendation

Proceed with:

1. Phase 1.0 implementation first (management lane, no runtime breakage).
2. Immediate follow-up Phase 1.5 (minimal prompt hydration for actual behavioral value).

This is the best trade-off between delivery speed, system safety, and long-term alignment with OpenClaw-style skill behavior.
