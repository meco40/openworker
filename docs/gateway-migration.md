# Gateway Migration Guide

## Breaking Changes

- ❌ `/ws-agent-v2` Endpoint ist entfernt
- ❌ `/ws` ohne Query-Parameter wird nicht mehr akzeptiert
- ❌ `/ws?protocol=v1` wird nicht mehr akzeptiert
- ✅ Kanonischer Endpoint: `/ws?protocol=v2`

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

- v2: 600 requests/minute (configurable via `AGENT_V2_MAX_REQUESTS_PER_MINUTE`)

## Environment Variables

```bash
# Optional: v2 rate limit anpassen
AGENT_V2_MAX_REQUESTS_PER_MINUTE=1000
```

## Architecture Overview

### Before (Legacy)

```
ws://localhost:3000/ws-agent-v2  → v2 Protocol (Agent-V2, Swarm, Commands)
```

### After (v2-only)

```
ws://localhost:3000/ws?protocol=v2  → v2 Protocol
```

## Backward Compatibility

Es gibt keinen Fallback mehr auf Legacy-Endpunkte oder v1-Protocol-Query.
Alle Clients müssen `ws://<host>/ws?protocol=v2` verwenden.
