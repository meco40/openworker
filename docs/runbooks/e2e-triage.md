# E2E Triage Runbook

## 1. Determine failing lane

- Smoke: `npm run test:e2e:smoke`
- Browser: `npm run test:e2e:browser`
- Live: `npm run test:e2e:live`

## 2. Fast local reproduction

- Re-run only failed test file with exact command from CI output.
- For browser failures, inspect `test-results/` and Playwright trace.

## 3. Common root-cause checks

- Runtime bootstrap failed (health endpoint not reachable)
- Missing `MODEL_HUB_TEST_MODE=1` in E2E server bootstrap
- Missing test selectors (`data-testid`) after UI refactor
- Live lane env missing (`MEM0_BASE_URL`, `MEM0_API_KEY`)

## 4. Decision

- Deterministic bug: fix immediately and add/adjust regression test.
- Environment-only issue in live lane: keep lane skipped until secrets/config are present.
- Flaky behavior: stabilize timing/await points, then keep retries minimal.
