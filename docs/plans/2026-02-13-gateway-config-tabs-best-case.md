# Gateway Config Production Readiness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver a production-grade Gateway Config experience: safe editing, deterministic validation, no secret/path leaks, conflict-safe saves, runtime effect for supported settings, and verifiable rollout.

**Architecture:** Keep `/api/config` as the single config API. Use shared schema constants across backend/frontend, split strict vs recoverable validation paths, add optimistic concurrency (`revision`) for PUT, and keep atomic writes with backup snapshots. Apply supported `ui` settings to runtime startup paths and expose migration warnings consistently.

**Tech Stack:** Next.js route handlers, React 19, TypeScript strict mode, Vitest, ESLint.

---

## Gap Analysis (What Was Missing)

### Blockers to Production

1. `MISSING`: No conflict protection for concurrent edits (last write wins).
2. `MISSING`: No config revision contract (`GET` -> `PUT`) for stale-write detection.
3. `MISSING`: No explicit secret masking/redaction strategy for sensitive fields.
4. `MISSING`: Invalid optional `ui.*` can still break load UX if treated as hard-fail.
5. `MISSING`: Saved `ui.defaultView` not wired to app startup behavior.
6. `MISSING`: Allowed-values drift risk between backend and frontend lists.
7. `MISSING`: Error contract sanitization policy is incomplete for failure cases.
8. `MISSING`: Observability and audit events for config mutations.
9. `MISSING`: Production rollout/runbook/rollback procedure.
10. `MISSING`: Behavioral UI tests for editor flows (beyond static label rendering).
11. `MISSING`: Inline field guidance and actionable validation copy for non-technical users.
12. `MISSING`: Save preview (diff) and risk labeling (safe vs restart-required).
13. `MISSING`: Robust conflict UX for stale saves (`409`) with user choices.
14. `MISSING`: Accessibility baseline (keyboard flow, focus order, semantic labels).
15. `MISSING`: Empty/loading/error state UX quality standards and acceptance criteria.

### Current Readiness Verdict

`NOT PRODUCTION READY`.

---

## Production Requirements (Definition of Ready)

1. `R1 Safety`: Atomic write + backup + rollback path verified.
2. `R2 Consistency`: Stale client saves rejected with `409` via `revision` check.
3. `R3 Security`: No absolute path leaks; sensitive secrets not exposed unintentionally.
4. `R4 Reliability`: Invalid optional fields yield warnings/recovery, not unrecoverable UI lockout.
5. `R5 UX Integrity`: Frontend allowed values are sourced from same schema constants as backend.
6. `R6 Runtime Effect`: `ui.defaultView` actually affects app startup with safe fallback.
7. `R7 Observability`: Config load/save emits structured logs + counters.
8. `R8 Test Evidence`: Integration + unit + component behavior tests cover critical paths.
9. `R9 Operations`: Runbook with deploy, rollback, incident steps exists and is validated.
10. `R10 Usability`: Non-technical user can complete common update flow without reading raw JSON.
11. `R11 Clarity`: All validation errors include field, issue, and concrete fix suggestion.
12. `R12 Accessibility`: Keyboard-only editing and focus-visible controls pass automated checks.
13. `R13 Recovery UX`: Conflict and failure states provide deterministic recovery actions.
14. `R14 Change Safety`: User sees a human-readable config diff before apply.
15. `R15 UX QA`: Manual acceptance checklist for first-time and returning users passes.

Plan is considered production-ready only when all `R1-R15` are verified.

---

## UX Best-Case Design Decisions

### Core UX Principles

1. Progressive disclosure: simple tabs first, advanced JSON opt-in.
2. Explain before error: each critical field has short helper copy and safe defaults.
3. Actionable failures: every error must offer a next action (`Fix field`, `Reload`, `Restore previous`).
4. Safe-by-default apply: show diff and risk badge before write.
5. Predictable recovery: stale save conflicts always surface explicit choices.

### Primary User Flows

1. First-time setup: open Config, edit host/port/log level, review diff, apply successfully in under 2 minutes.
2. Routine tweak: change one UI option, apply without touching JSON.
3. Invalid config recovery: app loads with warnings, user can fix through tabs.
4. Concurrent edit recovery: stale revision error gives merge/reload options.

### UX Quality Targets

1. `UX1`: >=95% successful applies on first attempt in integration tests.
2. `UX2`: 100% backend validation errors mapped to field-level messages in UI.
3. `UX3`: Keyboard-only flow covers tab switch, field edit, diff review, apply.
4. `UX4`: Conflict (`409`) resolution completes without data loss.
5. `UX5`: No raw stack/path/internal identifiers exposed to end users.

