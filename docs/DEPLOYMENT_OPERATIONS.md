# Deployment & Operations Guide

**Version:** 1.0.0  
**Last Updated:** 2026-02-17

This document provides comprehensive guidance for deploying, operating, and maintaining OpenClaw Gateway in production environments. It covers deployment topologies, Docker configuration, systemd services, monitoring, backup strategies, and operational procedures.

---

## Table of Contents

1. [Overview](#overview)
2. [Deployment Architecture](#deployment-architecture)
3. [Deployment Topology](#deployment-topology)
4. [Docker Setup](#docker-setup)
5. [Systemd Services](#systemd-services)
6. [Environment Configuration](#environment-configuration)
7. [Health Checks & Monitoring](#health-checks--monitoring)
8. [Backup & Disaster Recovery](#backup--disaster-recovery)
9. [Scaling Guidelines](#scaling-guidelines)
10. [Security Hardening](#security-hardening)
11. [Troubleshooting Playbook](#troubleshooting-playbook)
12. [Maintenance Procedures](#maintenance-procedures)
13. [Upgrade Procedures](#upgrade-procedures)

---

## Overview

OpenClaw Gateway is a multi-service Node.js application comprising:

- **Web Service**: HTTP API, WebSocket gateway, and frontend serving
- **Scheduler Service**: Background job processing and automation execution
- **SQLite Database**: Local persistence for messages, memory, and state
- **External Dependencies**: Mem0 (memory service), AI providers (Gemini), channel bridges

### Operational Requirements

| Component | Minimum   | Recommended |
| --------- | --------- | ----------- |
| CPU       | 2 cores   | 4+ cores    |
| RAM       | 4 GB      | 8+ GB       |
| Disk      | 20 GB SSD | 50+ GB SSD  |
| Network   | 100 Mbps  | 1 Gbps      |

### Supported Platforms

- Linux (Ubuntu 22.04+, Debian 12+, RHEL 9+)
- Docker 24.0+
- Node.js 22 LTS

---

## Deployment Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           OPENCLAW GATEWAY DEPLOYMENT                           │
│                           Production Architecture                               │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                              EXTERNAL LAYER                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │   Users      │  │   Telegram   │  │   Discord    │  │   WhatsApp/iMessage  │ │
│  │  (Browser)   │  │   (Webhook)  │  │  (Webhook)   │  │     (Bridge)         │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘ │
│         │                 │                  │                     │           │
│         │ HTTPS/WSS       │ POST /webhook    │ POST /webhook       │ WebSocket │
└─────────┼─────────────────┼──────────────────┼─────────────────────┼───────────┘
          │                 │                  │                     │
┌─────────▼─────────────────▼──────────────────▼─────────────────────▼───────────┐
│                              LOAD BALANCER / REVERSE PROXY                      │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  Nginx / Traefik / Caddy                                                │   │
│  │  • SSL Termination                                                      │   │
│  │  • WebSocket Proxy                                                      │   │
│  │  • Rate Limiting                                                        │   │
│  │  • Static Asset Caching                                                 │   │
│  └────────────────────────────────┬────────────────────────────────────────┘   │
└───────────────────────────────────┼────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────────────┐
│                           APPLICATION LAYER                                    │
│                                                                                │
│  ┌─────────────────────────────────────┐    ┌────────────────────────────────┐ │
│  │         WEB SERVICE                 │    │       SCHEDULER SERVICE        │ │
│  │  ┌─────────────────────────────┐    │    │  ┌──────────────────────────┐  │ │
│  │  │  Next.js App Router         │    │    │  │  Automation Engine       │  │ │
│  │  │  • API Routes               │    │    │  │  • Job Queue Processing  │  │ │
│  │  │  • WebSocket Gateway        │    │    │  │  • Lease Management      │  │ │
│  │  │  • React Frontend           │    │    │  │  • Background Tasks      │  │ │
│  │  └─────────────────────────────┘    │    │  └──────────────────────────┘  │ │
│  │            │                        │    │            │                   │ │
│  │  ┌─────────▼──────────┐             │    │  ┌─────────▼──────────┐        │ │
│  │  │  Worker Threads    │             │    │  │  Heartbeat Writer  │        │ │
│  │  │  (Task Execution)  │             │    │  │  (.local/scheduler │        │ │
│  │  └────────────────────┘             │    │  │   .heartbeat)      │        │ │
│  │                                     │    │  └────────────────────┘        │ │
│  │  Port: 3000                         │    │  Instance ID: scheduler-1      │ │
│  │  Replicas: 2+ (scaled)              │    │  Replicas: 1 (singleton)       │ │
│  └─────────────┬───────────────────────┘    └────────────┬─────────────────────┘ │
│                │                                         │                      │
│                └─────────────────┬───────────────────────┘                      │
│                                  │                                              │
└──────────────────────────────────┼──────────────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼──────────────────────────────────────────────┐
│                            DATA & EXTERNAL SERVICES                             │
│                                                                                 │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌────────────────────────┐  │
│  │   SQLITE VOLUME     │  │   MEM0 SERVICE      │  │   AI PROVIDERS         │  │
│  │  ┌───────────────┐  │  │  ┌───────────────┐  │  │  ┌──────────────────┐  │  │
│  │  │ messages.db   │  │  │  │ Vector Store  │  │  │  │  Google Gemini   │  │  │
│  │  │ memory_nodes  │  │  │  │ Embeddings    │  │  │  │  (Primary LLM)   │  │  │
│  │  │ knowledge_*   │  │  │  │ Search API    │  │  │  │                  │  │  │
│  │  │ worker_queue  │  │  │  └───────────────┘  │  │  └──────────────────┘  │  │
│  │  └───────────────┘  │  │                     │  │                        │  │
│  │  Path: .local/      │  │  Base URL: $MEM0_   │  │  API Key: $GEMINI_    │  │
│  │  Backup: Daily      │  │   BASE_URL          │  │   API_KEY             │  │
│  └─────────────────────┘  └─────────────────────┘  └────────────────────────┘  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Deployment Topology

### Single-Node Deployment

Suitable for small deployments (< 1000 active rooms):

```
┌─────────────────────────────────────────┐
│           Single Server                 │
│  ┌─────────────┐    ┌─────────────┐     │
│  │    Web      │◄──►│  Scheduler  │     │
│  │  Service    │    │  Service    │     │
│  └──────┬──────┘    └──────┬──────┘     │
│         │                  │            │
│  ┌──────▼──────────────────▼──────┐     │
│  │      SQLite (.local/)          │     │
│  └────────────────────────────────┘     │
└─────────────────────────────────────────┘
```

### High-Availability Deployment

Recommended for production workloads:

```
┌─────────────────────────────────────────────────────────────┐
│                      Load Balancer                          │
│                    (Nginx/HAProxy)                          │
└──────────────┬──────────────────────────────┬───────────────┘
               │                              │
    ┌──────────▼──────────┐      ┌────────────▼──────────┐
    │   Web Node 1        │      │    Web Node 2         │
    │  ┌───────────────┐  │      │  ┌───────────────┐    │
    │  │ Web Service   │  │      │  │ Web Service   │    │
    │  └───────────────┘  │      │  └───────────────┘    │
    └──────────┬──────────┘      └───────────┬───────────┘
               │                              │
               └──────────────┬───────────────┘
                              │
                   ┌──────────▼──────────┐
                   │  Shared Storage     │
                   │  (NFS/EFS/SMB)      │
                   │  ┌───────────────┐  │
                   │  │  SQLite DB    │  │
                   │  └───────────────┘  │
                   └─────────────────────┘
                              │
                   ┌──────────▼──────────┐
                   │  Scheduler Node     │
                   │  (Single Instance)  │
                   └─────────────────────┘
```

### Service Separation Rules

| Service   | Scaling    | Instances | Notes                                  |
| --------- | ---------- | --------- | -------------------------------------- |
| Web       | Horizontal | 2+        | Stateless, can scale behind LB         |
| Scheduler | Vertical   | 1         | Must be singleton (lease-based)        |
| SQLite    | -          | 1         | Shared storage required for multi-node |

---

## Docker Setup

### Optimized Dockerfile

```dockerfile
# ============================================================================
# STAGE 1: Dependencies
# ============================================================================
FROM node:22-alpine AS deps
WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ============================================================================
# STAGE 2: Builder
# ============================================================================
FROM node:22-alpine AS builder
WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build application
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npm run build

# ============================================================================
# STAGE 3: Production Runner
# ============================================================================
FROM node:22-alpine AS runner
WORKDIR /app

# Security: Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Install runtime dependencies only
RUN apk add --no-cache curl ca-certificates

# Set environment
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Copy standalone output
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Ensure .local directory exists for SQLite
RUN mkdir -p /app/.local && chown -R nextjs:nodejs /app/.local

# Switch to non-root user
USER nextjs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

# Start application
CMD ["node", "--import", "tsx", "server.ts"]
```

### Production docker-compose.yml

```yaml
version: '3.8'

services:
  # ==========================================================================
  # Web Service
  # ==========================================================================
  web:
    build:
      context: .
      dockerfile: Dockerfile
      target: runner
    container_name: openclaw-web
    restart: unless-stopped
    ports:
      - '${PORT:-3000}:3000'
    environment:
      NODE_ENV: production
      ROOMS_RUNNER: web
      HOSTNAME: 0.0.0.0
      PORT: 3000
      # Database
      MESSAGES_DB_PATH: /app/.local/messages.db
      MEMORY_DB_PATH: /app/.local/memory.db
      # Memory Service
      MEMORY_PROVIDER: ${MEMORY_PROVIDER:-mem0}
      MEM0_BASE_URL: ${MEM0_BASE_URL}
      MEM0_API_KEY: ${MEM0_API_KEY}
      MEM0_API_PATH: ${MEM0_API_PATH:-/v1}
      MEM0_TIMEOUT_MS: ${MEM0_TIMEOUT_MS:-5000}
      # AI Provider
      GEMINI_API_KEY: ${GEMINI_API_KEY}
      MEMORY_EMBEDDING_MODEL: ${MEMORY_EMBEDDING_MODEL}
      # Channel Configuration
      WHATSAPP_BRIDGE_URL: ${WHATSAPP_BRIDGE_URL}
      IMESSAGE_BRIDGE_URL: ${IMESSAGE_BRIDGE_URL}
      TELEGRAM_WEBHOOK_SECRET: ${TELEGRAM_WEBHOOK_SECRET}
      DISCORD_PUBLIC_KEY: ${DISCORD_PUBLIC_KEY}
    volumes:
      - openclaw-data:/app/.local
      - /etc/localtime:/etc/localtime:ro
    networks:
      - openclaw-network
    healthcheck:
      test: ['CMD', 'curl', '-fsS', 'http://localhost:3000/api/health']
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '0.5'
          memory: 512M

  # ==========================================================================
  # Scheduler Service
  # ==========================================================================
  scheduler:
    build:
      context: .
      dockerfile: Dockerfile
      target: runner
    container_name: openclaw-scheduler
    restart: unless-stopped
    command: ['node', '--import', 'tsx', 'scheduler.ts']
    environment:
      NODE_ENV: production
      ROOMS_RUNNER: scheduler
      SCHEDULER_INSTANCE_ID: ${SCHEDULER_INSTANCE_ID:-scheduler-1}
      # Automation Settings
      AUTOMATION_TICK_INTERVAL_MS: ${AUTOMATION_TICK_INTERVAL_MS:-15000}
      AUTOMATION_LEASE_TTL_MS: ${AUTOMATION_LEASE_TTL_MS:-30000}
      AUTOMATION_MAX_CONCURRENT: ${AUTOMATION_MAX_CONCURRENT:-5}
      # Database (shared with web)
      MESSAGES_DB_PATH: /app/.local/messages.db
      MEMORY_DB_PATH: /app/.local/memory.db
      # Memory Service
      MEMORY_PROVIDER: ${MEMORY_PROVIDER:-mem0}
      MEM0_BASE_URL: ${MEM0_BASE_URL}
      MEM0_API_KEY: ${MEM0_API_KEY}
      # AI Provider
      GEMINI_API_KEY: ${GEMINI_API_KEY}
    volumes:
      - openclaw-data:/app/.local
      - /etc/localtime:/etc/localtime:ro
    networks:
      - openclaw-network
    depends_on:
      web:
        condition: service_healthy
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 1G
        reservations:
          cpus: '0.25'
          memory: 256M

  # ==========================================================================
  # Backup Service (Optional)
  # ==========================================================================
  backup:
    image: alpine:latest
    container_name: openclaw-backup
    restart: unless-stopped
    command: >
      sh -c "
        echo '0 2 * * * /backup/backup.sh' | crontab - &&
        crond -f
      "
    volumes:
      - openclaw-data:/data:ro
      - ./backups:/backup
      - ./scripts/backup.sh:/backup/backup.sh:ro
    environment:
      BACKUP_RETENTION_DAYS: ${BACKUP_RETENTION_DAYS:-30}
    depends_on:
      - web

# ============================================================================
# Volumes
# ============================================================================
volumes:
  openclaw-data:
    driver: local

# ============================================================================
# Networks
# ============================================================================
networks:
  openclaw-network:
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.0.0/16
```

### Docker Build & Run Commands

```bash
# Build image
docker build -t openclaw-gateway:latest .

# Run with docker-compose
docker-compose up -d

# View logs
docker-compose logs -f web
docker-compose logs -f scheduler

# Scale web service
docker-compose up -d --scale web=3

# Backup volume
docker run --rm -v openclaw_openclaw-data:/data -v $(pwd)/backups:/backup alpine tar czf /backup/backup-$(date +%Y%m%d).tar.gz -C /data .
```

---

## Systemd Services

### User and Directory Setup

```bash
# Create dedicated user
sudo useradd -r -s /bin/false -d /opt/openclaw -m openclaw

# Create directory structure
sudo mkdir -p /opt/openclaw/{.local,logs,backups}
sudo chown -R openclaw:openclaw /opt/openclaw

# Set permissions
sudo chmod 750 /opt/openclaw
sudo chmod 755 /opt/openclaw/.local
```

### openclaw-web.service

```ini
[Unit]
Description=OpenClaw Gateway Web Service
Documentation=https://github.com/openclaw/gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=openclaw
Group=openclaw
WorkingDirectory=/opt/openclaw

# Environment
Environment="NODE_ENV=production"
Environment="PORT=3000"
Environment="HOSTNAME=0.0.0.0"
Environment="ROOMS_RUNNER=web"
EnvironmentFile=-/opt/openclaw/.env

# Execution
ExecStart=/usr/bin/node --import tsx server.ts
ExecReload=/bin/kill -HUP $MAINPID

# Restart policy
Restart=on-failure
RestartSec=10
StartLimitInterval=60
StartLimitBurst=3

# Resource limits
LimitNOFILE=65536
LimitNPROC=4096

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/openclaw/.local /opt/openclaw/logs
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true

# Logging
StandardOutput=append:/opt/openclaw/logs/web.log
StandardError=append:/opt/openclaw/logs/web.error.log
SyslogIdentifier=openclaw-web

[Install]
WantedBy=multi-user.target
```

### openclaw-scheduler.service

```ini
[Unit]
Description=OpenClaw Gateway Scheduler Service
Documentation=https://github.com/openclaw/gateway
After=network-online.target openclaw-web.service
Wants=network-online.target

[Service]
Type=simple
User=openclaw
Group=openclaw
WorkingDirectory=/opt/openclaw

# Environment
Environment="NODE_ENV=production"
Environment="ROOMS_RUNNER=scheduler"
Environment="SCHEDULER_INSTANCE_ID=scheduler-1"
EnvironmentFile=-/opt/openclaw/.env

# Execution
ExecStart=/usr/bin/node --import tsx scheduler.ts
ExecReload=/bin/kill -HUP $MAINPID

# Restart policy
Restart=on-failure
RestartSec=10
StartLimitInterval=60
StartLimitBurst=3

# Resource limits
LimitNOFILE=65536
LimitNPROC=4096

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/openclaw/.local /opt/openclaw/logs
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true

# Logging
StandardOutput=append:/opt/openclaw/logs/scheduler.log
StandardError=append:/opt/openclaw/logs/scheduler.error.log
SyslogIdentifier=openclaw-scheduler

[Install]
WantedBy=multi-user.target
```

### Service Management Commands

```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable services
sudo systemctl enable openclaw-web.service
sudo systemctl enable openclaw-scheduler.service

# Start services
sudo systemctl start openclaw-web.service
sudo systemctl start openclaw-scheduler.service

# Check status
sudo systemctl status openclaw-web.service
sudo systemctl status openclaw-scheduler.service

# View logs
sudo journalctl -u openclaw-web -f
sudo journalctl -u openclaw-scheduler -f

# Restart services
sudo systemctl restart openclaw-web.service
```

---

## Environment Configuration

### Required Variables

| Variable         | Description           | Example     |
| ---------------- | --------------------- | ----------- |
| `GEMINI_API_KEY` | Google Gemini API key | `AIzaSy...` |

### Core Application Variables

| Variable       | Default       | Description                                              |
| -------------- | ------------- | -------------------------------------------------------- |
| `NODE_ENV`     | `development` | Runtime environment: `development`, `production`, `test` |
| `HOSTNAME`     | `0.0.0.0`     | Server bind address                                      |
| `PORT`         | `3000`        | HTTP server port                                         |
| `ROOMS_RUNNER` | `both`        | Service role: `web`, `scheduler`, `both`                 |

### Database Configuration

| Variable           | Default              | Description                       |
| ------------------ | -------------------- | --------------------------------- |
| `MESSAGES_DB_PATH` | `.local/messages.db` | SQLite database path for messages |
| `MEMORY_DB_PATH`   | `.local/memory.db`   | SQLite database path for memory   |

### Memory Service Configuration

| Variable                   | Default | Required | Description                                     |
| -------------------------- | ------- | -------- | ----------------------------------------------- |
| `MEMORY_PROVIDER`          | `mem0`  | No       | Memory backend: `mem0`, `sqlite`                |
| `MEM0_BASE_URL`            | -       | Yes\*    | Mem0 API base URL (\*required if provider=mem0) |
| `MEM0_API_KEY`             | -       | No       | Mem0 API authentication token                   |
| `MEM0_API_PATH`            | `/v1`   | No       | Mem0 API version path                           |
| `MEM0_TIMEOUT_MS`          | `5000`  | No       | Request timeout in milliseconds                 |
| `MEM0_MAX_RETRIES`         | `3`     | No       | Number of retry attempts                        |
| `MEM0_RETRY_BASE_DELAY_MS` | `1000`  | No       | Base delay for exponential backoff              |

### AI Provider Configuration

| Variable                 | Default | Description                                       |
| ------------------------ | ------- | ------------------------------------------------- |
| `GEMINI_API_KEY`         | -       | Google Gemini API key                             |
| `MEMORY_EMBEDDING_MODEL` | -       | Model for embeddings (e.g., `text-embedding-004`) |

### Scheduler Configuration

| Variable                      | Default | Description                          |
| ----------------------------- | ------- | ------------------------------------ |
| `SCHEDULER_INSTANCE_ID`       | -       | Unique scheduler instance identifier |
| `AUTOMATION_TICK_INTERVAL_MS` | `15000` | Automation check interval (ms)       |
| `AUTOMATION_LEASE_TTL_MS`     | `30000` | Lease time-to-live (ms)              |
| `AUTOMATION_MAX_CONCURRENT`   | `5`     | Maximum concurrent automations       |

### Channel Configuration

| Variable                  | Required | Description                          |
| ------------------------- | -------- | ------------------------------------ |
| `WHATSAPP_BRIDGE_URL`     | No       | WhatsApp bridge WebSocket URL        |
| `IMESSAGE_BRIDGE_URL`     | No       | iMessage bridge WebSocket URL        |
| `TELEGRAM_WEBHOOK_SECRET` | No       | Telegram webhook verification secret |
| `DISCORD_PUBLIC_KEY`      | No       | Discord application public key       |
| `WHATSAPP_WEBHOOK_SECRET` | No       | WhatsApp webhook verification secret |
| `IMESSAGE_WEBHOOK_SECRET` | No       | iMessage webhook verification secret |
| `SLACK_WEBHOOK_SECRET`    | No       | Slack webhook verification secret    |

### Security Configuration

| Variable          | Default | Description                  |
| ----------------- | ------- | ---------------------------- |
| `JWT_SECRET`      | -       | Secret for JWT token signing |
| `NEXTAUTH_SECRET` | -       | NextAuth.js secret           |
| `NEXTAUTH_URL`    | -       | NextAuth.js base URL         |

### Example Production .env File

```bash
# =============================================================================
# OpenClaw Gateway - Production Environment Configuration
# =============================================================================

# Core
NODE_ENV=production
HOSTNAME=0.0.0.0
PORT=3000

# Service Role (set per service)
# ROOMS_RUNNER=web
# SCHEDULER_INSTANCE_ID=scheduler-1

# Database
MESSAGES_DB_PATH=/opt/openclaw/.local/messages.db
MEMORY_DB_PATH=/opt/openclaw/.local/memory.db

# Memory Service
MEMORY_PROVIDER=mem0
MEM0_BASE_URL=https://api.mem0.ai
MEM0_API_KEY=your-mem0-api-key
MEM0_TIMEOUT_MS=5000

# AI Provider
GEMINI_API_KEY=your-gemini-api-key

# Channel Secrets
TELEGRAM_WEBHOOK_SECRET=your-telegram-secret
DISCORD_PUBLIC_KEY=your-discord-public-key
```

---

## Health Checks & Monitoring

### Health Check Endpoints

#### Web Service Health

```
GET /api/health
```

**Response (200 OK):**

```json
{
  "status": "ok",
  "timestamp": "2026-02-17T12:00:00.000Z",
  "uptime": 3600,
  "version": "1.0.0",
  "services": {
    "database": "connected",
    "memory": "connected"
  }
}
```

**Response (503 Service Unavailable):**

```json
{
  "status": "error",
  "timestamp": "2026-02-17T12:00:00.000Z",
  "error": "Database connection failed"
}
```

#### Control Plane Metrics

```
GET /api/control-plane/metrics
```

**Response:**

```json
{
  "rooms": {
    "activeRooms": 5,
    "totalRooms": 23,
    "roomsByPersona": {
      "assistant": 3,
      "support": 2
    }
  },
  "channels": {
    "telegram": "connected",
    "discord": "connected",
    "whatsapp": "disconnected"
  },
  "worker": {
    "queuedTasks": 2,
    "activeTasks": 1,
    "completedTasks": 150,
    "failedTasks": 3
  },
  "memory": {
    "nodes": 150,
    "cacheHitRate": 0.85
  },
  "scheduler": {
    "lastTick": "2026-02-17T11:59:45.000Z",
    "automationsActive": 2,
    "automationsTotal": 10
  }
}
```

#### Log Access

```
GET /api/logs?level=error&limit=100&since=2026-02-17T00:00:00Z
```

**Query Parameters:**

- `level`: Log level filter (`debug`, `info`, `warn`, `error`)
- `limit`: Maximum entries (default: 100, max: 1000)
- `since`: ISO timestamp for filtering

### Scheduler Health Check

The scheduler writes a heartbeat file for health monitoring:

**Heartbeat File:** `.local/scheduler.heartbeat`

```bash
#!/bin/bash
# scheduler-health-check.sh

HEARTBEAT_FILE="/opt/openclaw/.local/scheduler.heartbeat"
MAX_AGE_MS=60000  # 60 seconds

if [ ! -f "$HEARTBEAT_FILE" ]; then
    echo "ERROR: Heartbeat file not found"
    exit 1
fi

FILE_AGE_MS=$(($(date +%s%3N) - $(stat -c %Y%3N "$HEARTBEAT_FILE")))

if [ "$FILE_AGE_MS" -gt "$MAX_AGE_MS" ]; then
    echo "ERROR: Heartbeat is ${FILE_AGE_MS}ms old (max: ${MAX_AGE_MS}ms)"
    exit 1
fi

echo "OK: Heartbeat is ${FILE_AGE_MS}ms old"
exit 0
```

### Monitoring Setup

#### Prometheus Metrics (if enabled)

```
GET /metrics
```

Key metrics to monitor:

| Metric                          | Type      | Description                  |
| ------------------------------- | --------- | ---------------------------- |
| `http_requests_total`           | Counter   | Total HTTP requests          |
| `http_request_duration_seconds` | Histogram | Request latency              |
| `websocket_connections`         | Gauge     | Active WebSocket connections |
| `worker_queue_size`             | Gauge     | Pending tasks in queue       |
| `worker_active_tasks`           | Gauge     | Currently executing tasks    |
| `memory_nodes_total`            | Gauge     | Total memory nodes stored    |

#### Alerting Rules (Prometheus)

```yaml
groups:
  - name: openclaw-alerts
    rules:
      - alert: OpenClawWebDown
        expr: up{job="openclaw-web"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: 'OpenClaw web service is down'

      - alert: OpenClawSchedulerDown
        expr: time() - scheduler_last_heartbeat_seconds > 120
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: 'OpenClaw scheduler is not heartbeating'

      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.1
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: 'High error rate detected'

      - alert: WorkerQueueBacklog
        expr: worker_queue_size > 100
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: 'Worker queue backlog detected'
```

#### Uptime Monitoring

```bash
#!/bin/bash
# uptime-check.sh

WEB_URL="http://localhost:3000/api/health"
HEARTBEAT_FILE="/opt/openclaw/.local/scheduler.heartbeat"
ALERT_WEBHOOK="${ALERT_WEBHOOK_URL}"

# Check web service
if ! curl -fsS "$WEB_URL" > /dev/null; then
    echo "$(date): Web service unhealthy" | tee -a /opt/openclaw/logs/monitor.log
    # Send alert
    curl -X POST "$ALERT_WEBHOOK" -d '{"text":"OpenClaw web service unhealthy"}'
fi

# Check scheduler heartbeat
if [ -f "$HEARTBEAT_FILE" ]; then
    AGE=$(($(date +%s) - $(stat -c %Y "$HEARTBEAT_FILE")))
    if [ "$AGE" -gt 120 ]; then
        echo "$(date): Scheduler heartbeat stale (${AGE}s)" | tee -a /opt/openclaw/logs/monitor.log
        curl -X POST "$ALERT_WEBHOOK" -d '{"text":"OpenClaw scheduler heartbeat stale"}'
    fi
else
    echo "$(date): Scheduler heartbeat missing" | tee -a /opt/openclaw/logs/monitor.log
    curl -X POST "$ALERT_WEBHOOK" -d '{"text":"OpenClaw scheduler heartbeat missing"}'
fi
```

---

## Backup & Disaster Recovery

### Backup Strategy

| Data                | Frequency | Retention | Method             |
| ------------------- | --------- | --------- | ------------------ |
| SQLite Database     | Daily     | 30 days   | `sqlite3 .backup`  |
| Full Data Directory | Daily     | 14 days   | `tar.gz` archive   |
| Offsite Backup      | Weekly    | 90 days   | Cloud storage sync |

### Automated Backup Script

```bash
#!/bin/bash
# backup.sh - Automated backup script for OpenClaw Gateway

set -euo pipefail

# Configuration
DATA_DIR="/opt/openclaw/.local"
BACKUP_DIR="/opt/openclaw/backups"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DATE=$(date +%Y-%m-%d)

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Function: Log with timestamp
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Function: Backup SQLite database
backup_database() {
    local db_name=$1
    local db_path="$DATA_DIR/$db_name"
    local backup_path="$BACKUP_DIR/${db_name%.db}_${TIMESTAMP}.db"

    if [ -f "$db_path" ]; then
        log "Backing up $db_name..."
        sqlite3 "$db_path" ".backup '$backup_path'"
        gzip "$backup_path"
        log "Database backup completed: ${backup_path}.gz"
    else
        log "WARNING: Database $db_path not found, skipping"
    fi
}

# Function: Full data directory backup
backup_full() {
    local archive_path="$BACKUP_DIR/openclaw_full_${TIMESTAMP}.tar.gz"

    log "Creating full backup archive..."
    tar -czf "$archive_path" -C "$DATA_DIR" .
    log "Full backup completed: $archive_path"
}

# Function: Cleanup old backups
cleanup_old_backups() {
    log "Cleaning up backups older than $RETENTION_DAYS days..."
    find "$BACKUP_DIR" -name "*.gz" -mtime +$RETENTION_DAYS -delete
    log "Cleanup completed"
}

# Function: Verify backup integrity
verify_backup() {
    local backup_file=$1

    if [ -f "$backup_file" ]; then
        if gunzip -t "$backup_file" 2>/dev/null; then
            log "Backup verification passed: $backup_file"
            return 0
        else
            log "ERROR: Backup verification failed: $backup_file"
            return 1
        fi
    else
        log "ERROR: Backup file not found: $backup_file"
        return 1
    fi
}

# Main backup process
log "Starting backup process..."

# Database backups
backup_database "messages.db"
backup_database "memory.db"

# Full backup (weekly on Sunday)
if [ "$(date +%u)" -eq 7 ]; then
    backup_full
fi

# Cleanup old backups
cleanup_old_backups

log "Backup process completed successfully"

# Optional: Sync to cloud storage
if [ -n "${S3_BUCKET:-}" ]; then
    log "Syncing backups to S3..."
    aws s3 sync "$BACKUP_DIR" "s3://$S3_BUCKET/backups/" --delete
    log "S3 sync completed"
fi
```

### Restore Procedures

#### Database Restore

```bash
#!/bin/bash
# restore.sh - Database restore script

set -euo pipefail

DATA_DIR="/opt/openclaw/.local"
BACKUP_FILE=$1

if [ ! -f "$BACKUP_FILE" ]; then
    echo "ERROR: Backup file not found: $BACKUP_FILE"
    exit 1
fi

# Stop services
sudo systemctl stop openclaw-web
sudo systemctl stop openclaw-scheduler

# Create restore point of current database
cp "$DATA_DIR/messages.db" "$DATA_DIR/messages.db.pre-restore.$(date +%s)"

# Restore from backup
if [[ "$BACKUP_FILE" == *.gz ]]; then
    gunzip -c "$BACKUP_FILE" > "$DATA_DIR/messages.db"
else
    cp "$BACKUP_FILE" "$DATA_DIR/messages.db"
fi

# Set ownership
sudo chown openclaw:openclaw "$DATA_DIR/messages.db"

# Verify database integrity
if sqlite3 "$DATA_DIR/messages.db" "PRAGMA integrity_check;" | grep -q "ok"; then
    echo "Database integrity check passed"
else
    echo "ERROR: Database integrity check failed"
    exit 1
fi

# Start services
sudo systemctl start openclaw-web
sudo systemctl start openclaw-scheduler

echo "Restore completed successfully"
```

#### Disaster Recovery Runbook

**Scenario 1: Complete Server Failure**

1. **Provision new server**

   ```bash
   # Install dependencies
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs sqlite3
   sudo npm install -g tsx
   ```

2. **Restore data**

   ```bash
   # Download latest backup from S3
   aws s3 cp s3://bucket/backups/openclaw_full_latest.tar.gz /tmp/

   # Extract to data directory
   sudo mkdir -p /opt/openclaw/.local
   sudo tar -xzf /tmp/openclaw_full_latest.tar.gz -C /opt/openclaw/.local
   sudo chown -R openclaw:openclaw /opt/openclaw
   ```

3. **Deploy application**

   ```bash
   # Clone repository
   git clone https://github.com/openclaw/gateway.git /opt/openclaw
   cd /opt/openclaw

   # Install dependencies
   npm ci --omit=dev

   # Copy environment
   cp /tmp/.env /opt/openclaw/.env
   ```

4. **Start services**
   ```bash
   sudo systemctl enable --now openclaw-web
   sudo systemctl enable --now openclaw-scheduler
   ```

**Scenario 2: Database Corruption**

```bash
# 1. Stop services
sudo systemctl stop openclaw-web openclaw-scheduler

# 2. Check corruption
sqlite3 /opt/openclaw/.local/messages.db "PRAGMA integrity_check;"

# 3. Attempt repair
sqlite3 /opt/openclaw/.local/messages.db ".recover" | sqlite3 /opt/openclaw/.local/messages.db.recovered

# 4. If repair fails, restore from backup
./restore.sh /opt/openclaw/backups/messages_20260217_000000.db.gz

# 5. Start services
sudo systemctl start openclaw-web openclaw-scheduler
```

---

## Scaling Guidelines

### Horizontal Scaling (Web Service)

The web service is stateless and can be scaled horizontally:

```yaml
# docker-compose.scale.yml
version: '3.8'

services:
  web:
    deploy:
      replicas: 3
      resources:
        limits:
          cpus: '1'
          memory: 1G
```

**Load Balancer Configuration (Nginx):**

```nginx
upstream openclaw_backend {
    least_conn;
    server web1:3000 max_fails=3 fail_timeout=30s;
    server web2:3000 max_fails=3 fail_timeout=30s;
    server web3:3000 max_fails=3 fail_timeout=30s;
}

server {
    listen 80;
    server_name openclaw.example.com;

    location / {
        proxy_pass http://openclaw_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

### Vertical Scaling Guidelines

| Metric           | Scale Web           | Scale Scheduler | Action              |
| ---------------- | ------------------- | --------------- | ------------------- |
| CPU > 80%        | Add cores/instances | Add cores       | Monitor queue depth |
| Memory > 80%     | Add RAM             | Add RAM         | Check for leaks     |
| Disk I/O high    | Separate DB volume  | -               | Use SSD             |
| Network I/O high | Load balancer       | -               | Add instances       |

### Database Scaling Considerations

SQLite limitations for high-scale deployments:

- **Concurrent writes**: Limited (WAL mode helps)
- **Storage**: Single file grows indefinitely
- **Replication**: No built-in replication

**When to migrate to PostgreSQL:**

- > 10,000 active rooms
- > 100 writes/second sustained
- Multi-region deployment required

### Performance Tuning

```bash
# SQLite optimizations
echo "PRAGMA journal_mode=WAL;" | sqlite3 /opt/openclaw/.local/messages.db
echo "PRAGMA synchronous=NORMAL;" | sqlite3 /opt/openclaw/.local/messages.db
echo "PRAGMA cache_size=-64000;" | sqlite3 /opt/openclaw/.local/messages.db

# Node.js optimizations
export NODE_OPTIONS="--max-old-space-size=4096"
export UV_THREADPOOL_SIZE=128
```

---

## Security Hardening

### Network Security

```bash
# Firewall rules (ufw)
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable

# Or iptables
sudo iptables -A INPUT -p tcp --dport 3000 -s 127.0.0.1 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 3000 -j DROP
```

### File Permissions

```bash
# Secure data directory
sudo chown -R openclaw:openclaw /opt/openclaw
sudo chmod 750 /opt/openclaw
sudo chmod 700 /opt/openclaw/.local
sudo chmod 600 /opt/openclaw/.env

# Secure backups
sudo chmod 700 /opt/openclaw/backups
```

### Secrets Management

**Option 1: Environment Files (Basic)**

```bash
# /opt/openclaw/.env
# Mode 600, owned by root:openclaw
setfacl -m u:openclaw:r /opt/openclaw/.env
```

**Option 2: Docker Secrets (Swarm)**

```yaml
secrets:
  gemini_api_key:
    external: true
  mem0_api_key:
    external: true

services:
  web:
    secrets:
      - source: gemini_api_key
        target: GEMINI_API_KEY
```

**Option 3: HashiCorp Vault (Enterprise)**

```bash
# Retrieve secrets at runtime
export GEMINI_API_KEY=$(vault kv get -field=key secret/openclaw/gemini)
```

### SSL/TLS Configuration

```nginx
# Nginx SSL configuration
server {
    listen 443 ssl http2;
    server_name openclaw.example.com;

    ssl_certificate /etc/letsencrypt/live/openclaw.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/openclaw.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Security Checklist

- [ ] Run services as non-root user
- [ ] Enable firewall (only required ports open)
- [ ] Use TLS 1.2+ for all connections
- [ ] Rotate API keys quarterly
- [ ] Enable automated security updates
- [ ] Configure log aggregation and monitoring
- [ ] Implement rate limiting
- [ ] Regular vulnerability scans
- [ ] Backup encryption at rest

---

## Troubleshooting Playbook

### Service Won't Start

**Symptoms:** `systemctl status` shows failed state

**Diagnostic Steps:**

```bash
# 1. Check service logs
sudo journalctl -u openclaw-web -n 100 --no-pager

# 2. Check environment variables
sudo cat /opt/openclaw/.env

# 3. Verify file permissions
ls -la /opt/openclaw/
ls -la /opt/openclaw/.local/

# 4. Test configuration
sudo -u openclaw node --import tsx -e "console.log('Node.js works')"

# 5. Check port availability
sudo ss -tlnp | grep 3000
```

**Common Causes:**

| Cause             | Solution                                   |
| ----------------- | ------------------------------------------ |
| Missing API key   | Add required `*_API_KEY` to `.env`         |
| Permission denied | `chown -R openclaw:openclaw /opt/openclaw` |
| Port in use       | Change `PORT` or stop conflicting service  |
| Database locked   | Check for zombie processes                 |

### Database Issues

**Symptom:** "database is locked" errors

```bash
# Check for locks
lsof /opt/openclaw/.local/messages.db

# Force WAL checkpoint
echo "PRAGMA wal_checkpoint(TRUNCATE);" | sqlite3 /opt/openclaw/.local/messages.db

# If corrupted, restore from backup
./restore.sh /opt/openclaw/backups/messages_latest.db.gz
```

**Symptom:** Slow queries

```bash
# Enable query logging
echo "PRAGMA query_only=ON;" | sqlite3 /opt/openclaw/.local/messages.db

# Analyze and optimize
echo "ANALYZE;" | sqlite3 /opt/openclaw/.local/messages.db
echo "REINDEX;" | sqlite3 /opt/openclaw/.local/messages.db

# Vacuum to reclaim space
echo "VACUUM;" | sqlite3 /opt/openclaw/.local/messages.db
```

### Memory (Mem0) Connection Issues

**Symptoms:** AI responses lack context, memory errors in logs

```bash
# Test Mem0 connectivity
curl -H "Authorization: Token $MEM0_API_KEY" \
     "$MEM0_BASE_URL/v1/memories/?user_id=test"

# Check environment
echo $MEMORY_PROVIDER
echo $MEM0_BASE_URL
```

**Solutions:**

1. Verify `MEM0_BASE_URL` is reachable from server
2. Check `MEMORY_PROVIDER=mem0` is set
3. Verify API key has correct permissions
4. For production, Mem0 configuration is mandatory

### WebSocket Connection Problems

**Symptoms:** Real-time updates not working

```bash
# Test WebSocket
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" \
  http://localhost:3000/ws
```

**Checklist:**

- [ ] Port 3000 accessible from client
- [ ] Firewall allows WebSocket upgrade
- [ ] `NODE_ENV=production` set correctly
- [ ] Reverse proxy configured for WebSocket
- [ ] No middleware blocking upgrade

### High Memory Usage

```bash
# Monitor Node.js heap
node --expose-gc --max-old-space-size=4096 server.ts

# Check for memory leaks
# Add to startup: --inspect=0.0.0.0:9229
# Use Chrome DevTools to profile

# Restart with memory limit
systemctl edit openclaw-web
# Add: Environment="NODE_OPTIONS=--max-old-space-size=2048"
```

### Scheduler Not Processing Jobs

```bash
# Check heartbeat
stat /opt/openclaw/.local/scheduler.heartbeat

# Check for scheduler lock
ls -la /opt/openclaw/.local/*.lock

# View scheduler logs
sudo journalctl -u openclaw-scheduler -f

# Restart scheduler
sudo systemctl restart openclaw-scheduler
```

### Channel Integration Failures

| Channel  | Test Command                                             | Common Issue       |
| -------- | -------------------------------------------------------- | ------------------ |
| Telegram | `curl -X POST https://api.telegram.org/bot<token>/getMe` | Invalid bot token  |
| Discord  | Check gateway connection logs                            | Invalid public key |
| WhatsApp | `curl $WHATSAPP_BRIDGE_URL/health`                       | Bridge not running |

---

## Maintenance Procedures

### Daily Checks

```bash
#!/bin/bash
# daily-check.sh

echo "=== OpenClaw Daily Health Check ==="

# Service status
systemctl is-active openclaw-web || echo "ALERT: Web service down"
systemctl is-active openclaw-scheduler || echo "ALERT: Scheduler down"

# Disk space
DISK_USAGE=$(df /opt/openclaw | tail -1 | awk '{print $5}' | tr -d '%')
if [ "$DISK_USAGE" -gt 80 ]; then
    echo "WARNING: Disk usage at ${DISK_USAGE}%"
fi

# Database size
DB_SIZE=$(du -h /opt/openclaw/.local/messages.db | cut -f1)
echo "Database size: $DB_SIZE"

# Recent errors
ERROR_COUNT=$(journalctl -u openclaw-web --since "24 hours ago" | grep -c ERROR || echo 0)
echo "Errors in last 24h: $ERROR_COUNT"
```

### Weekly Maintenance

```bash
#!/bin/bash
# weekly-maintenance.sh

echo "=== Weekly Maintenance ==="

# 1. Database maintenance
echo "Optimizing database..."
sqlite3 /opt/openclaw/.local/messages.db "VACUUM;"
sqlite3 /opt/openclaw/.local/messages.db "REINDEX;"
sqlite3 /opt/openclaw/.local/messages.db "ANALYZE;"

# 2. Log rotation
logrotate -f /etc/logrotate.d/openclaw

# 3. Cleanup old backups
find /opt/openclaw/backups -name "*.gz" -mtime +30 -delete

# 4. Update packages
apt-get update && apt-get upgrade -y

# 5. Restart services (if needed)
# systemctl restart openclaw-web
```

### Log Rotation

```bash
# /etc/logrotate.d/openclaw
/opt/openclaw/logs/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 openclaw openclaw
    sharedscripts
    postrotate
        systemctl reload openclaw-web
        systemctl reload openclaw-scheduler
    endscript
}
```

---

## Upgrade Procedures

### Pre-Upgrade Checklist

- [ ] Create full backup
- [ ] Review changelog for breaking changes
- [ ] Test upgrade in staging environment
- [ ] Announce maintenance window
- [ ] Verify rollback procedure

### Upgrade Steps

```bash
#!/bin/bash
# upgrade.sh

VERSION=$1
BACKUP_DIR="/opt/openclaw/backups/pre-upgrade-$(date +%Y%m%d)"

echo "Starting upgrade to version $VERSION"

# 1. Create pre-upgrade backup
mkdir -p "$BACKUP_DIR"
tar -czf "$BACKUP_DIR/data.tar.gz" -C /opt/openclaw/.local .
cp /opt/openclaw/.env "$BACKUP_DIR/"

# 2. Stop services
sudo systemctl stop openclaw-scheduler
sudo systemctl stop openclaw-web

# 3. Backup current code
tar -czf "$BACKUP_DIR/code.tar.gz" -C /opt/openclaw --exclude=.local --exclude=logs --exclude=node_modules .

# 4. Update code
cd /opt/openclaw
git fetch origin
git checkout "$VERSION"

# 5. Install dependencies
npm ci --omit=dev

# 6. Run database migrations (if any)
# npm run migrate

# 7. Build application
npm run build

# 8. Start services
sudo systemctl start openclaw-web
sleep 5
sudo systemctl start openclaw-scheduler

# 9. Health check
sleep 10
curl -f http://localhost:3000/api/health || {
    echo "Upgrade failed, rolling back..."
    # Rollback procedure
    exit 1
}

echo "Upgrade completed successfully"
```

### Rollback Procedure

```bash
#!/bin/bash
# rollback.sh

ROLLBACK_VERSION=$1

echo "Rolling back to $ROLLBACK_VERSION"

# 1. Stop services
sudo systemctl stop openclaw-scheduler
sudo systemctl stop openclaw-web

# 2. Restore code
cd /opt/openclaw
git checkout "$ROLLBACK_VERSION"
npm ci --omit=dev
npm run build

# 3. Restore data (if needed)
# tar -xzf /opt/openclaw/backups/pre-upgrade-XXXX/data.tar.gz -C /opt/openclaw/.local

# 4. Start services
sudo systemctl start openclaw-web
sudo systemctl start openclaw-scheduler

echo "Rollback completed"
```

### Database Migration

```bash
# Check current schema version
sqlite3 /opt/openclaw/.local/messages.db "PRAGMA user_version;"

# Apply migrations in order
for migration in migrations/*.sql; do
    echo "Applying $migration..."
    sqlite3 /opt/openclaw/.local/messages.db < "$migration"
done

# Update schema version
sqlite3 /opt/openclaw/.local/messages.db "PRAGMA user_version = 2;"
```

---

## See Also

- [Core Handbook](CORE_HANDBOOK.md) - Technical reference for the codebase
- [Omnichannel Gateway Operations](OMNICHANNEL_GATEWAY_OPERATIONS.md) - Channel integration details
- [Memory Architecture](memory-architecture.md) - Memory system design
- [Security System](SECURITY_SYSTEM.md) - Security features and configuration
- [Model Hub Provider Matrix](architecture/model-hub-provider-matrix.md) - AI provider configuration
