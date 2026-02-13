# OpenClaw Gateway Control Plane

**Stand:** 2026-02-13  
**Version:** 1.0.0

---

## Überblick

OpenClaw Gateway ist eine **Next.js-basierte Multi-Channel-KI-Plattform** mit Unterstützung für:

- **Omnichannel-Messaging** (Telegram, WhatsApp, Discord, iMessage, Slack, WebChat)
- **Multi-Persona-Rooms** mit persistenter Konversation und Orchestrierung
- **Autonome Worker-Agenten** für komplexe Aufgaben
- **Skill-basiertes Tool-System** mit 8 Built-in Skills + ClawHub-Erweiterungen
- **Konzeptuelles Memory** mit Embedding-basierter Ähnlichkeitssuche
- **Multi-Provider-KI** (11 Provider: OpenAI, Anthropic, Google Gemini, xAI, Mistral, Cohere, OpenRouter, Z.AI, Kimi, ByteDance, GitHub Copilot)

---

## Schnellstart

### Voraussetzungen

- Node.js 22+
- npm

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
# Web-Server starten
npm run dev

# Scheduler starten (optional, für Rooms und Automations)
npm run dev:scheduler
```

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
│   ├── server/            # Serverseitige Domänen
│   │   ├── channels/      # Omnichannel-Messaging
│   │   ├── rooms/         # Multi-Persona-Rooms
│   │   ├── worker/        # Autonome Agenten
│   │   ├── skills/        # Skill-Execution
│   │   ├── memory/        # Konzeptuelles Memory
│   │   ├── model-hub/     # Multi-Provider-KI
│   │   ├── security/      # Security-Checks
│   │   └── clawhub/       # ClawHub-Integration
│   ├── modules/           # Frontend Feature-Module
│   └── shared/            # Geteilte Typen & Utilities
├── skills/                # Skill-Definitionen
├── tests/                 # Unit-, Integrations- & Contract-Tests
├── docs/                  # Technische Dokumentation
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

# Vollständiger Check
npm run check

# Build (Produktion)
npm run build
```

---

## Unterstützte KI-Provider

| Provider           | Auth            | API-Endpunkt                       |
| ------------------ | --------------- | ---------------------------------- |
| OpenAI             | API Key         | `api.openai.com/v1`                |
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

| Dokument                                                                               | Beschreibung                                         |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [docs/README.md](docs/README.md)                                                       | Einstieg in die Projekt-Dokumentation                |
| [docs/CORE_HANDBOOK.md](docs/CORE_HANDBOOK.md)                                         | Technischer Gesamtüberblick (Stack, Regeln, Runtime) |
| [docs/PERSONA_ROOMS_SYSTEM.md](docs/PERSONA_ROOMS_SYSTEM.md)                           | Persona- und Rooms-Architektur                       |
| [docs/OMNICHANNEL_GATEWAY_OPERATIONS.md](docs/OMNICHANNEL_GATEWAY_OPERATIONS.md)       | Omnichannel-Betrieb & WebSocket Gateway              |
| [docs/SESSION_MANAGEMENT_IMPLEMENTATION.md](docs/SESSION_MANAGEMENT_IMPLEMENTATION.md) | Session-Management Implementierung                   |
| [docs/SKILLS_SYSTEM.md](docs/SKILLS_SYSTEM.md)                                         | Skill-Architektur & Handler                          |
| [docs/WORKER_SYSTEM.md](docs/WORKER_SYSTEM.md)                                         | Worker-Agenten System                                |
| [docs/MEMORY_SYSTEM.md](docs/MEMORY_SYSTEM.md)                                         | Memory-Architektur                                   |
| [docs/SECURITY_SYSTEM.md](docs/SECURITY_SYSTEM.md)                                     | Security-Architektur                                 |
| [docs/DEPLOYMENT_OPERATIONS.md](docs/DEPLOYMENT_OPERATIONS.md)                         | Deployment & Betrieb                                 |

---

## Optionale Umgebungsvariablen

| Variable              | Beschreibung                                               |
| --------------------- | ---------------------------------------------------------- |
| `GEMINI_API_KEY`      | Google Gemini API Key (erforderlich für Memory-Embeddings) |
| `OPENAI_API_KEY`      | OpenAI API Key                                             |
| `ANTHROPIC_API_KEY`   | Anthropic API Key                                          |
| `XAI_API_KEY`         | xAI API Key                                                |
| `MISTRAL_API_KEY`     | Mistral API Key                                            |
| `COHERE_API_KEY`      | Cohere API Key                                             |
| `OPENROUTER_API_KEY`  | OpenRouter API Key                                         |
| `Z_AI_API_KEY`        | Z.AI API Key                                               |
| `KIMI_API_KEY`        | Kimi/Moonshot API Key                                      |
| `BYTEDANCE_API_KEY`   | ByteDance ModelArk API Key                                 |
| `GITHUB_TOKEN`        | GitHub Token für GitHub-Skills                             |
| `MESSAGES_DB_PATH`    | Pfad zur SQLite-Datenbank (Standard: `.local/messages.db`) |
| `MEMORY_DB_PATH`      | Pfad zur Memory-Datenbank                                  |
| `WHATSAPP_BRIDGE_URL` | WhatsApp Bridge URL                                        |
| `IMESSAGE_BRIDGE_URL` | iMessage Bridge URL                                        |
| `APP_URL`             | Öffentliche App-URL (für Security-Checks)                  |

---

## Lizenz

Proprietär – Alle Rechte vorbehalten.

---

_Für technische Details, Troubleshooting und fortgeschrittene Konfigurationen, see die Dokumentation unter `docs/`._