---

### Task 1: Unify schema constants and tighten contracts

**Files:**
- Create: `src/shared/config/uiSchema.ts`
- Modify: `src/server/config/gatewayConfig.ts`
- Modify: `components/ConfigEditor.tsx`
- Modify: `tests/unit/config/gateway-config.test.ts`

**Step 1: Write failing test for schema parity**
- Assert that backend and editor consume identical `defaultView`, `density`, and `timeFormat` value sets.

**Step 2: Run tests and verify RED**
```bash
npm test -- tests/unit/config/gateway-config.test.ts
```

**Step 3: Implement shared constants**
- Export `ALLOWED_UI_DEFAULT_VIEWS`, `ALLOWED_UI_DENSITIES`, `ALLOWED_UI_TIME_FORMATS` from shared module.
- Remove duplicated literal lists in backend/frontend.

**Step 4: Run tests and verify GREEN**
```bash
npm test -- tests/unit/config/gateway-config.test.ts tests/unit/components/config-editor-tabs.test.ts
```

**Step 5: Commit**
```bash
git add src/shared/config/uiSchema.ts src/server/config/gatewayConfig.ts components/ConfigEditor.tsx tests/unit/config/gateway-config.test.ts tests/unit/components/config-editor-tabs.test.ts
git commit -m "refactor: share ui schema constants between config api and editor"
```

### Task 2: Add recoverable load validation and strict save validation

**Files:**
- Modify: `src/server/config/gatewayConfig.ts`
- Modify: `app/api/config/route.ts`
- Modify: `tests/integration/config/config-route.test.ts`
- Modify: `tests/unit/config/gateway-config.test.ts`

**Step 1: Write failing tests**
- `GET /api/config` returns `200` + warning when persisted config has invalid optional `ui.timeFormat`.
- `PUT /api/config` still returns `400` for invalid `ui.timeFormat` user input.

**Step 2: Run tests and verify RED**
```bash
npm test -- tests/integration/config/config-route.test.ts tests/unit/config/gateway-config.test.ts
```

**Step 3: Implement behavior split**
- Load path: recover invalid optional `ui.*` fields with warning codes; preserve config usability.
- Save path: reject invalid optional `ui.*` with precise field errors.

**Step 4: Run tests and verify GREEN**
```bash
npm test -- tests/integration/config/config-route.test.ts tests/unit/config/gateway-config.test.ts
```

**Step 5: Commit**
```bash
git add src/server/config/gatewayConfig.ts app/api/config/route.ts tests/integration/config/config-route.test.ts tests/unit/config/gateway-config.test.ts
git commit -m "fix: recover invalid optional ui fields on load while keeping strict save validation"
```

### Task 3: Introduce revision-based optimistic concurrency

**Files:**
- Modify: `src/server/config/gatewayConfig.ts`
- Modify: `app/api/config/route.ts`
- Modify: `components/ConfigEditor.tsx`
- Create: `tests/integration/config/config-concurrency.test.ts`

**Step 1: Write failing integration tests**
- GET returns `revision`.
- PUT with stale/missing revision returns `409` and no write.
- PUT with current revision succeeds and returns new revision.

**Step 2: Run tests and verify RED**
```bash
npm test -- tests/integration/config/config-concurrency.test.ts
```

**Step 3: Implement revision contract**
- Compute deterministic revision (content hash or mtime+size signature).
- Require revision on PUT requests.
- Return stable error message for stale updates.

**Step 4: Run tests and verify GREEN**
```bash
npm test -- tests/integration/config/config-concurrency.test.ts
```

**Step 5: Commit**
```bash
git add src/server/config/gatewayConfig.ts app/api/config/route.ts components/ConfigEditor.tsx tests/integration/config/config-concurrency.test.ts
git commit -m "feat: add optimistic concurrency via config revision"
```

### Task 4: Secret redaction and error sanitization hardening

**Files:**
- Modify: `src/server/config/gatewayConfig.ts`
- Modify: `app/api/config/route.ts`
- Modify: `components/ConfigEditor.tsx`
- Modify: `tests/integration/config/config-route.test.ts`

**Step 1: Write failing tests**
- API responses do not expose absolute filesystem paths in error strings.
- Sensitive fields (example: `channels.telegram.token`) are redacted in GET responses unless explicit override is present.

**Step 2: Run tests and verify RED**
```bash
npm test -- tests/integration/config/config-route.test.ts
```

**Step 3: Implement hardening**
- Sanitize unknown internal errors to stable public messages.
- Redact known secret fields by default on outbound payload.
- Keep unredacted values only for write path and server-side processing.

