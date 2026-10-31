# E2E Triage Runbook

## 1. Determine failing lane

- Smoke: `pnpm run test:e2e:smoke`
- Browser: `pnpm run test:e2e:browser`
- Live: `pnpm run test:e2e:live`

## 2. Fast local reproduction

- Re-run only failed test file with exact command from CI output.
- For browser failures, inspect `test-results/` and Playwright trace.

## 3. Common root-cause checks

- Runtime bootstrap failed (health endpoint not reachable)
- Missing `MODEL_HUB_TEST_MODE=1` in E2E server bootstrap
- Missing test selectors (`data-testid`) after UI refactor
- Live lane env missing (`MEM0_BASE_URL`, `MEM0_API_KEY`)
- Smoke and browser fixtures use mocked Mem0 and explicitly disable World Model mode,
  its legacy enable flag, and ingestion bridge. Local canonical settings must not
  make these lanes connect to PostgreSQL. Run the PostgreSQL integration lane separately.
- Keep `TEST_ARTIFACTS_ROOT` inside the workspace under `.local/test-artifacts`.
  SQL and external-skill fixtures enforce the workspace boundary. Concurrent runs
  need separate child directories so cleanup cannot remove another run's fixtures.
- On Windows, bind-mounted source can cause import and repository-scan timeouts.
  Reproduce using the same working-tree files in the container filesystem before
  changing application code or test timeouts.
- Graphiti live tests require its configured Model-Hub adapter to be running;
  Graphiti's health endpoint alone does not verify that the adapter is reachable.

## 4. Decision

- Deterministic bug: fix immediately and add/adjust regression test.
- Environment-only issue in live lane: keep lane skipped until secrets/config are present.
- Flaky behavior: stabilize timing/await points, then keep retries minimal.
