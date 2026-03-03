# Gateway Migration Guide

## Breaking Changes

- ❌ `/ws-agent-v2` Endpoint ist entfernt
- ✅ Neue URLs: `/ws?protocol=v2`

## Client Migration

### Before

```typescript
const client = new AgentV2GatewayClient();
// (Alt): ws://localhost:3000/ws-agent-v2
```

### After

```typescript
const client = new AgentV2GatewayClient();
// Connects to: ws://localhost:3000/ws?protocol=v2
// (Automatisch migriert, keine Code-Änderung nötig)
```

## Server Configuration

### Rate Limits

- v1: 60 requests/minute (default)
- v2: 600 requests/minute (configurable via `AGENT_V2_MAX_REQUESTS_PER_MINUTE`)

## Environment Variables

```bash
# Optional: v2 rate limit anpassen
AGENT_V2_MAX_REQUESTS_PER_MINUTE=1000
```

## Architecture Overview

### Before (Dual Endpoint)

```
ws://localhost:3000/ws           → v1 Protocol (Chat, Channels, Inbox)
ws://localhost:3000/ws-agent-v2  → v2 Protocol (Agent-V2, Swarm, Commands)
```

### After (Unified Endpoint)

```
ws://localhost:3000/ws?protocol=v1  → v1 Protocol (default)
ws://localhost:3000/ws?protocol=v2  → v2 Protocol
```

## Backward Compatibility

Es gibt keinen Legacy-Fallback mehr auf `/ws-agent-v2`.
Alle Clients müssen `ws://<host>/ws?protocol=v2` verwenden.
