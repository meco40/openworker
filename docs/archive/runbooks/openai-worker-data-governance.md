# OpenAI Worker Data Governance

## Redaction

- Redact emails and token-like values before writing logs/telemetry.
- Never persist full bearer/API tokens.

## Retention

- Checkpoints/events: enforce TTL cleanup job.
- Remove expired operational data on schedule.

## Deletion Workflow

- On task/session delete, purge:
  - sidecar checkpoints
  - event snapshots
  - transient approval artifacts

## MCP / Computer Use Controls

- MCP servers must be allowlisted.
- Computer Use can be globally disabled.
- Destructive Computer Use actions require explicit HITL approval.