**Step 4: Run tests and verify GREEN**
```bash
npm test -- tests/integration/config/config-route.test.ts
```

**Step 5: Commit**
```bash
git add src/server/config/gatewayConfig.ts app/api/config/route.ts components/ConfigEditor.tsx tests/integration/config/config-route.test.ts
git commit -m "fix: redact sensitive config fields and sanitize api error payloads"
```

### Task 5: Apply runtime behavior for supported UI settings

**Files:**
- Create: `src/server/config/uiRuntimeConfig.ts`
- Modify: `src/modules/app-shell/useAppShellState.ts`
- Modify: `tests/unit/modules/rendering-smoke.test.ts`
- Create: `tests/unit/app-shell/default-view-config.test.ts`

**Step 1: Write failing tests**
- Valid configured `ui.defaultView` sets initial `currentView`.
- Invalid configured value falls back to `View.DASHBOARD`.

**Step 2: Run tests and verify RED**
```bash
npm test -- tests/unit/app-shell/default-view-config.test.ts tests/unit/modules/rendering-smoke.test.ts
```

**Step 3: Implement runtime wiring**
- Add safe config read helper for startup.
- Map string value to `View` enum with strict fallback.

**Step 4: Run tests and verify GREEN**
```bash
npm test -- tests/unit/app-shell/default-view-config.test.ts tests/unit/modules/rendering-smoke.test.ts
```

**Step 5: Commit**
```bash
git add src/server/config/uiRuntimeConfig.ts src/modules/app-shell/useAppShellState.ts tests/unit/app-shell/default-view-config.test.ts tests/unit/modules/rendering-smoke.test.ts
git commit -m "feat: apply configured default ui view at app startup"
```

### Task 6: Backup/rollback safety for writes

**Files:**
- Modify: `src/server/config/gatewayConfig.ts`
- Create: `tests/unit/config/gateway-config-rollback.test.ts`

**Step 1: Write failing tests**
- Save operation creates backup snapshot before replace.
- Failed rename/write preserves previous valid config.

**Step 2: Run tests and verify RED**
```bash
npm test -- tests/unit/config/gateway-config-rollback.test.ts
```

**Step 3: Implement backup + rollback behavior**
- Keep one rotating backup (or timestamped backups with retention 3).
- Ensure failed write path leaves main config intact.

**Step 4: Run tests and verify GREEN**
```bash
npm test -- tests/unit/config/gateway-config-rollback.test.ts
```

**Step 5: Commit**
```bash
git add src/server/config/gatewayConfig.ts tests/unit/config/gateway-config-rollback.test.ts
git commit -m "feat: add config backup snapshots and rollback-safe write behavior"
```

### Task 7: Behavioral tests for ConfigEditor critical flows

**Files:**
- Create: `tests/unit/components/config-editor-behavior.test.tsx`
- Modify: `tests/unit/components/config-editor-tabs.test.ts`
- Modify: `components/ConfigEditor.tsx` (only if needed for test hooks)

**Step 1: Write failing behavioral tests**
- Warning panel renders on load warnings.
- Invalid advanced JSON blocks apply/simple mode.
- PUT success updates revision and clears dirty state.
- PUT conflict (`409`) shows actionable stale-data message.

**Step 2: Run tests and verify RED**
```bash
npm test -- tests/unit/components/config-editor-tabs.test.ts tests/unit/components/config-editor-behavior.test.tsx
```

**Step 3: Implement minimal UI hooks if required**
- Add stable labels/test ids only when necessary.

**Step 4: Run tests and verify GREEN**
```bash
npm test -- tests/unit/components/config-editor-tabs.test.ts tests/unit/components/config-editor-behavior.test.tsx
```

**Step 5: Commit**
```bash
git add tests/unit/components/config-editor-tabs.test.ts tests/unit/components/config-editor-behavior.test.tsx components/ConfigEditor.tsx
git commit -m "test: cover gateway config editor behavioral and conflict flows"
```

### Task 8: Observability and audit events

**Files:**
- Modify: `app/api/config/route.ts`
- Modify: `src/server/config/gatewayConfig.ts`
- Create/Modify: `src/server/telemetry/configEvents.ts`
- Create: `tests/integration/config/config-observability.test.ts`

**Step 1: Write failing tests**
- Save attempts emit structured event (`config.save.attempt`, `config.save.success`, `config.save.failed`).
- Warning count and source are logged without secrets.

**Step 2: Run tests and verify RED**
```bash
npm test -- tests/integration/config/config-observability.test.ts
```

**Step 3: Implement structured logging hooks**
- Include correlation fields (`userId`, source, warningCount, status), exclude secret values.

