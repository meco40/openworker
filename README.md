# BetaClaw Gateway Control Plane

**Stand:** 2026-10-09
**Version:** 0.1.0

---

## Überblick

BetaClaw Gateway ist eine **Next.js-basierte Multi-Channel-KI-Plattform** mit Unterstützung für:

- **Omnichannel-Messaging** (Telegram, WhatsApp, Discord, iMessage, Slack, WebChat)
- **Persistente Chat-Konversationen** mit Persona-Bindung und Streaming-Tool-Loop
- **Master Agent** für Plan-Delegation, Tool-Approvals und autonome Workflows
- **Automation- und Ops-Steuerung** über Scheduler, Ops-API und Runtime-Health
- **Skill-basiertes Tool-System** mit 34 Built-in Skills (11 Default + 23 opt-in/compat) + ClawHub-Erweiterungen
- **Konzeptuelles Memory** mit Embedding-basierter Ähnlichkeitssuche
- **Multi-Provider-KI** (14 Provider: OpenAI, OpenAI Codex, Anthropic, Google Gemini, OpenRouter, Ollama, LM Studio, xAI, Mistral, Cohere, Z.AI, Kimi Code, ByteDance, GitHub Copilot/Models)

---

## Schnellstart

Bestehende Installationen: [Hinweise zur BetaClaw-Umbenennung](docs/runbooks/betaclaw-rename.md).

### Voraussetzungen

Für den empfohlenen Selfhosting-Start genügen Git und Docker mit Compose v2.
Für native Entwicklung zusätzlich Node.js 22.22.1+ und pnpm 10.30.1;
der Commit-Hook benötigt Git 2.32+.

### Installation und erster Start (Docker)

Klonen und in den Projektordner wechseln. Kopiere dann `.env.local.example` nach
`.env.local` (`Copy-Item` unter PowerShell, `cp` unter Linux/macOS). Setze eigene,
unterschiedliche Werte für:

- `NEXTAUTH_SECRET` und `MODEL_HUB_ENCRYPTION_KEY`: jeweils 64 zufällige Hex-Zeichen.
- `POSTGRES_PASSWORD`, `WORLD_MODEL_APP_ROLE_PASSWORD` und
  `WORLD_MODEL_WORKER_ROLE_PASSWORD`: jeweils eigene zufällige Hex-Werte
  (URL-sicher, da sie in Datenbank-URLs eingesetzt werden).
- `AUTH_DEFAULT_EMAIL` und `AUTH_DEFAULT_PASSWORD`: dein erster Admin-Login.

Einen Hex-Wert erzeugst du ohne lokale Node-Installation mit:

