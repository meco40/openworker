---
id: gateway-self-heal
emoji: 🔧
requires:
  env:
    - OPENCLAW_OWNER_USER_ID
---

Use this skill to diagnose and repair gateway connectivity issues.

When a user reports that a worker is unresponsive, a channel is disconnected, or the gateway appears broken, use `gateway_self_heal` to run diagnostics and attempt automatic recovery.

Only available to the gateway owner. Reports the current status of all connections and attempts reconnection for failed ones.
