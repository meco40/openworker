# Copilot Instructions — BetaClaw Gateway Control Plane

## Architecture Overview

Rust backend plus a Next.js 16 (React 19) UI. The Rust gateway (`rust/crates/betaclaw-gateway`, binary `betaclaw-gateway`) owns the port: it answers every `/api/*` route, terminates the WebSocket gateway at `/ws`, and serves the UI as a static export (`out/`, `pnpm run build:export`). In development (`pnpm run dev`) it reverse proxies UI pages and HMR to the Next dev server on port 3001. A separate Rust scheduler (`betaclaw-scheduler`) runs automation, knowledge ingestion, outbox and the World-Model workers, and carries the ops subcommands (`migrate`, `verify-rls`, `backfill`, …). Persistence: SQLite per domain and PostgreSQL for the World Model. The TypeScript backend is removed (tag `legacy-ts-backend`).

**Two communication paths exist:**

- **REST** — `fetch('/api/…')` → Rust route in `rust/crates/betaclaw-gateway/src/routes` or `src/families` → domain crate
- **WebSocket** — `GatewayClient` at `/ws` → JSON frames (`req`/`res`/`event`/`stream`, protocol `v2`) → `families/ws_wire` handlers — chat streaming, worker status, presence, log subscriptions

## Project Layout

| Path                     | Purpose                                                                                                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rust/crates/betaclaw-*` | Backend crates (base, model-hub, store, world-model, memory, knowledge, skills, channels, master, features); `betaclaw-core` re-exports them, `betaclaw-gateway` holds routes, WS, scheduler binary |
| `src/modules/`           | Frontend feature modules with `hooks/`, `services/`, `components/`                                                                                                                                  |
| `src/shared/`            | Types and utilities shared by UI and CLI, including the gateway protocol (`src/shared/gateway`)                                                                                                     |
| `src/cli/`               | CLI programs talking to the gateway over HTTP/WS                                                                                                                                                    |
| `components/`            | Presentational React components                                                                                                                                                                     |
| `tests/`                 | Vitest for UI, shared, CLI and scripts; `e2e/` runs against the Rust gateway                                                                                                                        |
| `scripts/verify/parity/` | Parity suite: Rust responses against fixed golden files                                                                                                                                             |

## Key Patterns

### Backend changes

Change the Rust crate that owns the domain. Behaviour is defined by Rust tests, the parity golden files, the E2E lanes and the production smoke. See `AGENTS.md` (Rust backend rules) for crate layering and gates.

### Path Alias

`@` resolves to `src`: `import { ... } from '@/shared/gateway/protocol'`.

### ID Generation

Use `createId(prefix)` from `src/shared/lib/` — produces `prefix-timestamp-random` format.

## Development Commands

```bash
pnpm run dev          # Rust gateway + Rust scheduler + Next dev server (proxy mode)
pnpm run dev:static   # Rust gateway serving the static export
pnpm run test         # vitest run
pnpm run typecheck    # tsc --noEmit
pnpm run check        # typecheck + lint + format check
pnpm run rust:check   # host cargo check over all crates
pnpm run rust:test    # Rust tests in the pinned container
```

## Testing Conventions

- **Framework:** Vitest with `globals: true` — use `describe`/`it`/`expect` without imports
- **File naming:** `*.test.ts` (not `.spec.ts`), kebab-case
- **Backend behaviour** is tested in Rust (`#[test]`/`#[tokio::test]` next to the code), not in Vitest
- **Coverage threshold:** 70 % (`pnpm run test:coverage`)

## Strict Rules

1. **No `any`** — enforced by the linter and a guard test
2. **UI components must not contain infrastructure/execution logic** — business operations live in the Rust backend
3. **`src/shared/` dependency direction** — consumed by `src/modules/` and `src/cli/`, never imports from them
4. **No import cycles**

## Environment Variables

| Variable                                      | Purpose                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `GEMINI_API_KEY`                              | Required — primary AI provider key                                      |
| `REQUIRE_AUTH`                                | `true` to enforce login (default `false`: loopback-only anonymous)      |
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
