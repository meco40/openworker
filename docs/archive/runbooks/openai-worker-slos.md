# OpenAI Worker SLOs

## Service Objectives

- Availability: 99.5% monthly for run start/resume endpoints.
- Run completion latency: P95 under 120s for standard tasks.
- Approval waiting latency: P95 under 120s.
- Event integrity: duplicate/out-of-order rejection under 0.1%.
- Failover recovery: legacy runtime fallback in under 5 minutes.

## Key Metrics

- `worker_run_duration_ms`
- `worker_approval_wait_ms`
- `worker_event_duplicate_total`
- `worker_run_fail_total`

## Alert Thresholds

- Failure rate > 5% over 10m.
- Approval P95 > 180s over 15m.
- Duplicate event rate > 0.5% over 10m.
- Queue depth > configured maxQueueDepth for 5m.
