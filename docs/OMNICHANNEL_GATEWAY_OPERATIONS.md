# Omnichannel and Gateway Operations

Stand: 2026-02-21

## Zweck

Diese Datei ist die aktive Betriebsdoku fuer Omnichannel Messaging und Gateway WebSocket Runtime.
Sie fasst den frueheren Integrationsbericht und das Runbook zusammen.

## Architektur in Kurzform

- Transport: WebSocket Gateway (`/ws`) fuer Realtime Events + RPC.
- Channel-Verarbeitung: normalisierte Inbound-Pipeline und adapterbasiertes Routing.
- Persistenz: Channel-Bindings, Konversationen und Messages serverseitig in SQLite.
- Outbound: platform-spezifische Adapter (Telegram, WhatsApp, Discord, iMessage, Slack).

Kernpfade:

- `src/server/gateway/*`
- `src/server/channels/*`
- `src/modules/gateway/*`

## Unterstützte Kanaele (aktiver Stand)

- Telegram
- WhatsApp
- Discord
- iMessage
- Slack
- WebChat

## Pairing/Unpairing

### Pair

`POST /api/channels/pair` mit:

- `channel`: `telegram|whatsapp|discord|imessage|slack`
- `token`: erforderlich fuer `telegram`, `discord`, `slack`

Erwartung:

- `ok: true`
- `status`: `connected` oder `awaiting_code`

### Unpair

`DELETE /api/channels/pair` mit `channel`.

## Webhook Security

Wichtige Secrets:

- `TELEGRAM_WEBHOOK_SECRET`
- `DISCORD_PUBLIC_KEY`
- `WHATSAPP_WEBHOOK_SECRET`
- `IMESSAGE_WEBHOOK_SECRET`
- `SLACK_WEBHOOK_SECRET`

Health/Diagnose:

- `GET /api/security/status`

## Channel State und Inbox

- `GET /api/channels/state`
- `GET /api/channels/inbox?channel=<ChannelName>&q=<search>&limit=<n>`

Gateway RPC Alternativen:

- `channels.list`
- `channels.pair`
- `channels.unpair`
- `inbox.list`

## Realtime Betrieb

- Eine WS-Verbindung pro Client-Session.
- Event-basierte Updates fuer Chat, Channels, Logs, Presence, Worker.
- Slow-Consumer Schutz im Broadcast-Layer.
- Legacy-SSE fuer Chat/Logs ist entfernt.

## Troubleshooting

`Unsupported channel`:

- Kanal nicht im Pairing-/Routing-Registry aktiviert.

`403` am Webhook:

- Secret/Signatur fehlt oder ist falsch.

`Keine Live-Updates`:

- WS-Verbindung und Event-Subscriptions pruefen.

`pair ok, aber kein outbound`:

- Credentials/Token in Store oder Env pruefen.
- Ziel-Chat-ID auf externer Plattform pruefen.

## Verifikation

- `npm run test -- tests/integration/channels`
- `npm run test -- tests/unit/gateway`
- `npm run lint`

## Historie

- `docs/archive/operations/GATEWAY_WEBSOCKET_INTEGRATION.md`
- `docs/archive/operations/OMNICHANNEL_RUNBOOK.md`
- `docs/archive/reports/OMNICHANNEL_IMPLEMENTATION_BERICHT.md`
