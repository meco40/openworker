# Inbox v2 Contract

## Metadata

- Purpose: Canonical contract for multi-channel inbox listing and realtime updates.
- Scope: HTTP `GET /api/channels/inbox`, WS RPC `inbox.list`, WS event `inbox.updated`.
- Last Reviewed: 2026-03-05

---

## 1. Versioning

- `v2` is the canonical contract for inbox consumers.
- `v1` is deprecated and only available in the transition window.
- `v1` deprecation signals:
  - HTTP: `Deprecation: true`, `Sunset: <http-date>`
  - WS: response payload includes `deprecated.sunset`

---

## 2. HTTP Listing (`GET /api/channels/inbox`)

### Query params

- `version`: `2` (default), `1` (deprecated)
- `channel`: optional, case-insensitive channel filter
- `q`: optional text filter (title or last message content)
- `limit`: optional, default `50`, max `100`
- `cursor`: optional base64url cursor for pagination
- `resync`: optional reconnect-resync signal (`1|true|yes`)

### v2 success response

```json
{
  "ok": true,
  "items": [
    {
      "conversationId": "conv_123",
      "channelType": "Telegram",
      "title": "Support chat",
      "updatedAt": "2026-03-05T10:15:30.000Z",
      "lastMessage": {
        "id": "msg_789",
        "role": "user",
        "content": "hello",
        "createdAt": "2026-03-05T10:15:29.000Z",
        "platform": "Telegram"
      }
    }
  ],
  "page": {
    "limit": 50,
    "returned": 1,
    "hasMore": false,
    "nextCursor": null,
    "totalMatched": 1
  }
}
```

### v1 success response (deprecated)

```json
{
  "ok": true,
  "items": [],
  "total": 0,
  "nextCursor": null
}
```

### Error response

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_REQUEST|RATE_LIMITED|UNAVAILABLE",
    "message": "..."
  }
}
```

---

## 3. WS RPC Listing (`inbox.list`)

### Request params

- Same semantic params as HTTP: `version`, `channel`, `q`, `limit`, `cursor`, `resync`

### Response

- `v2`: exact parity to HTTP v2 success body.
- `v1`: `ok/items/total/nextCursor` plus `deprecated.sunset`.
- Errors use gateway error shape with code parity: `INVALID_REQUEST`, `RATE_LIMITED`, `UNAVAILABLE`.

---

## 4. WS Realtime Event (`inbox.updated`)

```json
{
  "version": "v2",
  "action": "upsert|delete",
  "conversationId": "conv_123",
  "item": {
    "conversationId": "conv_123",
    "channelType": "Telegram",
    "title": "Support chat",
    "updatedAt": "2026-03-05T10:15:30.000Z",
    "lastMessage": {
      "id": "msg_789",
      "role": "user",
      "content": "hello",
      "createdAt": "2026-03-05T10:15:29.000Z",
      "platform": "Telegram"
    }
  },
  "serverTs": "2026-03-05T10:15:30.500Z"
}
```

Rules:

- `upsert`: create or update conversation entry, then reorder by `updatedAt desc, conversationId desc`.
- `delete`: remove conversation entry by `conversationId`.
- Event duplicates must be handled idempotently by clients.

---

## 5. Listing Semantics

- Filtering runs before pagination.
- Stable sort: `updatedAt DESC`, tie-breaker `conversationId DESC`.
- Cursor is based on `(updatedAt, conversationId)`.
- Agent-room conversations are excluded from inbox listing.
- User context scoping is mandatory for every query.

---

## 6. Security and Rate Limits

- Auth: no bypass of `withUserContext` / tenant isolation.
- HTTP rate limit: `INBOX_HTTP_RATE_LIMIT_PER_MINUTE` (default `120`).
- WS rate limit: `INBOX_WS_RATE_LIMIT_PER_MINUTE` (default `240`).
- Feature flags:
  - `INBOX_V2_ENABLED`
  - `INBOX_V2_EVENTS_ENABLED`
  - `INBOX_V2_LOGS`
