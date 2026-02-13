# Copilot Instructions — OpenClaw Gateway Control Plane

## Architecture Overview

Monolithic Next.js 16 (App Router, React 19) application with a **custom server** ([server.ts](../server.ts)) that serves both REST API and WebSocket gateway on a single port. Persistence uses SQLite via `better-sqlite3`. A separate **scheduler process** ([scheduler.ts](../scheduler.ts)) runs automation and room orchestration cycles.

**Two communication paths exist:**

- **REST** — `fetch('/api/…')` → `app/api/*/route.ts` (thin wrapper) → `src/server/*/` domain service → SQLite
- **WebSocket** — `GatewayClient` at `/ws` → JSON-RPC frames (`req`/`res`/`event`/`stream`) → `src/server/gateway/methods/` handlers — used for real-time chat streaming, worker status, presence, log subscriptions

## Project Layout

| Path           | Purpose                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app/api/`     | Next.js API routes — validate input, delegate to `src/server/` services                                                                          |
| `src/server/`  | Domain services: `gateway/`, `worker/`, `rooms/`, `channels/`, `personas/`, `skills/`, `model-hub/`, `memory/`, `auth/`, `stats/`, `automation/` |
| `src/modules/` | Frontend feature modules with `hooks/`, `services/`, `components/` — e.g., `app-shell/`, `gateway/`, `chat/`, `worker/`                          |
| `src/shared/`  | Cross-cutting utilities and types — consumed by both `src/modules/` and `src/server/`, never the reverse                                         |
| `components/`  | Presentational React components wired by `App.tsx`                                                                                               |
| `skills/`      | Skill plugins: `browser/`, `filesystem/`, `github-manager/`, `python-runtime/`, `search/`, `shell-access/`, `sql-bridge/`, `vision/`             |
| `tests/`       | `unit/` mirrors `src/server/` structure, `integration/` for route-level tests, `contract/` for API surface stability                             |

## Key Patterns

### API Routes

Export named HTTP handlers (`GET`, `POST`, etc.). Always set `export const runtime = 'nodejs'` for SQLite access. Auth via `resolveRequestUserContext()` from `src/server/auth/userContext.ts`. Return `NextResponse.json({ ok: true, ... })` or `{ ok: false, error }`.

### Repository Singletons

Domain services use lazy singletons — module-level `let _instance` with `getSomeRepository()` factories (e.g., `getWorkerRepository()`, `getSkillRepository()`). For tests, instantiate with `:memory:` SQLite.

### Gateway Methods

Register handlers via `registerMethod('domain.action', handler)` in `src/server/gateway/methods/`. Method names follow `domain.action` convention (e.g., `chat.send`, `worker.submit`, `sessions.delete`). Registration is side-effect-based — importing the file registers the method.

### Path Alias

`@` resolves to project root: `import { ... } from '@/src/server/worker/repository'`.

### ID Generation

Use `createId(prefix)` from `src/shared/lib/` — produces `prefix-timestamp-random` format.

## Development Commands

```bash
npm run dev          # tsx watch server.ts (custom server + WebSocket + Next.js)
npm run dev:next     # Next.js only (no WebSocket gateway)
npm run dev:scheduler # Automation scheduler process
npm run test         # vitest run
npm run test:watch   # vitest (watch mode)
npm run typecheck    # tsc --noEmit
npm run check        # typecheck + lint + format check (full CI gate)
npm run build        # next build (production)
```

## Testing Conventions

- **Framework:** Vitest with `globals: true` — use `describe`/`it`/`expect` without imports
- **File naming:** `*.test.ts` (not `.spec.ts`), kebab-case
- **Repository tests:** instantiate with `:memory:` SQLite in `beforeEach`; use factory helpers like `makeTask(overrides?)`
- **Integration tests:** mock `resolveRequestUserContext` via `vi.mock()` to simulate auth
- **Architectural guard tests** run in CI: `no-explicit-any-guard`, `sqlite-dependency-guard`, `url-parse-deprecation-guard` — these scan source files to enforce invariants
- **Coverage threshold:** 60% (lines, functions, branches, statements)

## Strict Rules

1. **No `any`** — `@typescript-eslint/no-explicit-any: error` is enforced by ESLint AND a guard test that scans the codebase
2. **UI components must not contain infrastructure/execution logic** — business operations live in `src/server/` services
3. **API routes only parse + delegate** — no business logic in route files
4. **`src/shared/` dependency direction** — consumed by `src/modules/` and `src/server/`, never imports from them
5. **No import cycles** — `eslint-plugin-import-x` `no-cycle` is enforced (known runtime singletons are explicitly whitelisted)

## Environment Variables

| Variable                                      | Purpose                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `GEMINI_API_KEY`                              | Required — primary AI provider key                                      |
| `REQUIRE_AUTH`                                | `true` to enforce NextAuth login (default: `false`)                     |
| `NEXTAUTH_SECRET` / `AUTH_SECRET`             | JWT signing secret                                                      |
| `ROOMS_RUNNER`                                | `scheduler` or `server` — controls which process runs room orchestrator |
| `MEMORY_DB_PATH`                              | SQLite path for persistent core memory                                  |
| `GITHUB_TOKEN`                                | Enables authenticated GitHub skill calls                                |
| `SQLITE_DB_PATH`                              | Path for `db_query` skill (read-only)                                   |
| `WHATSAPP_BRIDGE_URL` / `IMESSAGE_BRIDGE_URL` | Channel bridge endpoints                                                |

---

## Superpowers — Development Workflow Skills

> Adapted from [obra/superpowers](https://github.com/obra/superpowers) v4.3 for use with GitHub Copilot in VS Code.
> These skills are **mandatory workflows**, not suggestions. Follow them automatically when the trigger conditions match.

---

### Skill: Brainstorming

**Trigger:** Before ANY creative work — creating features, building components, adding functionality, or modifying behavior.

**HARD GATE:** Do NOT write any code, scaffold any project, or take any implementation action until a design has been presented and the user has approved it. This applies to EVERY project regardless of perceived simplicity.

**Anti-Pattern — "This Is Too Simple To Need A Design":** Every project goes through this process. A todo list, a single-function utility, a config change — all of them. The design can be short (a few sentences for truly simple projects), but you MUST present it and get approval.

**Process (complete in order):**

1. **Explore project context** — check files, docs, recent commits
2. **Ask clarifying questions** — one at a time, understand purpose/constraints/success criteria. Prefer multiple-choice questions. Only one question per message.
3. **Propose 2–3 approaches** — with trade-offs and your recommendation. Lead with your recommended option and explain why.
4. **Present design** — in sections scaled to complexity. Ask after each section whether it looks right. Cover: architecture, components, data flow, error handling, testing.
5. **Write design doc** — save to `docs/plans/YYYY-MM-DD-<topic>-design.md`
6. **Transition to implementation** — invoke Writing Plans skill to create implementation plan

**Key Principles:**

- One question at a time — don't overwhelm
- YAGNI ruthlessly — remove unnecessary features from all designs
- Explore alternatives — always propose 2–3 approaches before settling
- Incremental validation — present design section by section, get approval before moving on

---

### Skill: Writing Plans

**Trigger:** When you have a spec or requirements for a multi-step task, before touching code.

**Overview:** Write comprehensive implementation plans assuming the engineer has zero context. Document everything: which files to touch, complete code, testing approach, how to verify. Give the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Save plans to:** `docs/plans/YYYY-MM-DD-<feature-name>.md`

**Bite-Sized Task Granularity — each step is one action (2–5 minutes):**

- "Write the failing test" — step
- "Run it to make sure it fails" — step
- "Implement the minimal code to make the test pass" — step
- "Run the tests and make sure they pass" — step
- "Commit" — step

**Task Structure:**

```markdown
### Task N: [Component Name]

