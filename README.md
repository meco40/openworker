# OpenClaw Gateway Control Plane

**Stand:** 2026-08-17
**Version:** 0.0.0

---

## Überblick

OpenClaw Gateway ist eine **Next.js-basierte Multi-Channel-KI-Plattform** mit Unterstützung für:

- **Omnichannel-Messaging** (Telegram, WhatsApp, Discord, iMessage, Slack, WebChat)
- **Persistente Chat-Konversationen** mit Persona-Bindung und Streaming-Tool-Loop
- **Master Agent** für Plan-Delegation, Tool-Approvals und autonome Workflows
- **Automation- und Ops-Steuerung** über Scheduler, Ops-API und Runtime-Health
- **Skill-basiertes Tool-System** mit 34 Built-in Skills (11 Default + 23 opt-in/compat) + ClawHub-Erweiterungen
- **Konzeptuelles Memory** mit Embedding-basierter Ähnlichkeitssuche
- **Multi-Provider-KI** (14 Provider: OpenAI, OpenAI Codex, Anthropic, Google Gemini, OpenRouter, Ollama, LM Studio, xAI, Mistral, Cohere, Z.AI, Kimi Code, ByteDance, GitHub Copilot/Models)

---

## Schnellstart

### Voraussetzungen

- Node.js 22+
- pnpm (Source of Truth fuer Lockfile/CI)
- Docker Desktop (für lokalen Mem0-Stack)

### Installation

```bash
# Abhängigkeiten installieren
pnpm install

# Environment-Variablen setzen (Windows PowerShell)
Copy-Item .env.local.example .env.local
# Editiere .env.local
```

### Lokale Entwicklung

```bash
# Lokalen Mem0-Stack starten (Postgres + mem0 API)
pnpm run mem0:local:up

# Web-Server starten
pnpm run dev

# Scheduler starten (optional, für Automations-Läufe und Scheduler-Health)
pnpm run dev:scheduler
```

`pnpm run dev` prüft Mem0 beim Start mit mehreren Versuchen. In der Entwicklung startet der Stack nach erfolglosen Versuchen im degradierten Modus; Memory-Schreib- und Recall-Aktionen bleiben dann solange nicht verfügbar, bis Mem0 wieder bereit ist. Für den lokalen Stack sind in `.env.local` mindestens diese Werte nötig:

- `MEMORY_PROVIDER=mem0` (oder `sqlite` für lokalen SQLite-Fallback)
- `MEM0_BASE_URL=http://127.0.0.1:8010`
- `MEM0_API_KEY=local-mem0-dev-token` (oder eigener Token)
- `MEM0_API_PATH=/` (der gebündelte `mem0-local`-Dienst nutzt keinen `/v1`-Prefix)
- `GEMINI_API_KEY=<key>` (für mem0-local Bootstrap, sofern im Stack verwendet)
- `MODEL_HUB_ENCRYPTION_KEY=<32-byte-key>` (für Model-Hub-Secrets; empfohlen)

### Produktion

```bash
# Build
pnpm run build

# Start
pnpm run start
```

---

## Projektstruktur

