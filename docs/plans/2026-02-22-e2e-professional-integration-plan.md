# Professional E2E Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a professional, broad E2E test system that validates critical user flows across gateway, web UI, memory, and tool execution with clear CI gates.

**Architecture:** Introduce a layered E2E strategy with three lanes: fast deterministic runtime E2E (Vitest + real server), browser journey E2E (Playwright), and optional live dependency E2E (mem0/external APIs) gated by env flags. Add a shared E2E harness for server lifecycle, data seeding, deterministic model responses, and robust teardown to reduce flakes.

**Tech Stack:** Node 22, TypeScript, Vitest 4, ws, Playwright, Docker Compose, GitHub Actions.

---

## Scope and Acceptance Criteria

- E2E suite is split into `smoke`, `browser`, and `live` lanes.
- At least 8 critical end-to-end scenarios are covered (gateway stream, abort, persona binding, queue, file upload validation, tool invocation, memory lifecycle, reconnect).
- CI runs deterministic E2E smoke on every PR; browser lane runs on main and workflow dispatch; live lane runs only with explicit secrets/flags.
- Local developer run is one-command reproducible in container-first mode.
- Flaky-test policy exists (retry policy, diagnostics artifacts, quarantine workflow).

---

### Task 1: Establish E2E Suite Topology and Commands

**Files:**
- Create: `vitest.e2e.config.ts`
- Create: `vitest.e2e.live.config.ts`
- Modify: `package.json`
- Test: `tests/unit/testing/e2e-config-contract.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import e2eConfig from '../../../vitest.e2e.config';
import liveConfig from '../../../vitest.e2e.live.config';

describe('e2e vitest configs', () => {
  it('targets only tests/e2e lane files', () => {
    expect(e2eConfig.test?.include).toEqual(['tests/e2e/**/*.e2e.test.ts']);
  });

  it('keeps live lane opt-in and isolated', () => {
    expect(liveConfig.test?.include).toEqual(['tests/e2e/**/*.live.e2e.test.ts']);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- tests/unit/testing/e2e-config-contract.test.ts`
Expected: FAIL (`Cannot find module 'vitest.e2e.config'`)

**Step 3: Write minimal implementation**

```ts
// vitest.e2e.config.ts
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/e2e/**/*.e2e.test.ts'],
    exclude: ['tests/e2e/**/*.live.e2e.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    retry: 1,
    maxWorkers: 1,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
```

```ts
// vitest.e2e.live.config.ts
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/e2e/**/*.live.e2e.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 90_000,
    maxWorkers: 1,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
```

```json
// package.json (scripts excerpt)
{
  "scripts": {
    "test:e2e:smoke": "vitest run --config vitest.e2e.config.ts",
    "test:e2e:live": "vitest run --config vitest.e2e.live.config.ts",
    "test:e2e": "npm run test:e2e:smoke"
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test -- tests/unit/testing/e2e-config-contract.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add vitest.e2e.config.ts vitest.e2e.live.config.ts package.json tests/unit/testing/e2e-config-contract.test.ts
git commit -m "test: establish dedicated e2e lane configs and scripts"
```

---

### Task 2: Build Shared E2E Harness for Real Server Lifecycle

**Files:**
- Create: `tests/e2e/_shared/managedServer.ts`
- Create: `tests/e2e/_shared/waitForHealth.ts`
- Create: `tests/e2e/_shared/wsRpcClient.ts`
- Test: `tests/e2e/chat/gateway-connectivity.e2e.test.ts`

**Step 1: Write the failing test**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManagedServer } from '../_shared/managedServer';
import { createWsRpcClient } from '../_shared/wsRpcClient';