```bash
docker run --rm node:22-bookworm-slim node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Führe den Befehl für jedes Secret separat aus. Veröffentliche die Werte niemals.
Anschließend:

```bash
docker compose --env-file .env.local up -d --build
docker compose --env-file .env.local ps
```

Compose startet PostgreSQL, führt die Migrationen aus, provisioniert getrennte
App-/Worker-Rollen und startet danach Web-App und Scheduler. Der Admin-Zugang
bleibt ausschließlich im Migrationsdienst. Das Image enthält Python 3 und den
zur installierten Playwright-Version passenden Chromium-Browser.
Daten, Persona-Dateien und Workspaces liegen in persistenten Compose-Volumes;
vorhandene Host-Daten unter `.local` werden nicht automatisch importiert.

Öffne [http://localhost:3000](http://localhost:3000) und melde dich mit deinem
Admin-Konto an. Verbinde unter **Model Hub** einen Provider, wähle im Profil
`p1` ein Modell und aktiviere es. Lege eine Persona an oder wähle eine vorhandene
Persona, starte einen Chat und prüfe eine Antwort. Memory-/Embedding-Funktionen
benötigen zusätzlich ein aktives kompatibles Modell im Profil `p1-embeddings`.
Die Anmeldung ist eingeschaltet; Code-/Befehlsausführung benötigt eine Freigabe.
Mem0 und Graphiti sind für diesen Standardstart nicht erforderlich.

Für Ollama/LM Studio auf dem Docker-Host verwendet Compose
`host.docker.internal`. Bei einem anderen Server setze `OLLAMA_BASE_URL`
(Ollama-Wurzel ohne `/v1`) bzw. `LMSTUDIO_BASE_URL` (mit `/v1`).
Der lokale Modellserver muss für den Container erreichbar sein.

Die App ist standardmäßig nur auf Host-Loopback veröffentlicht. Für Zugriff
über eine Domain nutze einen HTTPS-Reverse-Proxy mit WebSocket-Unterstützung
und setze `NEXTAUTH_URL` auf diese Domain. Passe die Portbindung bewusst an.
Selfhosting mit vertrauenswürdigem Betreiber ist der unterstützte Umfang:
Befehlsregeln und Freigaben sind keine Sandbox für fremden Code.

Logs und Stoppen:

```bash
docker compose --env-file .env.local logs --tail 100 web scheduler migrate
docker compose --env-file .env.local down
```

`down` erhält die Datenvolumes. `down -v` löscht sie und ist kein Upgrade-Schritt.
Vor Updates alle drei Volumes sichern und ein Restore prüfen. Nach Wechsel auf
einen neuen Stand erneut `up -d --build` ausführen; dabei läuft der separate
Migrationsdienst vor der Anwendung.

### Native Entwicklung

Die reproduzierbare Prüfung des Docker-Erststarts läuft mit
`pnpm run test:e2e:production` (Node.js und Docker erforderlich). Sie baut das
Image, erstellt eine eigene leere Datenbank, prüft echte Anmeldung, WebSocket,
Chat-Persistenz, Embeddings, Scheduler und Python/Chromium und räumt anschließend
nur ihre eigenen Testvolumes auf. Der Modellserver ist dabei ein lokales
HTTP-Testfixture; die Antwortqualität eines externen KI-Modells wird damit nicht bewertet.

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.local.example .env.local
# Secrets und den ersten Admin wie oben setzen.
docker compose -f docker-compose.postgres.yml up -d
pnpm run world-model:migrate
pnpm run dev
# In einem zweiten Terminal:
pnpm run dev:scheduler
```

Dieser Entwicklungsweg nutzt `CANONICAL_DATABASE_URL` aus der Vorlage und
eine lokale Datenbankverbindung. Für Produktion gelten die getrennten Rollen
des Docker-Starts. Python/Browser-Tools bei nativer Entwicklung benötigen
Python 3 bzw. `pnpm exec playwright install chromium`.

### Optionaler Mem0-Kompatibilitätsbetrieb

Der Standard-Memory-Provider ist PostgreSQL/canonical. Mem0 ist nur für einen
ausdrücklich konfigurierten Kompatibilitäts-/Migrationslauf nötig. Setze dann
`MEMORY_PROVIDER=mem0`, URL, API-Key und Pfad `/`. Vor einem Produktionsstart
müssen sowohl `MEM0_LLM_*` als auch `MEM0_EMBEDDER_*` konfiguriert sein und
`/health` HTTP 200 liefern; eine laufende, aber unkonfigurierte Mem0-API genügt
nicht. In der Entwicklung darf der Gateway für die erste Model-Hub-Konfiguration
degradiert starten. Der Standard-Compose-Pfad benötigt diesen Umweg nicht.

### Schlüssel und erster Login

Erzeuge einen eigenen Model-Hub-Schlüssel und trage ihn in `.env.local` ein:

```bash

node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"

```