**Files:**

- Create: `exact/path/to/file.ts`
- Modify: `exact/path/to/existing.ts`
- Test: `tests/exact/path/to/test.ts`

**Step 1: Write the failing test**
[complete test code]

**Step 2: Run test to verify it fails**
Run: `npm test -- path/to/test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**
[complete implementation code]

**Step 4: Run test to verify it passes**
Run: `npm test -- path/to/test.ts`
Expected: PASS

**Step 5: Commit**
```

**Remember:**

- Exact file paths always
- Complete code in plan (not "add validation")
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits

---

### Skill: Executing Plans

**Trigger:** When you have a written implementation plan to execute.

**Overview:** Load plan, review critically, execute tasks in batches, report for review between batches.

**Announce at start:** "I'm using the executing-plans skill to implement this plan."

**Process:**

1. **Load and Review Plan** — Read plan file. Review critically. If concerns: raise them before starting.
2. **Execute Batch** (default: first 3 tasks) — For each task: mark as in-progress, follow each step exactly, run verifications as specified, mark as completed.
3. **Report** — Show what was implemented, show verification output, say: "Ready for feedback."
4. **Continue** — Apply changes if needed, execute next batch, repeat until complete.

**When to STOP and ask:**

- Hit a blocker mid-batch (missing dependency, test fails, instruction unclear)
- Plan has critical gaps
- You don't understand an instruction
- Verification fails repeatedly

**Don't force through blockers** — stop and ask.

---

### Skill: Test-Driven Development (TDD)

**Trigger:** When implementing any feature or bugfix, before writing implementation code.

**Core Principle:** If you didn't watch the test fail, you don't know if it tests the right thing.

**The Iron Law:**

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Write code before the test? Delete it. Start over. No exceptions — don't keep it as "reference", don't "adapt" it.

**Red-Green-Refactor Cycle:**

1. **RED — Write Failing Test:** One minimal test showing what should happen. One behavior, clear name, real code (no mocks unless unavoidable).

2. **Verify RED — Watch It Fail (MANDATORY, never skip):**

   ```bash
   npm test -- path/to/test.test.ts
   ```

   Confirm: test fails (not errors), failure message is expected, fails because feature is missing (not typos). Test passes? You're testing existing behavior — fix test.

