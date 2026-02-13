# Gateway Config Production Rollout

## Pre-Deploy Checks

1. Run lint for all config-related files.
2. Run unit and integration tests for config route, concurrency, rollback, and editor behavior.
3. Verify `/api/config` responses do not include absolute filesystem paths.
4. Verify secret fields are masked in GET payloads.

## Rollout Strategy

1. Deploy behind feature flag `OPENCLAW_CONFIG_REVISION_ENFORCED=true` in staging first.
2. Run canary on 10% of sessions for 30 minutes.
3. Monitor conflict (`409`) rate and save failure rates.
4. Roll out to 100% if conflict rate remains stable.

## Rollback Strategy

1. Disable revision enforcement feature flag.
2. Redeploy previous build.
3. Restore latest backup file (`openclaw.json.bak`) if config corruption is suspected.

## Incident Triage

1. Conflict spike: verify clients send latest revision from GET before PUT.
2. Save failures: inspect `config.save.failed` events.
3. Unexpected value loss: confirm redaction placeholder restoration path in save handler.
4. Invalid load warnings: confirm optional UI fallback warnings are emitted and visible.

## Manual UX Checklist

1. First-time flow: edit network setting, open diff, apply successfully.
2. Conflict flow: simulate stale revision and recover with reload.
3. Keyboard-only flow: tab navigation reaches controls and apply preview.
4. Invalid optional UI value in config file: page still loads with warning.