Der Schlüssel muss 32 Bytes lang sein (64 Hex-Zeichen sind zulässig). Der veröffentlichte Beispielschlüssel wird abgelehnt. Nur isolierte Unit-Tests erlauben einen Test-Fallback. Bei vorhandenen Model-Hub-Konten müssen gespeicherte Secrets vor einem Schlüsselwechsel mit dem alten Schlüssel entschlüsselt und mit dem neuen erneut verschlüsselt werden; ein bloßer Austausch der Variable macht sie unlesbar.

Für den ersten lokalen oder produktiven Login setze `AUTH_DEFAULT_EMAIL` und ein eigenes `AUTH_DEFAULT_PASSWORD`, optional `AUTH_DEFAULT_NAME`. Es gibt keine voreingestellten Login-Daten. Ein bestehendes Konto mit dem früheren öffentlichen Standardpasswort wird bei explizit konfigurierten, sicheren Bootstrap-Daten aktualisiert; andere bestehende Passwörter bleiben erhalten. In Produktion verweigert eine leere Benutzerverwaltung die Initialisierung ohne Bootstrap-Daten. Verwende für Produktion außerdem `REQUIRE_AUTH=true` und einen eigenen `NEXTAUTH_SECRET`.

Private Umgebungsdateien, Datenbanken, interne Agent-Notizen und Testausgaben gehören nicht in Git. Der Workflow `Secret Scan` prüft alle erreichbaren Commits mit Gitleaks. Ein lokaler Scan nutzt dieselbe Konfiguration:

```bash

docker run --rm --network none -v "${PWD}:/repo:ro" zricethezav/gitleaks:v8.30.1 git /repo --config /repo/.gitleaks.toml --log-opts=--all --redact --ignore-gitleaks-allow --no-banner

```

### Produktion

Der empfohlene Produktionsweg ist der Docker-Schnellstart oben. Für einen
nativen Start müssen die Migrationen mit einem getrennten Admin-Zugang vor
dem Start ausgeführt sein und die Runtime-Verbindungen dedizierte Rollen nutzen:

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
| `MODEL_HUB_ENCRYPTION_KEY`             | Secret-Encryption-Key (in Entwicklung und Produktion erforderlich)                   |
| `OPENAI_OAUTH_CLIENT_ID`               | Optional: eigene OpenAI Codex OAuth Client ID                                        |
| `OPENAI_OAUTH_CLIENT_SECRET`           | Optional: Client Secret für eigenen OAuth-Client                                     |
| `OPENAI_OAUTH_REDIRECT_URI`            | Optional: Redirect URI für Codex OAuth                                               |
| `OPENAI_OAUTH_SCOPE`                   | Optional: OAuth Scope Override                                                       |
| `OPENAI_OAUTH_AUDIENCE`                | Optional: OAuth Audience Override                                                    |
| `OPENAI_OAUTH_AUTHORIZE_URL`           | Optional: OAuth Authorize URL Override                                               |
| `OPENAI_OAUTH_TOKEN_URL`               | Optional: OAuth Token URL Override                                                   |
| `MC_API_TOKEN`                         | Optional: Bearer-Token für die Mission-Control-API (siehe Netzwerkzugriff)           |
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
| `BETACLAW_AUTONOMOUS_MAX_TOOL_CALLS`   | Tool-Budget für autonome Build-Ausführung                                            |
| `BETACLAW_CHAT_STREAM_KEEPALIVE_MS`    | Keepalive-Intervall für `chat.stream`                                                |
| `BETACLAW_SHELL_TIMEOUT_MS`            | Laufzeitlimit für `shell_execute`                                                    |
| `BETACLAW_SHELL_MAX_BUFFER_BYTES`      | Output-Buffer-Limit für `shell_execute`                                              |
| `REQUIRE_AUTH`                         | Auth erzwingen (`true`/`false`, Default `false`; siehe Netzwerkzugriff)              |
| `HOSTNAME`                             | Bind-Adresse des Servers (Default `127.0.0.1`; Docker/Compose setzen `0.0.0.0`)      |
| `NEXTAUTH_SECRET`                      | Secret für NextAuth-JWT-Signierung                                                   |
| `PRINCIPAL_USER_ID`                    | Legacy-Workspace-Besitzer für Migrationen; in Production auf die Auth-User-ID setzen |
| `AUTH_DB_PATH`                         | Pfad zur Auth-SQLite                                                                 |
| `E2E_ALLOW_ANONYMOUS_AUTH`             | Nur für explizite loopback-E2E-Prozesse mit `HOSTNAME=127.0.0.1`                     |
| `SCHEDULER_HEALTH_TOKEN`               | Bearer-Token für Scheduler-Health-Checks                                             |
| `SWARM_RUNNER`                         | `server` oder `scheduler` — bestimmt, wer Agent-Room-Swarm ausführt                  |
| `AGENT_V2_MAX_REQUESTS_PER_MINUTE`     | WebSocket-Rate-Limit (Default 600)                                                   |
| `BETACLAW_EXEC_APPROVALS_REQUIRED`     | Ausführungs-Approvals erforderlich (`true`/`false`)                                  |
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

