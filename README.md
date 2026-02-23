# OpenClaw Gateway Control Plane

**Stand:** 2026-02-23  
**Version:** 1.0.0

---

## Überblick

OpenClaw Gateway ist eine **Next.js-basierte Multi-Channel-KI-Plattform** mit Unterstützung für:

- **Omnichannel-Messaging** (Telegram, WhatsApp, Discord, iMessage, Slack, WebChat)
- **Persistente Chat-Konversationen** mit Persona-Bindung und Streaming-Tool-Loop
- **Automation- und Ops-Steuerung** über Scheduler, Ops-API und Runtime-Health
- **Skill-basiertes Tool-System** mit 10 Built-in Skills (8 Default + 2 opt-in) + ClawHub-Erweiterungen
- **Konzeptuelles Memory** mit Embedding-basierter Ähnlichkeitssuche
- **Multi-Provider-KI** (11 Provider: OpenAI, Anthropic, Google Gemini, xAI, Mistral, Cohere, OpenRouter, Z.AI, Kimi, ByteDance, GitHub Copilot)

---

## Schnellstart

### Voraussetzungen

- Node.js 22+
- npm
- Docker Desktop (fuer lokalen Mem0-Stack)

### Installation

```bash
# Abhängigkeiten installieren
npm install

# Environment-Variablen setzen (mindestens ein API-Key erforderlich)
cp .env.local.example .env.local
# Editiere .env.local mit deinen API-Keys
```

### Lokale Entwicklung

```bash
# Lokalen Mem0-Stack starten (Postgres + mem0 API)
npm run mem0:local:up

# Web-Server starten
npm run dev

# Scheduler starten (optional, für Automations-Läufe und Scheduler-Health)
npm run dev:scheduler
```

`npm run dev` startet nur, wenn Mem0 erreichbar ist. Fuer den lokalen Stack sind in `.env.local` mindestens diese Werte noetig:

- `MEMORY_PROVIDER=mem0`
- `MEM0_BASE_URL=http://127.0.0.1:8010`
- `MEM0_API_KEY=local-mem0-dev-token` (oder eigener Token)
- `GEMINI_API_KEY=<dein-key>` (wird vom lokalen Mem0-Service benoetigt)

### Produktion