```
├── app/                    # Next.js App Router & API-Routen
├── src/
│   ├── cli/               # CLI-Programme & Befehle
│   ├── commands/          # Health-Checks & Diagnose-Befehle
│   ├── components/        # Wiederverwendbare UI-Komponenten
│   ├── core/              # Core-Infrastruktur (Memory)
│   ├── lib/               # Utility-Funktionen
│   ├── logging/           # Logging-Infrastruktur
│   ├── messenger/         # Messenger-Integrationen
│   ├── modules/           # Frontend Feature-Module (Hooks, Services)
│   ├── server/            # Serverseitige Domänen (DDD)
│   │   ├── channels/      # Omnichannel-Messaging
│   │   ├── skills/        # Skill-Execution Engine
│   │   ├── memory/        # Konzeptuelles Memory
│   │   ├── model-hub/     # Multi-Provider-KI (14 Provider)
│   │   ├── security/      # Security-Checks
│   │   ├── clawhub/       # ClawHub-Integration
│   │   ├── knowledge/     # Knowledge Base System
│   │   ├── automation/    # Cron-basierte Automationen
│   │   └── gateway/       # WebSocket Gateway
│   ├── services/          # Externe Service-Integrationen
│   ├── shared/            # Geteilte Typen, Config & Utilities
│   └── skills/            # Skill-Definitionen & Handler
├── tests/                 # Test-Suite
│   ├── contract/          # API-Vertrags-Tests
│   ├── e2e/               # End-to-End Tests
│   ├── integration/       # Integrationstests
│   └── unit/              # Unit-Tests
├── docs/                  # Technische Dokumentation
├── scripts/               # Hilfsskripte
└── ops/                   # Operations-Konfiguration (systemd)
```

---

## Architekturregeln

1. **UI-Komponenten** enthalten keine Infrastruktur-Execution.
2. **API-Routen** parsen Requests und delegieren an Services/Use-Cases.
3. **Business-Logik** lebt in `src/server/*` bzw. Feature-Services.
4. **`src/shared`** darf von Modulen/Server genutzt werden, aber nicht umgekehrt.
5. Neue Änderungen bleiben **strict-typed** und **testbar**.

---

## Qualitätssicherung

```bash
# Linting
pnpm run lint

# TypeScript-Typprüfung
pnpm run typecheck

# Tests (Unit + Integration, ohne externe World-Model-Dienste)
pnpm run test

# World-Model-Integration mit lokalem PostgreSQL
$env:WORLD_MODEL_E2E='true'
corepack pnpm exec vitest run tests/integration/world-model

# E2E Baseline (Alias auf Smoke-Lane)
pnpm run test:e2e

# E2E Smoke (deterministisch, Vitest)
pnpm run test:e2e:smoke

# E2E Browser-Journeys (Playwright)
pnpm run test:e2e:browser

# E2E Live (Mem0, opt-in via MEM0_E2E=1)
pnpm run test:e2e:live

# Vollständiger Check (typecheck + lint + format:check)
pnpm run check

# Build (Produktion)
pnpm run build
```

### E2E im Container

```bash
# Smoke-Lane im Container
sh scripts/e2e/run-smoke-in-container.sh

# Browser-Lane im Container
sh scripts/e2e/run-browser-in-container.sh

# Windows PowerShell
pwsh -File scripts/e2e/run-smoke-in-container.ps1
pwsh -File scripts/e2e/run-browser-in-container.ps1
```

---

## Unterstützte KI-Provider

| Provider                | Auth            | API-Endpunkt / Transport           |
| ----------------------- | --------------- | ---------------------------------- |
| OpenAI                  | API Key         | `api.openai.com/v1`                |
| OpenAI Codex            | OAuth           | `chatgpt.com/backend-api`          |
| Google Gemini           | API Key         | Google GenAI SDK                   |
| Anthropic               | API Key         | `api.anthropic.com/v1/messages`    |
| OpenRouter              | API Key / OAuth | `openrouter.ai/api/v1`             |
| Ollama (Local)          | none / API Key  | `localhost:11434/v1`               |
| LM Studio (Local)       | none / API Key  | `localhost:1234/v1`                |
| xAI                     | API Key         | `api.x.ai/v1`                      |
| Mistral                 | API Key         | `api.mistral.ai/v1`                |
| Cohere                  | API Key         | `api.cohere.com/v2`                |
| Z.AI                    | API Key         | `api.z.ai/api/paas/v4`             |
| Kimi Code               | API Key         | `api.kimi.com/coding/v1`           |
| ByteDance ModelArk      | API Key         | `ark.cn-beijing.volces.com/api/v3` |
| GitHub Copilot / Models | OAuth / API Key | `api.github.com`                   |

