# E2E Strategy

## Lanes

- `smoke`: deterministic runtime E2E (`npm run test:e2e:smoke`) with local mocks and no external dependencies.
- `browser`: Playwright user-journey tests (`npm run test:e2e:browser`) against a local E2E server bootstrap.
- `live`: external dependency checks (`npm run test:e2e:live`) gated by `MEM0_E2E=1` and preflight checks.

## CI Policy

- PR gate: `ci.yml` always runs `test:e2e:smoke`.
- Main branch: `e2e-browser.yml` runs browser lane and uploads artifacts.
- Scheduled/manual: `e2e-live.yml` runs live lane only when required secrets exist.

## Flake Policy

- Smoke/browser lanes use single worker and retries for deterministic stability.
- Any flaky test must be isolated and fixed before enabling broader matrix parallelism.
- Browser lane stores trace/video/screenshot artifacts for triage.
