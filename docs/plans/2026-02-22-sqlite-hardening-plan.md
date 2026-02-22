# SQLite Runtime Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Introduce a centralized SQLite initialization layer with consistent production-safe PRAGMA policy and migrate all `better-sqlite3` callers to it.

**Architecture:** Add `src/server/db/sqlite.ts` as the single entry point for opening SQLite databases. The module resolves paths, enforces consistent defaults (WAL where valid, `busy_timeout`, `foreign_keys`, `synchronous`), and supports safe readonly/memory variants. Repositories/services keep their current singleton ownership model but no longer instantiate/configure SQLite directly.

**Tech Stack:** TypeScript, `better-sqlite3`, Vitest, Next.js runtime modules.

---

### Task 1: Add failing tests for centralized SQLite behavior

**Files:**

- Create: `tests/unit/server/sqlite.test.ts`
- Reference: `src/server/db/sqlite.ts`

**Step 1: Write failing test for read-write file DB defaults**

- Assert a new helper can open file DB and apply:
  - `journal_mode = WAL`
  - `busy_timeout = 5000`
  - `foreign_keys = ON`
  - `synchronous = NORMAL`

**Step 2: Run test to verify RED**

- Run: `npm test -- tests/unit/server/sqlite.test.ts`
- Expected: fail because helper module does not exist yet.

**Step 3: Add failing test for readonly open safety**

- Create a DB file in write mode, close it, reopen readonly via helper.
- Assert open/query works without throwing and no write-only PRAGMA path is required.

**Step 4: Add failing test for `:memory:` handling**

- Open in-memory DB via helper.
- Assert no exception and basic operation works.

**Step 5: Re-run tests**

- Run: `npm test -- tests/unit/server/sqlite.test.ts`
- Expected: still failing until helper implementation exists.

### Task 2: Implement central SQLite helper

**Files:**

- Create: `src/server/db/sqlite.ts`

**Step 1: Implement options + path resolution**

- Add typed options for `dbPath`, `readonly`, `busyTimeoutMs`, `enableWal`, `enableForeignKeys`, `synchronous`.
- Resolve filesystem paths for file DBs and ensure parent directory for writable DB.

**Step 2: Implement DB open routine**

- Create `openSqliteDatabase(options)` to instantiate `better-sqlite3` with readonly mode when requested.

**Step 3: Implement PRAGMA policy application**

- Add `applySqlitePragmas(db, options)` with safe defaults:
  - always `busy_timeout`
  - always `foreign_keys = ON` unless disabled
  - `synchronous = NORMAL` default
  - `journal_mode = WAL` only for writable non-memory DBs

**Step 4: Re-run tests to GREEN**

- Run: `npm test -- tests/unit/server/sqlite.test.ts`
- Expected: pass.

### Task 3: Migrate all runtime callers to centralized helper

**Files (modify):**

- `src/server/channels/messages/sqliteMessageRepository.ts`
- `src/server/knowledge/sqliteKnowledgeRepository.ts`
- `src/server/automation/sqliteAutomationRepository.ts`
- `src/server/personas/personaRepository.ts`
- `src/server/channels/credentials/credentialStore.ts`
- `src/server/memory/sqliteMemoryRepository.ts`
- `src/server/model-hub/repositories/sqliteModelHubRepository.ts`
- `src/server/stats/tokenUsageRepository.ts`
- `src/server/stats/promptDispatchRepository.ts`
- `src/server/skills/skillRepository.ts`
- `src/server/skills/runtimeConfig.ts`
- `src/server/proactive/sqliteProactiveRepository.ts`
- `src/server/clawhub/clawhubRepository.ts`
- `src/server/telegram/personaTelegramBotRegistry.ts`
- `src/server/auth/userStore.ts`
- `src/logging/logRepository.ts`
- `src/server/config/gatewayConfig.ts`
- `src/server/skills/handlers/dbQuery.ts`

**Step 1: Replace direct constructor usage**

- Import `openSqliteDatabase` in each file and replace `new BetterSqlite3(...)`.

**Step 2: Remove duplicated PRAGMA setup**

- Delete local `journal_mode`/`busy_timeout`/`foreign_keys` setup when now redundant.

**Step 3: Preserve special modes**

- For `dbQuery` readonly handler, call helper with `readonly: true`.
- Keep in-memory semantics for tests (`:memory:`) unchanged.

**Step 4: Run targeted regression tests**

- Run:
  - `npm test -- tests/unit/channels/messages-runtime.test.ts`
  - `npm test -- tests/channels-pair-route.test.ts tests/unit/channels/telegram-pairing-poll-route.test.ts tests/unit/channels/health-monitor.test.ts`
  - `npm test -- tests/unit/automation`

### Task 4: Verify production readiness

**Files:**

- No code changes expected unless regressions found.

**Step 1: Type safety**

- Run: `npm run typecheck`

**Step 2: Lint**

- Run: `npm run lint`

**Step 3: Build**

- Run: `npm run build`

**Step 4: Final status + continuity**

- Update `.agent/CONTINUITY.md` with:
  - discovery (inconsistent PRAGMA state fixed),
  - decisions (centralized helper, readonly/memory behavior),
  - outcomes (verification commands and results).