**Step 4: Run tests and verify GREEN**
```bash
npm test -- tests/integration/config/config-observability.test.ts
```

**Step 5: Commit**
```bash
git add app/api/config/route.ts src/server/config/gatewayConfig.ts src/server/telemetry/configEvents.ts tests/integration/config/config-observability.test.ts
git commit -m "feat: add structured telemetry for config load/save lifecycle"
```

### Task UX-1: Add guided editing UX and field-level validation mapping

**Files:**
- Create: `src/shared/config/fieldMetadata.ts`
- Modify: `components/ConfigEditor.tsx`
- Create: `tests/unit/components/config-editor-validation-mapping.test.tsx`

**Step 1: Write failing tests**
- Backend error `gateway.port must ...` maps to the `Port` field in UI.
- Helper copy renders for host, port, bind, and logLevel fields.

**Step 2: Run tests and verify RED**
```bash
npm test -- tests/unit/components/config-editor-validation-mapping.test.tsx
```

**Step 3: Implement guided UX**
- Add field metadata: label, helper text, example values, risk level.
- Render inline helper and inline error state near each field.
- Keep advanced JSON mode unchanged but show pointer to corresponding simple field when possible.

**Step 4: Run tests and verify GREEN**
```bash
npm test -- tests/unit/components/config-editor-validation-mapping.test.tsx
```

**Step 5: Commit**
```bash
git add src/shared/config/fieldMetadata.ts components/ConfigEditor.tsx tests/unit/components/config-editor-validation-mapping.test.tsx
git commit -m "feat: add guided field metadata and mapped validation UX for config editor"
```

### Task UX-2: Add pre-apply diff preview and risk badges

**Files:**
- Modify: `components/ConfigEditor.tsx`
- Create: `src/shared/config/diffSummary.ts`
- Create: `tests/unit/components/config-editor-diff-preview.test.tsx`

**Step 1: Write failing tests**
- Clicking `Apply` opens a diff summary modal/panel first.
- Diff groups changed fields by tab and shows risk badge (`safe`, `restart-required`, `sensitive`).
- Confirming apply proceeds; cancel keeps draft.

**Step 2: Run tests and verify RED**
```bash
npm test -- tests/unit/components/config-editor-diff-preview.test.tsx
```

**Step 3: Implement diff UX**
- Compute human-readable before/after summary.
- Highlight high-impact keys (network bind/port/auth) as restart-required when applicable.
- Require explicit confirmation for high-risk changes.

**Step 4: Run tests and verify GREEN**
```bash
npm test -- tests/unit/components/config-editor-diff-preview.test.tsx
```

**Step 5: Commit**
```bash
git add components/ConfigEditor.tsx src/shared/config/diffSummary.ts tests/unit/components/config-editor-diff-preview.test.tsx
git commit -m "feat: add pre-apply diff preview with risk badges for config changes"
```

### Task UX-3: Stale-save conflict dialog and unsaved-change protection

**Files:**
- Modify: `components/ConfigEditor.tsx`
- Modify: `app/api/config/route.ts`
- Create: `tests/unit/components/config-editor-conflict-recovery.test.tsx`
- Create: `tests/integration/config/config-conflict-ux.test.ts`

**Step 1: Write failing tests**
- `409` response shows conflict UI with choices: `Reload latest`, `Review diff`, `Try apply again`.
- Navigating away with dirty changes triggers confirmation.

**Step 2: Run tests and verify RED**
```bash
npm test -- tests/unit/components/config-editor-conflict-recovery.test.tsx tests/integration/config/config-conflict-ux.test.ts
```

**Step 3: Implement conflict recovery UX**
- Add deterministic stale-data message and action buttons.
- Preserve local draft for merge/review.
- Add unsaved-changes navigation guard in editor scope.

**Step 4: Run tests and verify GREEN**
```bash
npm test -- tests/unit/components/config-editor-conflict-recovery.test.tsx tests/integration/config/config-conflict-ux.test.ts
```

**Step 5: Commit**
```bash
git add components/ConfigEditor.tsx app/api/config/route.ts tests/unit/components/config-editor-conflict-recovery.test.tsx tests/integration/config/config-conflict-ux.test.ts
git commit -m "feat: add stale-save conflict recovery and unsaved-change protection"
```

### Task UX-4: Accessibility and content clarity hardening

**Files:**
- Modify: `components/ConfigEditor.tsx`
- Create: `tests/unit/components/config-editor-a11y.test.tsx`
- Create: `tests/unit/components/config-editor-keyboard-flow.test.tsx`
- Create: `docs/ux/gateway-config-copy-guidelines.md`