### Netzwerkzugriff und Authentifizierung

Der Server bindet ohne `HOSTNAME` nur an `127.0.0.1`. Anonymer Zugriff ohne Login (`REQUIRE_AUTH=false`) wird nur akzeptiert, wenn alle Bedingungen gelten:

- Die TCP-Verbindung kommt von einer Loopback-Adresse (`127.0.0.0/8`, `::1`). `Host`- oder `Origin`-Header allein reichen nicht, da sie jeder Client setzen kann.
- Der `Host` nennt `localhost`, `127.0.0.1`, `[::1]` oder eine `*.localhost`-Domain. Dadurch scheitern DNS-Rebinding-Angriffe.
- Die Anfrage kommt nicht aus einem fremden Browser-Origin (`Sec-Fetch-Site`, `Origin` oder `Referer` nennen einen anderen Host).

Ist `MC_API_TOKEN` gesetzt, ist anonymer Zugriff nur noch für same-origin Browser-UI möglich. Alle anderen Clients benötigen `Authorization: Bearer <token>`.

**Hinter einem Reverse Proxy, über Tailscale oder im LAN** muss `REQUIRE_AUTH=true` gesetzt oder `MC_API_TOKEN` verwendet werden. Andernfalls wird der Zugriff abgelehnt. Der Reverse Proxy muss den `Host`-Header unverändert weiterreichen (z. B. nginx `proxy_set_header Host $host;`), sonst lehnt der WebSocket-Upgrade auf `/ws` die Verbindung mit `403` ab.

---

## WebSocket Gateway

Single endpoint path: `/ws` (clients must use `?protocol=v2`)

- **Verwendet**: `ws://localhost:3000/ws?protocol=v2`
- `protocol=v2` muss explizit gesetzt sein, sonst antwortet der Server mit `400 Bad Request`.
- Browser-Handshakes aus einem fremden Origin werden mit `403 Forbidden` abgelehnt. Ohne Login akzeptiert `/ws` nur Loopback-Clients; siehe [Netzwerkzugriff und Authentifizierung](#netzwerkzugriff-und-authentifizierung).

### Rate Limits

- v2: 600 requests/minute (Default, konfigurierbar über `AGENT_V2_MAX_REQUESTS_PER_MINUTE`)

---

## Lizenz

Eigener Projektcode ist unter der [MIT-Lizenz](LICENSE) frei nutzbar, veränderbar und weiterverteilbar.

Fremdcode und Assets behalten ihre eigenen Lizenzen; siehe [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Der mitgelieferte Ready-Player-Me-Avatar ist auf nichtkommerzielle Nutzung beschränkt (CC BY-NC 4.0). Für kommerzielle Nutzung muss er durch ein passend lizenziertes Modell ersetzt werden.

---

_Für technische Details, Troubleshooting und fortgeschrittene Konfigurationen siehe die Dokumentation unter `docs/`._