```bash
# Build
npm run build

# Start
npm run start
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
│   ├── messenger/         # Messenger-Integrationen (Telegram, WhatsApp)
│   ├── modules/           # Frontend Feature-Module (Hooks, Services)
│   ├── server/            # Serverseitige Domänen (DDD)
│   │   ├── channels/      # Omnichannel-Messaging
│   │   ├── skills/        # Skill-Execution Engine
│   │   ├── memory/        # Konzeptuelles Memory
│   │   ├── model-hub/     # Multi-Provider-KI (11 Provider)
│   │   ├── security/      # Security-Checks
│   │   ├── clawhub/       # ClawHub-Integration
│   │   ├── knowledge/     # Knowledge Base System
│   │   ├── automation/    # Cron-basierte Automationen
│   │   └── gateway/       # WebSocket Gateway
│   ├── services/          # Externe Service-Integrationen
│   ├── shared/            # Geteilte Typen, Config & Utilities
│   └── skills/            # Skill-Definitionen & Handlers
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
npm run lint

# TypeScript-Typprüfung
npm run typecheck

# Tests (alle)
npm run test

# E2E Smoke (deterministisch, Vitest)
npm run test:e2e:smoke

# E2E Browser-Journeys (Playwright)
npm run test:e2e:browser

# E2E Live (Mem0, opt-in via MEM0_E2E=1)
npm run test:e2e:live

# Vollständiger Check
npm run check

# Build (Produktion)
npm run build
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

| Provider           | Auth            | API-Endpunkt                       |
| ------------------ | --------------- | ---------------------------------- |
| OpenAI             | API Key         | `api.openai.com/v1`                |
| OpenAI Codex       | OAuth           | `api.openai.com/v1`                |
| Anthropic          | API Key         | `api.anthropic.com/v1/messages`    |
| Google Gemini      | API Key         | Google GenAI SDK                   |
| xAI                | API Key         | `api.x.ai/v1`                      |
| Mistral            | API Key         | `api.mistral.ai/v1`                |
| Cohere             | API Key         | `api.cohere.com/v2`                |
| OpenRouter         | API Key / OAuth | `openrouter.ai/api/v1`             |
| Z.AI               | API Key         | `api.z.ai/api/paas/v4`             |
| Kimi (Moonshot)    | API Key         | `api.moonshot.cn/v1`               |
| ByteDance ModelArk | API Key         | `ark.cn-beijing.volces.com/api/v3` |
| GitHub Copilot     | OAuth / Token   | `api.github.com`                   |

Details: [Model Hub Provider Matrix](docs/architecture/model-hub-provider-matrix.md)

---

## Dokumentation

| Dokument                                                                 | Beschreibung                       |
| ------------------------------------------------------------------------ | ---------------------------------- |
| [docs/README.md](docs/README.md)                                         | Dokumentations-Index               |
| [docs/CORE_HANDBOOK.md](docs/CORE_HANDBOOK.md)                           | Technischer Gesamtüberblick        |
| [docs/SESSION_MANAGEMENT.md](docs/SESSION_MANAGEMENT.md)                 | Session-Management System          |
| [docs/MEMORY_SYSTEM.md](docs/MEMORY_SYSTEM.md)                           | Memory-System mit Embeddings       |
| [docs/OMNICHANNEL_GATEWAY_SYSTEM.md](docs/OMNICHANNEL_GATEWAY_SYSTEM.md) | Omnichannel-Messaging & Gateway    |
| [docs/MODEL_HUB_SYSTEM.md](docs/MODEL_HUB_SYSTEM.md)                     | Multi-Provider KI-System           |
| [docs/PERSONA_ROOMS_SYSTEM.md](docs/PERSONA_ROOMS_SYSTEM.md)             | Persona-System                     |
| [docs/WORKER_SYSTEM.md](docs/WORKER_SYSTEM.md)                           | Legacy-Status (Worker entfernt)    |
| [docs/WORKER_ORCHESTRA_SYSTEM.md](docs/WORKER_ORCHESTRA_SYSTEM.md)       | Legacy-Status (Orchestra entfernt) |
| [docs/AUTOMATION_SYSTEM.md](docs/AUTOMATION_SYSTEM.md)                   | Cron-basierte Automationen         |
| [docs/SKILLS_SYSTEM.md](docs/SKILLS_SYSTEM.md)                           | Skill-System & Tools               |
| [docs/CLAWHUB_SYSTEM.md](docs/CLAWHUB_SYSTEM.md)                         | ClawHub Skill-Repository           |
| [docs/KNOWLEDGE_BASE_SYSTEM.md](docs/KNOWLEDGE_BASE_SYSTEM.md)           | Knowledge Base (Beta)              |
| [docs/SECURITY_SYSTEM.md](docs/SECURITY_SYSTEM.md)                       | Security-Architektur               |
| [docs/DEPLOYMENT_OPERATIONS.md](docs/DEPLOYMENT_OPERATIONS.md)           | Deployment & Betrieb               |
| [docs/API_REFERENCE.md](docs/API_REFERENCE.md)                           | Vollständige API-Referenz          |

---

## Optionale Umgebungsvariablen

| Variable                    | Beschreibung                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY`            | Google Gemini API Key (erforderlich für Memory-Embeddings)                              |
| `OPENAI_API_KEY`            | OpenAI API Key                                                                          |
| `OPENAI_OAUTH_CLIENT_ID`    | Optional: eigene OpenAI Codex OAuth Client ID (Standard nutzt öffentliche Codex-App-ID) |
| `OPENAI_OAUTH_REDIRECT_URI` | Optional: Redirect URI für Codex OAuth (Default: `http://localhost:1455/auth/callback`) |
| `ANTHROPIC_API_KEY`         | Anthropic API Key                                                                       |
| `XAI_API_KEY`               | xAI API Key                                                                             |
| `MISTRAL_API_KEY`           | Mistral API Key                                                                         |
| `COHERE_API_KEY`            | Cohere API Key                                                                          |
| `OPENROUTER_API_KEY`        | OpenRouter API Key                                                                      |
| `Z_AI_API_KEY`              | Z.AI API Key                                                                            |
| `KIMI_API_KEY`              | Kimi/Moonshot API Key                                                                   |
| `BYTEDANCE_API_KEY`         | ByteDance ModelArk API Key                                                              |
| `GITHUB_TOKEN`              | GitHub Token für GitHub-Skills                                                          |
| `MESSAGES_DB_PATH`          | Pfad zur SQLite-Datenbank (Standard: `.local/messages.db`)                              |
| `MEMORY_DB_PATH`            | Pfad zur Memory-Datenbank                                                               |
| `WHATSAPP_BRIDGE_URL`       | WhatsApp Bridge URL                                                                     |
| `IMESSAGE_BRIDGE_URL`       | iMessage Bridge URL                                                                     |
| `APP_URL`                   | Öffentliche App-URL (für Security-Checks)                                               |

---

## Lizenz

Proprietär – Alle Rechte vorbehalten.

---

_Für technische Details, Troubleshooting und fortgeschrittene Konfigurationen, see die Dokumentation unter `docs/`._