Details: [Model Hub Provider Matrix](docs/architecture/model-hub-provider-matrix.md)

---

## Dokumentation

| Dokument                                                                 | Beschreibung                       |
| ------------------------------------------------------------------------ | ---------------------------------- |
| [docs/README.md](docs/README.md)                                         | Dokumentations-Index               |
| [docs/CORE_HANDBOOK.md](docs/CORE_HANDBOOK.md)                           | Technischer Gesamtüberblick        |
| [docs/API_REFERENCE.md](docs/API_REFERENCE.md)                           | Vollständige API-Referenz          |
| [docs/AUTH_SYSTEM.md](docs/AUTH_SYSTEM.md)                               | Authentifizierung und User-Kontext |
| [docs/SESSION_MANAGEMENT.md](docs/SESSION_MANAGEMENT.md)                 | Session-Management                 |
| [docs/MEMORY_SYSTEM.md](docs/MEMORY_SYSTEM.md)                           | Memory-System mit Embeddings       |
| [docs/OMNICHANNEL_GATEWAY_SYSTEM.md](docs/OMNICHANNEL_GATEWAY_SYSTEM.md) | Omnichannel-Messaging & Gateway    |
| [docs/MODEL_HUB_SYSTEM.md](docs/MODEL_HUB_SYSTEM.md)                     | Multi-Provider KI-System           |
| [docs/PERSONA_ROOMS_SYSTEM.md](docs/PERSONA_ROOMS_SYSTEM.md)             | Persona-System                     |
| [docs/PROJECT_WORKSPACE_SYSTEM.md](docs/PROJECT_WORKSPACE_SYSTEM.md)     | Projekt-Workspaces und Guard-Logik |
| [docs/TASKS_SYSTEM.md](docs/TASKS_SYSTEM.md)                             | Task-Lifecycle und Deliverables    |
| [docs/OPS_OBSERVABILITY_SYSTEM.md](docs/OPS_OBSERVABILITY_SYSTEM.md)     | Ops, Metriken und Observability    |
| [docs/AUTOMATION_SYSTEM.md](docs/AUTOMATION_SYSTEM.md)                   | Cron-basierte Automationen         |
| [docs/SKILLS_SYSTEM.md](docs/SKILLS_SYSTEM.md)                           | Skill-System & Tools               |
| [docs/CLAWHUB_SYSTEM.md](docs/CLAWHUB_SYSTEM.md)                         | ClawHub Skill-Repository           |
| [docs/KNOWLEDGE_BASE_SYSTEM.md](docs/KNOWLEDGE_BASE_SYSTEM.md)           | Knowledge Base (Beta)              |
| [docs/SECURITY_SYSTEM.md](docs/SECURITY_SYSTEM.md)                       | Security-Architektur               |
| [docs/DEPLOYMENT_OPERATIONS.md](docs/DEPLOYMENT_OPERATIONS.md)           | Deployment & Betrieb               |
| [docs/WORKER_SYSTEM.md](docs/WORKER_SYSTEM.md)                           | Legacy-Status (Worker entfernt)    |
| [docs/WORKER_ORCHESTRA_SYSTEM.md](docs/WORKER_ORCHESTRA_SYSTEM.md)       | Legacy-Status (Orchestra entfernt) |

---

## Wichtige Umgebungsvariablen