**Step 1: Write failing tests**
- No critical `axe` violations for config editor render.
- Keyboard-only flow supports tab switch, form input, diff open, apply confirm.

**Step 2: Run tests and verify RED**
```bash
npm test -- tests/unit/components/config-editor-a11y.test.tsx tests/unit/components/config-editor-keyboard-flow.test.tsx
```

**Step 3: Implement accessibility and copy hardening**
- Add aria labels/descriptions for all editable fields and status messages.
- Ensure focus order and focus-visible states are deterministic.
- Replace ambiguous copy with user-actionable copy per guideline doc.

**Step 4: Run tests and verify GREEN**
```bash
npm test -- tests/unit/components/config-editor-a11y.test.tsx tests/unit/components/config-editor-keyboard-flow.test.tsx
```

**Step 5: Commit**
```bash
git add components/ConfigEditor.tsx tests/unit/components/config-editor-a11y.test.tsx tests/unit/components/config-editor-keyboard-flow.test.tsx docs/ux/gateway-config-copy-guidelines.md
git commit -m "feat: harden config editor accessibility and user-facing copy"
```

### Task 9: Operational rollout and runbook

**Files:**
- Create: `docs/runbooks/gateway-config-production-rollout.md`
- Modify: `docs/plans/2026-02-13-gateway-config-tabs-best-case.md`

**Step 1: Write runbook**
- Pre-deploy checks.
- Feature flag strategy.
- Canary rollout plan.
- Rollback commands and recovery steps.
- Incident triage for config corruption/conflict spikes.

**Step 2: Verify commands in runbook**
```bash
rg -n "TODO|TBD|<fill>" docs/runbooks/gateway-config-production-rollout.md
```
Expected: no placeholders.

**Step 3: Commit**
```bash
git add docs/runbooks/gateway-config-production-rollout.md docs/plans/2026-02-13-gateway-config-tabs-best-case.md
git commit -m "docs: add gateway config production rollout and rollback runbook"
```

### Task 10: Final production gate (Go/No-Go)

**Files:**
- Modify: `docs/plans/2026-02-13-gateway-config-tabs-best-case.md`

**Step 1: Lint changed code**
```bash
npx eslint app/api/config/route.ts src/server/config/gatewayConfig.ts src/server/config/uiRuntimeConfig.ts src/shared/config/uiSchema.ts src/shared/config/fieldMetadata.ts src/shared/config/diffSummary.ts components/ConfigEditor.tsx tests/integration/config/config-route.test.ts tests/integration/config/config-concurrency.test.ts tests/integration/config/config-observability.test.ts tests/integration/config/config-conflict-ux.test.ts tests/unit/config/gateway-config.test.ts tests/unit/config/gateway-config-rollback.test.ts tests/unit/components/config-editor-tabs.test.ts tests/unit/components/config-editor-behavior.test.tsx tests/unit/components/config-editor-validation-mapping.test.tsx tests/unit/components/config-editor-diff-preview.test.tsx tests/unit/components/config-editor-conflict-recovery.test.tsx tests/unit/components/config-editor-a11y.test.tsx tests/unit/components/config-editor-keyboard-flow.test.tsx tests/unit/app-shell/default-view-config.test.ts
```

**Step 2: Run full verification suite**
```bash
npm test -- tests/integration/config/config-route.test.ts tests/integration/config/config-concurrency.test.ts tests/integration/config/config-observability.test.ts tests/integration/config/config-conflict-ux.test.ts tests/unit/config/gateway-config.test.ts tests/unit/config/gateway-config-rollback.test.ts tests/unit/components/config-editor-tabs.test.ts tests/unit/components/config-editor-behavior.test.tsx tests/unit/components/config-editor-validation-mapping.test.tsx tests/unit/components/config-editor-diff-preview.test.tsx tests/unit/components/config-editor-conflict-recovery.test.tsx tests/unit/components/config-editor-a11y.test.tsx tests/unit/components/config-editor-keyboard-flow.test.tsx tests/unit/app-shell/default-view-config.test.ts
```

**Step 3: Production checklist validation (`R1-R15`)**
- Confirm each requirement with exact test/log evidence.
- Run manual UX checklist from runbook covering first-time flow, conflict recovery (`409`), keyboard-only flow, and invalid optional field recovery.

**Step 4: Declare status**
- If all `R1-R15` pass with evidence: mark `PRODUCTION READY`.
- Otherwise keep `NOT PRODUCTION READY` and list exact remaining blockers.

**Step 5: Commit**
```bash
git add docs/plans/2026-02-13-gateway-config-tabs-best-case.md
git commit -m "docs: add go-no-go gate for gateway config production readiness"
```
