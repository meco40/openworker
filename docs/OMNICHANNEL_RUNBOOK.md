# Omnichannel Runbook

## Scope

This runbook covers channel onboarding, webhook verification, and operational checks for:
- Telegram
- WhatsApp
- Discord
- iMessage
- Slack

## 1. Pairing Flow

Use `POST /api/channels/pair` with:
- `channel`: `telegram|whatsapp|discord|imessage|slack`
- `token`: required for `telegram`, `discord`, `slack`

Expected success response:
- `ok: true`
- `status`: `connected` or `awaiting_code`
- `peerName` (if available)

Disconnect via:
- `DELETE /api/channels/pair` with `channel`

## 2. Webhook Verification

Configure the following secrets:
- `TELEGRAM_WEBHOOK_SECRET`
- `DISCORD_PUBLIC_KEY`
- `WHATSAPP_WEBHOOK_SECRET`
- `IMESSAGE_WEBHOOK_SECRET`
- `SLACK_WEBHOOK_SECRET`

Health check:
- `GET /api/security/status`
- Inspect `channels[]` diagnostics for `secretConfigured` and `status`

## 3. Channel State + Inbox

State endpoint:
- `GET /api/channels/state`
- Returns per-channel capability + runtime status

Unified inbox endpoint:
- `GET /api/channels/inbox?channel=<ChannelName>&q=<search>&limit=<n>`
- Returns normalized inbox items with latest message preview

Gateway RPC alternatives:
- `channels.list`
- `channels.pair`
- `channels.unpair`
- `inbox.list`

## 4. Observability

Structured channel logs:
- Use `logChannelEvent(direction, channel, outcome, metadata)` for channel telemetry.
- Emitted patterns:
  - `channel.inbound.accepted:<channel>`
  - `channel.outbound.rejected:<channel>`
  - `channel.outbound.failed:<channel>`

## 5. Common Failures

`Unsupported channel`:
- Channel not enabled in pairing/router map.

`Forbidden` on webhook:
- Missing or invalid shared secret/signature configuration.

No live updates:
- Verify WS connection (`/ws`) and event subscription (`channels.status`, `inbox.updated`).

`pair` succeeds but no outbound delivery:
- Check channel token in credential store or env.
- Confirm external chat/channel ID is valid.