describe('gateway connectivity e2e', () => {
  const server = new ManagedServer();

  beforeAll(async () => {
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('connects to /ws and receives responses', async () => {
    const client = await createWsRpcClient(server.wsUrl());
    const res = await client.request('ping', {});
    expect(res.type).toBe('res');
    await client.close();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test:e2e:smoke -- tests/e2e/chat/gateway-connectivity.e2e.test.ts`
Expected: FAIL (missing harness modules)

**Step 3: Write minimal implementation**

```ts
// tests/e2e/_shared/managedServer.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { waitForHealth } from './waitForHealth';

export class ManagedServer {
  private child: ChildProcess | null = null;
  private port = 3210;

  async start(): Promise<void> {
    this.child = spawn('node', ['--import', 'tsx', 'server.ts'], {
      env: { ...process.env, PORT: String(this.port), NODE_ENV: 'test' },
      stdio: 'pipe',
    });
    await waitForHealth(`http://127.0.0.1:${this.port}/api/health`);
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    this.child.kill('SIGTERM');
    this.child = null;
  }

  wsUrl(): string {
    return `ws://127.0.0.1:${this.port}/ws`;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test:e2e:smoke -- tests/e2e/chat/gateway-connectivity.e2e.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/e2e/_shared/managedServer.ts tests/e2e/_shared/waitForHealth.ts tests/e2e/_shared/wsRpcClient.ts tests/e2e/chat/gateway-connectivity.e2e.test.ts
git commit -m "test: add shared e2e harness for managed server and ws rpc"
```

---

### Task 3: Add Deterministic Runtime E2E for Critical Chat Gateway Flows

**Files:**
- Create: `tests/e2e/chat/ws-chat-stream-core.e2e.test.ts`
- Create: `tests/e2e/chat/ws-chat-abort.e2e.test.ts`
- Create: `tests/e2e/chat/ws-chat-reconnect-sync.e2e.test.ts`
- Modify: `src/server/model-hub/runtime.ts`
- Modify: `src/server/model-hub/Models/index.ts`

**Step 1: Write the failing test**

```ts
it('streams chat response end-to-end and closes with done frame', async () => {
  const client = await createWsRpcClient(server.wsUrl());
  const frames = await client.stream('chat.stream', {
    content: 'Smoke stream',
    personaId: 'persona-nexus',
  });

  expect(frames.some((frame) => frame.type === 'stream' && frame.done === true)).toBe(true);
  await client.close();
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test:e2e:smoke -- tests/e2e/chat/ws-chat-stream-core.e2e.test.ts`
Expected: FAIL due nondeterministic provider or missing test provider hook

**Step 3: Write minimal implementation**

```ts
// src/server/model-hub/runtime.ts (excerpt)
const testMode = String(process.env.MODEL_HUB_TEST_MODE || '').trim() === '1';

if (testMode) {
  return {
    dispatchWithFallback: async () => ({
      ok: true,
      provider: 'test-fixture',
      model: 'fixture',
      text: '[fixture-response]',
    }),
  };
}
```

**Step 4: Add the remaining failing chat-flow tests and make them pass**

- `ws-chat-abort.e2e.test.ts`: verifies `chat.abort` interrupts an in-flight stream.
- `ws-chat-reconnect-sync.e2e.test.ts`: verifies reconnect path reloads conversation history.

Run each test first (RED), then implement smallest runtime changes (GREEN).

**Step 5: Run lane verification**

Run: `npm run test:e2e:smoke -- tests/e2e/chat/ws-chat-stream-core.e2e.test.ts tests/e2e/chat/ws-chat-abort.e2e.test.ts tests/e2e/chat/ws-chat-reconnect-sync.e2e.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/server/model-hub/runtime.ts src/server/model-hub/Models/index.ts tests/e2e/chat/ws-chat-stream-core.e2e.test.ts tests/e2e/chat/ws-chat-abort.e2e.test.ts tests/e2e/chat/ws-chat-reconnect-sync.e2e.test.ts
git commit -m "test: add deterministic runtime e2e coverage for gateway chat flows"
```

---

### Task 4: Expand Tool and Persona End-to-End Coverage

**Files:**
- Modify: `tests/e2e/chat/webui-nexus-chat-stream-tools.e2e.test.ts`
- Create: `tests/e2e/chat/ws-persona-stickiness.e2e.test.ts`
- Create: `tests/e2e/chat/ws-multi-tool-use-parallel.e2e.test.ts`

**Step 1: Write failing persona stickiness test**

```ts
it('keeps queued message persona binding after active persona switch', async () => {
  const client = await createWsRpcClient(server.wsUrl());
  // queue/send flow, then switch persona, then assert stored conversation persona binding
  expect(finalPersonaId).toBe('persona-nexus');
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test:e2e:smoke -- tests/e2e/chat/ws-persona-stickiness.e2e.test.ts`
Expected: FAIL (contract gap visible if regression exists)

**Step 3: Extend existing tool e2e to include multi-tool wrapper contract**

```ts
expect(toolResultText).toContain('successCount');
expect(toolResultText).toContain('parallel-nexus');
```

**Step 4: Run lane verification**

Run: `npm run test:e2e:smoke -- tests/e2e/chat/webui-nexus-chat-stream-tools.e2e.test.ts tests/e2e/chat/ws-persona-stickiness.e2e.test.ts tests/e2e/chat/ws-multi-tool-use-parallel.e2e.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/e2e/chat/webui-nexus-chat-stream-tools.e2e.test.ts tests/e2e/chat/ws-persona-stickiness.e2e.test.ts tests/e2e/chat/ws-multi-tool-use-parallel.e2e.test.ts
git commit -m "test: broaden persona and tool end-to-end coverage"
```

---

### Task 5: Introduce Browser Journey E2E with Playwright

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/browser/chat-smoke.spec.ts`
- Create: `tests/e2e/browser/chat-queue-and-persona.spec.ts`
- Modify: `package.json`
- Modify: `src/modules/chat/components/ChatInputArea.tsx`
- Modify: `src/modules/chat/components/ChatMainPane.tsx`

**Step 1: Write failing browser smoke spec**

```ts
import { test, expect } from '@playwright/test';

test('user can send message and receive stream completion marker', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('chat-input').fill('Hallo Nexus');
  await page.getByTestId('chat-send-button').click();
  await expect(page.getByTestId('chat-message-agent').last()).toContainText(/nexus|fixture/i);
});
```

**Step 2: Run test to verify it fails**

Run: `npx playwright test tests/e2e/browser/chat-smoke.spec.ts`
Expected: FAIL (`data-testid` selectors missing / setup missing)

**Step 3: Write minimal implementation**

- Add stable `data-testid` attributes in chat UI components.
- Add Playwright config with `webServer` boot command and retries.

```ts
// playwright.config.ts (excerpt)
export default defineConfig({
  testDir: 'tests/e2e/browser',
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: 'http://127.0.0.1:3000' },
  webServer: {
    command: 'node --import tsx server.ts',
    url: 'http://127.0.0.1:3000/api/health',
    reuseExistingServer: !process.env.CI,
  },
});
```

**Step 4: Run tests to verify they pass**

Run: `npx playwright test tests/e2e/browser/chat-smoke.spec.ts tests/e2e/browser/chat-queue-and-persona.spec.ts`
Expected: PASS

**Step 5: Wire npm scripts and commit**

```json
{
  "scripts": {
    "test:e2e:browser": "playwright test"
  }
}
```

```bash
git add playwright.config.ts package.json src/modules/chat/components/ChatInputArea.tsx src/modules/chat/components/ChatMainPane.tsx tests/e2e/browser/chat-smoke.spec.ts tests/e2e/browser/chat-queue-and-persona.spec.ts
git commit -m "test: add browser journey e2e lane with playwright"
```

---

### Task 6: Harden Live Dependency E2E Lane

**Files:**
- Move: `tests/e2e/memory/mem0-live.e2e.test.ts` -> `tests/e2e/memory/mem0.live.e2e.test.ts`
- Create: `scripts/e2e/live-preflight.ts`
- Modify: `package.json`
- Test: `tests/unit/scripts/e2e-live-preflight.test.ts`

**Step 1: Write failing preflight unit test**

```ts
it('fails fast when MEM0_E2E is enabled but mandatory env vars are missing', async () => {
  const result = await runPreflight({ MEM0_E2E: '1', MEM0_BASE_URL: '', MEM0_API_KEY: '' });
  expect(result.ok).toBe(false);
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- tests/unit/scripts/e2e-live-preflight.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

```ts
// scripts/e2e/live-preflight.ts (excerpt)
const required = ['MEM0_BASE_URL', 'MEM0_API_KEY'];
const missing = required.filter((name) => !String(process.env[name] || '').trim());
if (String(process.env.MEM0_E2E || '') === '1' && missing.length > 0) {
  console.error(`Missing env for live e2e: ${missing.join(', ')}`);
  process.exit(1);
}
```

**Step 4: Run tests to verify pass**

Run: `npm run test -- tests/unit/scripts/e2e-live-preflight.test.ts`
Expected: PASS

**Step 5: Wire live script and commit**

```json
{
  "scripts": {
    "test:e2e:live": "node --import tsx scripts/e2e/live-preflight.ts && vitest run --config vitest.e2e.live.config.ts"
  }
}
```

```bash
git add tests/e2e/memory/mem0.live.e2e.test.ts scripts/e2e/live-preflight.ts package.json tests/unit/scripts/e2e-live-preflight.test.ts
git commit -m "test: gate live e2e lane with explicit preflight"
```

---

### Task 7: Container-First E2E Execution Path

**Files:**
- Create: `docker-compose.e2e.yml`
- Create: `scripts/e2e/run-smoke-in-container.sh`
- Create: `scripts/e2e/run-browser-in-container.sh`
- Modify: `README.md`

**Step 1: Write failing smoke execution check**

```bash
bash scripts/e2e/run-smoke-in-container.sh
```

Expected: FAIL (script/compose file absent)

**Step 2: Write minimal implementation**

```yaml
# docker-compose.e2e.yml (excerpt)
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      NODE_ENV: test
      MODEL_HUB_TEST_MODE: '1'
    command: ['node', '--import', 'tsx', 'server.ts']

  e2e:
    image: node:22-alpine
    working_dir: /workspace
    volumes:
      - ./:/workspace
    command: ['sh', '-lc', 'npm ci && npm run test:e2e:smoke']
    depends_on:
      - app
```

**Step 3: Run smoke container command to verify pass**

Run: `docker compose -f docker-compose.e2e.yml run --rm e2e`
Expected: PASS

**Step 4: Commit**

```bash
git add docker-compose.e2e.yml scripts/e2e/run-smoke-in-container.sh scripts/e2e/run-browser-in-container.sh README.md
git commit -m "chore: add container-first e2e execution workflows"
```

---

### Task 8: CI Integration, Artifacts, and Policy Gates

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/e2e-browser.yml`
- Create: `.github/workflows/e2e-live.yml`
- Create: `docs/testing/E2E_STRATEGY.md`
- Create: `docs/runbooks/e2e-triage.md`

**Step 1: Write failing workflow contract test**

```ts
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('ci workflow e2e gates', () => {
  it('runs deterministic e2e smoke on pull requests', () => {
    const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain('npm run test:e2e:smoke');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- tests/unit/ci/e2e-workflow-contract.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

- Add `e2e-smoke` job to PR `ci.yml` after unit/integration lane.
- Add `e2e-browser.yml` on `push main` + `workflow_dispatch` (artifact upload: traces, screenshots).
- Add `e2e-live.yml` on schedule/manual only; skip when secrets missing.
- Document flake policy and quarantine process in `docs/testing/E2E_STRATEGY.md` and runbook.

**Step 4: Run workflow contract test to verify pass**

Run: `npm run test -- tests/unit/ci/e2e-workflow-contract.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/e2e-browser.yml .github/workflows/e2e-live.yml docs/testing/E2E_STRATEGY.md docs/runbooks/e2e-triage.md tests/unit/ci/e2e-workflow-contract.test.ts
git commit -m "ci: integrate multi-lane e2e gates and triage docs"
```

---

## Final Verification Gate (Must Pass)

Run in this exact order:

```bash
npm run typecheck
npm run lint
npm run test:e2e:smoke
npm run test:e2e:browser
npm run test:e2e:live
npm run test
npm run build
```

Expected:
- All commands exit 0.
- Browser lane emits Playwright artifacts for failed tests in CI.
- Live lane is skipped cleanly when env is absent, and fails fast with clear preflight reason when explicitly enabled without required vars.

---

## Rollout Sequence

1. Land Tasks 1-4 first (deterministic runtime E2E base).
2. Land Task 5 (browser lane) in a separate PR if dependency footprint review is required.
3. Land Tasks 6-8 with CI policy and docs after first green week of runtime/browser lanes.

---

Plan complete and saved to `docs/plans/2026-02-22-e2e-professional-integration-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