3. **GREEN — Minimal Code:** Write simplest code to pass the test. Don't add features, refactor other code, or "improve" beyond the test.

4. **Verify GREEN — Watch It Pass (MANDATORY):**

   ```bash
   npm test -- path/to/test.test.ts
   ```

   Confirm: test passes, other tests still pass, output pristine. Test fails? Fix code, not test.

5. **REFACTOR — Clean Up:** After green only. Remove duplication, improve names, extract helpers. Keep tests green. Don't add behavior.

6. **Repeat:** Next failing test for next feature.

**Good Tests:**

| Quality      | Good                                | Bad                                                 |
| ------------ | ----------------------------------- | --------------------------------------------------- |
| Minimal      | One thing. "and" in name? Split it. | `test('validates email and domain and whitespace')` |
| Clear        | Name describes behavior             | `test('test1')`                                     |
| Shows intent | Demonstrates desired API            | Obscures what code should do                        |

**Red Flags — STOP and Start Over:**

- Code before test
- Test passes immediately
- Can't explain why test failed
- Rationalizing "just this once"
- "I already manually tested it"

**Verification Checklist (before marking work complete):**

- [ ] Every new function/method has a test
- [ ] Watched each test fail before implementing
- [ ] Wrote minimal code to pass each test
- [ ] All tests pass
- [ ] Output pristine (no errors, warnings)
- [ ] Tests use real code (mocks only if unavoidable)
- [ ] Edge cases and errors covered

---

### Skill: Systematic Debugging

**Trigger:** When encountering any bug, test failure, or unexpected behavior — before proposing fixes.

**Core Principle:** ALWAYS find root cause before attempting fixes. Symptom fixes are failure.

**The Iron Law:**

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

**The Four Phases (complete each before proceeding):**

#### Phase 1: Root Cause Investigation

1. **Read Error Messages Carefully** — Don't skip past errors/warnings. Read stack traces completely. Note line numbers, file paths, error codes.
2. **Reproduce Consistently** — Can you trigger it reliably? What are the exact steps? If not reproducible → gather more data, don't guess.
3. **Check Recent Changes** — Git diff, recent commits, new dependencies, config changes, environmental differences.
4. **Gather Evidence in Multi-Component Systems** — Before proposing fixes, add diagnostic instrumentation at each component boundary.
5. **Trace Data Flow** — Where does bad value originate? What called this with bad value? Keep tracing up until you find the source. Fix at source, not at symptom.

#### Phase 2: Pattern Analysis

1. **Find Working Examples** — Locate similar working code in same codebase.
2. **Compare Against References** — Read reference implementation COMPLETELY. Don't skim.
3. **Identify Differences** — List every difference between working and broken, however small.
4. **Understand Dependencies** — What other components, settings, config, environment does this need?

#### Phase 3: Hypothesis and Testing

1. **Form Single Hypothesis** — "I think X is the root cause because Y" — be specific.
2. **Test Minimally** — SMALLEST possible change. One variable at a time. Don't fix multiple things at once.
3. **Verify Before Continuing** — Worked? → Phase 4. Didn't work? → NEW hypothesis. Don't add more fixes on top.

#### Phase 4: Implementation

1. **Create Failing Test Case** — MUST have before fixing.
2. **Implement Single Fix** — Address root cause. ONE change at a time. No "while I'm here" improvements.
3. **Verify Fix** — Test passes? No other tests broken? Issue actually resolved?
4. **If 3+ Fixes Failed → Question Architecture** — Each fix reveals new problem in different place? STOP. Discuss with user before attempting more fixes.

**Red Flags — STOP and Return to Phase 1:**

- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- Proposing solutions before tracing data flow

---

### Skill: Verification Before Completion

**Trigger:** Before claiming ANY work is complete, fixed, or passing. Before committing or creating PRs.

**Core Principle:** Evidence before claims, always.

**The Iron Law:**

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

**The Gate Function:**

1. **IDENTIFY:** What command proves this claim?
2. **RUN:** Execute the FULL command (fresh, complete)
3. **READ:** Full output, check exit code, count failures
4. **VERIFY:** Does output confirm the claim?
   - If NO → state actual status with evidence
   - If YES → state claim WITH evidence
5. **ONLY THEN:** Make the claim

**Common Failures:**

| Claim          | Requires                        | Not Sufficient                 |
| -------------- | ------------------------------- | ------------------------------ |
| Tests pass     | Test command output: 0 failures | Previous run, "should pass"    |
| Linter clean   | Linter output: 0 errors         | Partial check, extrapolation   |
| Build succeeds | Build command: exit 0           | Linter passing, logs look good |
| Bug fixed      | Original symptom test: passes   | Code changed, assumed fixed    |

**Red Flags — STOP:**

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!")
- About to commit/push/PR without verification
- Relying on partial verification
- ANY wording implying success without having run verification

**The Bottom Line:** Run the command. Read the output. THEN claim the result. Non-negotiable.