| Variable                               | Beschreibung                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| `MEMORY_PROVIDER`                      | Memory-Provider (`mem0` oder `sqlite` lokal)                                         |
| `MEM0_BASE_URL`                        | Mem0 Base URL                                                                        |
| `MEM0_API_KEY`                         | Mem0 API Key                                                                         |
| `MEM0_API_PATH`                        | Mem0 API Pfad (Default `/v1`)                                                        |
| `MEM0_TIMEOUT_MS`                      | Mem0 Request-Timeout                                                                 |
| `MEM0_MAX_RETRIES`                     | Mem0 Retry-Limit                                                                     |
| `MEM0_RETRY_BASE_DELAY_MS`             | Mem0 Retry-Backoff-Basis                                                             |
| `MEM0_LLM_PROVIDER`                    | Optionales Bootstrap-LLM für mem0-local (ohne Hardcode)                              |
| `MODEL_HUB_ENCRYPTION_KEY`             | Secret-Encryption-Key (in Produktion erforderlich)                                   |
| `OPENAI_OAUTH_CLIENT_ID`               | Optional: eigene OpenAI Codex OAuth Client ID                                        |
| `OPENAI_OAUTH_CLIENT_SECRET`           | Optional: Client Secret für eigenen OAuth-Client                                     |
| `OPENAI_OAUTH_REDIRECT_URI`            | Optional: Redirect URI für Codex OAuth                                               |
| `OPENAI_OAUTH_SCOPE`                   | Optional: OAuth Scope Override                                                       |
| `OPENAI_OAUTH_AUDIENCE`                | Optional: OAuth Audience Override                                                    |
| `OPENAI_OAUTH_AUTHORIZE_URL`           | Optional: OAuth Authorize URL Override                                               |
| `OPENAI_OAUTH_TOKEN_URL`               | Optional: OAuth Token URL Override                                                   |
| `MC_API_TOKEN`                         | Optional: Bearer Token für externe Mission Control API Calls                         |
| `WEBHOOK_SECRET`                       | HMAC-Secret für Agent-Completion Webhooks (in Production erforderlich)               |
| `ALLOW_INSECURE_WEBHOOKS`              | Expliziter Non-Production/Test-Fallback für fehlendes Webhook-Secret                 |
| `EXTERNAL_SKILLS_ENABLED`              | Explizite Freigabe für Installation und Ausführung externer Skills                   |
| `WHATSAPP_ALLOW_FROM`                  | Exakte, kommaseparierte WhatsApp-Absender-Allowlist                                  |
| `ALLOW_OPEN_WHATSAPP_INBOUND`          | Explizite Freigabe für offene WhatsApp-Eingänge ohne Allowlist                       |
| `WHATSAPP_WEBHOOK_FETCH_MEDIA`         | Aktiviert entfernten WhatsApp-Medienabruf (standardmäßig deaktiviert)                |
| `WHATSAPP_WEBHOOK_MEDIA_ALLOWED_HOSTS` | Exakte Host-Allowlist für entfernte WhatsApp-Anhänge                                 |
| `MESSAGES_DB_PATH`                     | Pfad zur Message-SQLite                                                              |
| `MEMORY_DB_PATH`                       | Pfad zur Memory-SQLite                                                               |
| `PERSONAS_DB_PATH`                     | Pfad zur Persona-SQLite                                                              |
| `PERSONAS_ROOT_PATH`                   | Root für Persona-Dateisystemdaten                                                    |
| `SKILLS_DB_PATH`                       | Pfad zur Skills-SQLite                                                               |
| `WHATSAPP_BRIDGE_URL`                  | WhatsApp Bridge URL                                                                  |
| `IMESSAGE_BRIDGE_URL`                  | iMessage Bridge URL                                                                  |
| `APP_URL`                              | Öffentliche App-URL (z. B. für Telegram Webhooks)                                    |
| `OPENCLAW_AUTONOMOUS_MAX_TOOL_CALLS`   | Tool-Budget für autonome Build-Ausführung                                            |
| `OPENCLAW_CHAT_STREAM_KEEPALIVE_MS`    | Keepalive-Intervall für `chat.stream`                                                |
| `OPENCLAW_SHELL_TIMEOUT_MS`            | Laufzeitlimit für `shell_execute`                                                    |
| `OPENCLAW_SHELL_MAX_BUFFER_BYTES`      | Output-Buffer-Limit für `shell_execute`                                              |
| `REQUIRE_AUTH`                         | Auth erzwingen (`true`/`false`, Default in Dev oft `false`)                          |
| `NEXTAUTH_SECRET`                      | Secret für NextAuth-JWT-Signierung                                                   |
| `PRINCIPAL_USER_ID`                    | Legacy-Workspace-Besitzer für Migrationen; in Production auf die Auth-User-ID setzen |
| `AUTH_DB_PATH`                         | Pfad zur Auth-SQLite                                                                 |
| `E2E_ALLOW_ANONYMOUS_AUTH`             | Nur für explizite loopback-E2E-Prozesse mit `HOSTNAME=127.0.0.1`                     |
| `SCHEDULER_HEALTH_TOKEN`               | Bearer-Token für Scheduler-Health-Checks                                             |
| `SWARM_RUNNER`                         | `server` oder `scheduler` — bestimmt, wer Agent-Room-Swarm ausführt                  |
| `AGENT_V2_MAX_REQUESTS_PER_MINUTE`     | WebSocket-Rate-Limit (Default 600)                                                   |
| `OPENCLAW_EXEC_APPROVALS_REQUIRED`     | Ausführungs-Approvals erforderlich (`true`/`false`)                                  |
| `TASK_WORKSPACES_ROOT`                 | Root-Verzeichnis für Task-Workspaces                                                 |
| `TELEGRAM_BOT_TOKEN`                   | Legacy-Fallback für Telegram-Bot (Channel-Outbound)                                  |
| `DISCORD_BOT_TOKEN`                    | Legacy-Fallback für Discord-Bot (Channel-Outbound)                                   |
| `SLACK_BOT_TOKEN`                      | Legacy-Fallback für Slack-Bot (Channel-Outbound)                                     |
| `WORLD_MODEL_MODE`                     | World-Model-Rollout (`off`, `shadow`, `required`, `canonical`)                       |
| `WORLD_MODEL_APP_DATABASE_URL`         | Scoped PostgreSQL-Credential für Web/API (`world_model_app`)                         |
| `WORLD_MODEL_WORKER_DATABASE_URL`      | Scoped PostgreSQL-Credential für Scheduler/Worker (`world_model_worker`)             |
| `WORLD_MODEL_RUNTIME_ROLE`             | Laufzeitrolle (`app` oder `worker`); wählt die passende World-Model-URL              |
| `WORLD_MODEL_DEFAULT_PERSONA_ID`       | Explizite Persona-Zuordnung für Legacy-Mission-Control-Task-Spiegelung               |
| `EMBEDDING_API_URL`                    | Embedding-API für pgvector (alternativ `OPENAI_BASE_URL` plus API-Key)               |
| `GRAPHITI_PROJECTOR_ENABLED`           | Explizite Aktivierung des Graphiti-Projektors; benötigt `GRAPHITI_BASE_URL`          |

Hinweis: Provider-Secrets für den Model-Hub werden über UI/API hinterlegt und verschlüsselt gespeichert (`MODEL_HUB_ENCRYPTION_KEY` erforderlich). Einige Legacy-Fallbacks und Channel-Bot-Token (z. B. `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `GEMINI_API_KEY`) werden weiterhin aus der Umgebung gelesen, sofern konfiguriert.

---

## WebSocket Gateway

Single endpoint path: `/ws` (clients must use `?protocol=v2`)

- **Verwendet**: `ws://localhost:3000/ws?protocol=v2`
- `protocol=v2` muss explizit gesetzt sein, sonst antwortet der Server mit `400 Bad Request`.

### Rate Limits

- v2: 600 requests/minute (Default, konfigurierbar über `AGENT_V2_MAX_REQUESTS_PER_MINUTE`)

---

## Lizenz

Proprietär - Alle Rechte vorbehalten.

---

_Für technische Details, Troubleshooting und fortgeschrittene Konfigurationen siehe die Dokumentation unter `docs/`._
