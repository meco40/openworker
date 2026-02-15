# Deployment & Operations

**Stand:** 2026-02-13

## Überblick

Dieses Dokument beschreibt Deployment- und Betriebsaspekte von OpenClaw Gateway:

- **Docker-Setup** für Produktion
- **Environment-Variablen**
- **Systemd-Services**
- **Health-Checks**
- **Monitoring**

## Docker-Setup

### Dockerfile

Multi-Stage Build mit Next.js Standalone Output:

```dockerfile
# Stage 1: Dependencies
FROM node:22-alpine AS deps
RUN npm ci --omit=dev

# Stage 2: Build
FROM node:22-alpine AS builder
RUN npm ci
COPY . .
RUN npm run build

# Stage 3: Production
FROM node:22-alpine AS runner
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=deps /app/node_modules ./node_modules

USER nextjs
EXPOSE 3000
CMD ["node", "--import", "tsx", "server.ts"]
```

### docker-compose.yml

Zwei Services: Web und Scheduler:

```yaml
services:
  web:
    build: .
    ports:
      - '3000:3000'
    environment:
      NODE_ENV: production
      ROOMS_RUNNER: scheduler
    volumes:
      - ./.local:/app/.local
    healthcheck:
      test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://localhost:3000/']
      interval: 30s
      timeout: 5s

  scheduler:
    build: .
    command: ['node', '--import', 'tsx', 'scheduler.ts']
    environment:
      SCHEDULER_INSTANCE_ID: scheduler-1
      ROOMS_RUNNER: scheduler
      AUTOMATION_TICK_INTERVAL_MS: 15000
      AUTOMATION_LEASE_TTL_MS: 30000
    volumes:
      - ./.local:/app/.local
    depends_on:
      - web
```

## Systemd-Services

### openclaw-web.service

```ini
[Unit]
Description=OpenClaw Gateway Web
After=network.target

[Service]
Type=simple
User=openclaw
WorkingDirectory=/opt/openclaw
ExecStart=/usr/bin/node --import tsx server.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### openclaw-scheduler.service

```ini
[Unit]
Description=OpenClaw Gateway Scheduler
After=network.target

[Service]
Type=simple
User=openclaw
WorkingDirectory=/opt/openclaw
ExecStart=/usr/bin/node --import tsx scheduler.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## Environment-Variablen

### Erforderlich

| Variable                   | Beschreibung        |
| -------------------------- | ------------------- |
| Mindestens ein `*_API_KEY` | KI-Provider API Key |

### Optional

| Variable                | Standard             | Beschreibung                               |
| ----------------------- | -------------------- | ------------------------------------------ |
| `NODE_ENV`              | `development`        | `production` für Prod                      |
| `HOSTNAME`              | `0.0.0.0`            | Server-Hostname                            |
| `PORT`                  | `3000`               | Server-Port                                |
| `MESSAGES_DB_PATH`      | `.local/messages.db` | SQLite-Datenbank                           |
| `MEMORY_PROVIDER`       | `mem0`               | Memory Backend (`mem0` empfohlen)           |
| `MEMORY_DB_PATH`        | -                    | Lokale Memory-DB (SQLite + Mem0-Mirror)    |
| `MEM0_BASE_URL`         | -                    | Mem0 Base URL (in Production erforderlich) |
| `MEM0_API_PATH`         | `/v1`                | Mem0 API Prefix                            |
| `MEM0_API_KEY`          | -                    | Optionaler Mem0 Bearer Token               |
| `MEM0_TIMEOUT_MS`       | `5000`               | Timeout pro Mem0 Request in ms             |
| `ROOMS_RUNNER`          | `both`               | `web`, `scheduler`, `both`                 |
| `SCHEDULER_INSTANCE_ID` | -                    | Scheduler-Instanz-ID                       |

### KI-Provider Keys

| Variable             | Provider           |
| -------------------- | ------------------ |
| `GEMINI_API_KEY`     | Google Gemini      |

### Channel-Config

| Variable                  | Beschreibung        |
| ------------------------- | ------------------- |
| `WHATSAPP_BRIDGE_URL`     | WhatsApp Bridge URL |
| `IMESSAGE_BRIDGE_URL`     | iMessage Bridge URL |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram Secret     |
| `DISCORD_PUBLIC_KEY`      | Discord Public Key  |
| `WHATSAPP_WEBHOOK_SECRET` | WhatsApp Secret     |
| `IMESSAGE_WEBHOOK_SECRET` | iMessage Secret     |
| `SLACK_WEBHOOK_SECRET`    | Slack Secret        |

## Health-Checks

### Web-Service

```
GET /api/health
```

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2026-02-13T12:00:00.000Z",
  "uptime": 3600
}
```

### Scheduler

Heartbeat-Datei: `/app/.local/scheduler.heartbeat`

```bash
# Health-Check
node -e "const fs=require('fs');const p='/app/.local/scheduler.heartbeat';if(!fs.existsSync(p)){process.exit(1);}const age=Date.now()-fs.statSync(p).mtimeMs;process.exit(age<60000?0:1);"
```

## Monitoring

### Metriken

```
GET /api/control-plane/metrics
```

**Response:**

```json
{
  "rooms": {
    "activeRooms": 5,
    "totalRooms": 23
  },
  "channels": {
    "telegram": "connected",
    "whatsapp": "disconnected"
  },
  "worker": {
    "queuedTasks": 2,
    "activeTasks": 1
  },
  "memory": {
    "nodes": 150
  }
}
```

### Logs

```
GET /api/logs?level=error&limit=100
```

## Backup

### Datenbank-Backup

```bash
# SQLite Dump
sqlite3 .local/messages.db ".backup backups/messages-$(date +%Y%m%d).db"

#tar.gz Archiv
tar -czf backups/openclaw-$(date +%Y%m%d).tar.gz .local/
```

## Troubleshooting

### Service startet nicht

1. Logs prüfen: `journalctl -u openclaw-web -n 100`
2. Environment-Variablen prüfen
3. Datenbank-Pfad prüfen

### WebSocket-Verbindungsprobleme

1. Port 3000 erreichbar?
2. Firewall-Regeln?
3. `NODE_ENV=production`?

### Keine KI-Antworten

1. API-Keys konfiguriert?
2. Health-Check des Providers?
3. Rate-Limits?

### Memory-Probleme (Mem0)

1. `MEM0_BASE_URL` erreichbar?
2. `MEMORY_PROVIDER=mem0` gesetzt?
3. Bei Embedding-Fehlern im Memory-Pfad nur Gemini-Konfiguration prüfen (`GEMINI_API_KEY`, `MEMORY_EMBEDDING_MODEL`)
4. Startet der Prozess nicht: Production blockiert absichtlich bei fehlender Mem0-Konfiguration.

## Verifikation

```bash
# Build
npm run build

# Lint
npm run lint

# Typecheck
npm run typecheck

# Tests
npm run test

# Full check
npm run check
```

## Siehe auch

- [docs/CORE_HANDBOOK.md](CORE_HANDBOOK.md)
- [docs/OMNICHANNEL_GATEWAY_OPERATIONS.md](OMNICHANNEL_GATEWAY_OPERATIONS.md)
- [docs/architecture/model-hub-provider-matrix.md](architecture/model-hub-provider-matrix.md)
