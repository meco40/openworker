# Inbox v1 to v2 Migration and Rollout

Stand: 2026-03-05

## Ziel

Sauberer Cutover von Inbox `v1` auf `v2` mit Live-Updates ohne Reload fuer Web und zukuenftige Mobile-Clients.

## Breaking Migration Plan

1. Release N:
   - `v2` default aktiv.
   - `v1` weiter verfuegbar, aber deprecated.
   - Consumer erhalten Sunset-Hinweis (HTTP Header / WS payload).
2. Release N+1:
   - `v1` entfernen.
   - nur `v2` Contract supporten.

## Consumer Checklist

1. Listing umstellen:
   - HTTP: `GET /api/channels/inbox?version=2`
   - WS RPC: `inbox.list` mit `version: 2`
2. Response parsing:
   - auf `items[]` + `page` umstellen
   - `page.nextCursor` fuer Pagination verwenden
3. Realtime handling:
   - `inbox.updated` abonnieren
   - `action=upsert`: upsert + re-sort
   - `action=delete`: remove
4. Reconnect:
   - nach reconnect `version=2&resync=1` Listing triggern
   - cursor-basiert bis `hasMore=false` nachladen

## Example Client Flows

### 1) Bootstrap flow

1. Client callt `GET /api/channels/inbox?version=2&limit=100`
2. Falls `hasMore=true`, weitere Seiten ueber `nextCursor`
3. UI rendert sortierte Liste

### 2) Live flow

1. WS verbinden
2. Event `inbox.updated` abonnieren
3. Bei `upsert` unbekannte Konversation sofort einblenden (kein Reload)
4. Bei `delete` Konversation sofort entfernen

### 3) Reconnect recovery flow

1. WS reconnect erkannt
2. Resync starten: `GET /api/channels/inbox?version=2&limit=100&resync=1`
3. Cursor pages nachladen
4. Snapshot atomar in Client-State uebernehmen
5. Aktive Konversation validieren und Messages nachladen

## Rollout Gates and Abort Criteria

## Phase 1: local/dev

- `INBOX_V2_ENABLED=true`
- `INBOX_V2_EVENTS_ENABLED=true`
- Metriken beobachten:
  - `inbox.queryLatencyMs.httpP95/wsP95`
  - `inbox.events.dropped`
  - `inbox.reconnectResyncCount`

Abort:

- `events.dropped > 0` ueber laengeren Zeitraum
- deutlicher p95/p99 Regressionssprung gegen Baseline

## Phase 2: internal beta

- begrenzte Nutzergruppe
- structured logs aktiv (`INBOX_V2_LOGS=true`) fuer Ursachenanalyse

Abort:

- reproduzierbare Inkonsistenz zwischen HTTP-Listing und Live-Event-State
- haeufige Reconnect-Resync Kaskaden

## Phase 3: full rollout

- v2 flaechendeckend
- v1 in Sunset-Window weiter verfuegbar
- nach Release N+1 v1 entfernen

Emergency controls:

- Global cutover stop: `INBOX_V2_ENABLED=false`
- Realtime kill-switch: `INBOX_V2_EVENTS_ENABLED=false`
