# Agent Harness v2.1 Runbook

## Runtime selector / rollback

- v2 transport endpoint: `/ws?protocol=v2`
- v1 transport endpoint: `/ws?protocol=v1` (or `/ws` without query)
- rollback strategy: switch clients to protocol `v1` via query param and stop using `agent.v2.*` methods.
- database schema rollback is not required (all changes are additive).

## Mandatory SLOs

- P95 command latency (`agent.v2.command.started` -> `agent.v2.command.completed`)
- replay success rate (`agent.v2.session.replay` success / attempts)
- hook timeout rate (`agent.v2.error` with `errorCode=HOOK_FAILED` and timeout message)
- queue depth per session (`session.queueDepth`)

## Alert thresholds

- queue depth exceeds `AGENT_V2_MAX_QUEUE_PER_SESSION` for any hot session
- replay failures increase (`REPLAY_WINDOW_EXPIRED` spike or transport errors)
- signature validation failures during extension load
- worker hook crash/timeout trend increases

## Startup recovery policy

- on process boot, all `running` commands are marked `failed_recoverable`
- related sessions are moved to `error_recoverable`
- no automatic rerun is performed
- recovery continuation is explicit via `agent.v2.session.follow_up` or `agent.v2.session.input`

## Replay and gap handling

- raw event replay window is 24h
- clients track `lastSeq` per session
- on sequence gap, client calls `agent.v2.session.replay({ sessionId, fromSeq })`
- if replay window expired, client retrieves snapshot via `agent.v2.session.get` and re-subscribes

## Extension security controls

- global kill-switch: `AGENT_V2_EXTENSIONS_ENABLED=false`
- allowlist: `AGENT_V2_EXTENSION_ALLOWLIST=id@version@digest,...`
- per-hook timeout: `AGENT_V2_HOOK_TIMEOUT_MS`
- worker memory cap: `AGENT_V2_HOOK_WORKER_OLDGEN_MB`
- signing keys and revocations are persisted in:
  - `agent_v2_signing_keys`
  - `agent_v2_revoked_signatures`
