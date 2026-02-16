# OpenAI Worker Rollout

## Rollout Phases

1. Shadow mode (24h)
2. Canary at 10%
3. Gradual ramp (25% -> 50% -> 100%)

## Preconditions

- Final verification gate fully green
- SLO dashboards active
- Rollback drill validated

## Canary Exit Criteria

- Failure rate not worse than legacy by more than +1%
- Duplicate/out-of-order event rejection under 0.1%
- Budget and rate-limits enforced without queue collapse

## Rollback Procedure

1. Set `WORKER_RUNTIME=legacy`
2. Restart gateway
3. Confirm new tasks route to legacy runtime
4. Investigate sidecar issue offline
