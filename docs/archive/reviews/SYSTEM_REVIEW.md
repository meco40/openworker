# 🔍 OpenClaw Gateway – Vollständiger System-Review

> **Erstellt:** 10. Februar 2026  
> **Letztes Update:** 11. Februar 2026 (v1.2.6 – WebSocket Gateway, Auth, Worker, Stats)  
> **Version:** v1.2.6  
> **Plattform:** Next.js 16 (App Router) · React 19 · TypeScript 5.8 (strict)  
> **Paketname:** `openclaw-gateway-control-plane`

---

## 📋 Inhaltsverzeichnis

1. [Executive Summary](#1-executive-summary)
2. [Systemarchitektur](#2-systemarchitektur)
3. [Technologie-Stack](#3-technologie-stack)
4. [Projektstruktur](#4-projektstruktur)
5. [Frontend-Komponenten](#5-frontend-komponenten)
6. [API-Schicht](#6-api-schicht)
7. [Server-Schicht](#7-server-schicht)
8. [WebSocket Gateway](#8-websocket-gateway)
9. [Datenhaltung](#9-datenhaltung)
10. [Messenger-Integration](#10-messenger-integration)
11. [AI Model Hub](#11-ai-model-hub)
12. [Skills-System](#12-skills-system)
13. [Autonomous Worker](#13-autonomous-worker)
14. [Memory-System](#14-memory-system)
15. [Sicherheit & Authentifizierung](#15-sicherheit--authentifizierung)
16. [Qualitätssicherung](#16-qualitätssicherung)
17. [Konfiguration & Umgebung](#17-konfiguration--umgebung)
18. [Stärken & Schwächen](#18-stärken--schwächen)
19. [Empfehlungen](#19-empfehlungen)
20. [Metriken](#20-metriken)

---

## 1. Executive Summary

**OpenClaw Gateway** ist eine umfassende **AI Gateway Control Plane** – ein webbasiertes Management-Dashboard zur Steuerung eines intelligenten, multi-channel AI-Assistenten. Die Anwendung ermöglicht:

- **Multi-Provider AI Routing** mit automatischem Fallback über 13 AI-Provider
- **Multi-Channel Messaging** über Telegram, WhatsApp, Slack, Discord, iMessage, Signal, Teams und WebChat
- **Echtzeit-Kommunikation** via WebSocket Gateway (SSE-Legacy vollständig entfernt)
- **Autonomen Worker** mit KI-gesteuerter Planung, Step-Execution und Workspace-Management
- **Skill-System** mit 8 integrierten Tool-Handlern + SQLite-basierter Skill-Registry
- **Voice Mode** mit Gemini Native Audio
- **Live Vision Canvas** mit Kamera-Streaming
- **Team-Management** mit Multi-Tenant-Unterstützung
- **Authentifizierung** via NextAuth v4 (JWT + Credentials Provider) ✅
- **Memory-System** mit Embedding-basierter semantischer Suche
- **Usage Statistics** mit Token-Tracking pro Provider/Modell

Das System basiert auf **Next.js 16 App Router** mit einem **Custom HTTP+WebSocket Server** (`server.ts`), **TypeScript strict mode** und nutzt **SQLite** für sämtliche Persistierung (Messages, Credentials, Model Hub, Worker Tasks, Skills, Memory, Token Usage, Logs, Users).

---

## 2. Systemarchitektur

### 2.1 Architekturdiagramm

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        🖥️  FRONTEND (React 19 / Next.js 16)                 │
│                                                                              │
│  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │Dashboard │ │   Chat   │ │ Model Hub │ │  Worker  │ │  Team Manager    │  │
│  │          │ │Interface │ │           │ │   View   │ │                  │  │
│  └──────────┘ └──────────┘ └───────────┘ └──────────┘ └──────────────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ Security │ │  Logs    │ │  Config   │ │  Skills  │ │  Task Monitor    │  │
│  │  Panel   │ │  View    │ │  Editor   │ │ Registry │ │                  │  │
│  └──────────┘ └──────────┘ └───────────┘ └──────────┘ └──────────────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────┐                       │
│  │ Profile  │ │ Exposure │ │   Live    │ │  Stats   │                       │
│  │   View   │ │ Manager  │ │  Canvas   │ │   View   │  🎙️ Voice Overlay     │
│  └──────────┘ └──────────┘ └───────────┘ └──────────┘                       │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                        📡 Sidebar Navigation                          │  │
│  │   13 Views · Companion Apps Status · Live Canvas · WS Connection      │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
                                     │
                          ┌──────────┴──────────┐
                          ▼                     ▼
┌─────────────────────────────┐  ┌─────────────────────────────────────────────┐
│  🔌 REST API (App Router)   │  │  🔌 WebSocket Gateway (/ws)                │
│                             │  │                                             │
│  36 route.ts files          │  │  Methods: chat.*, channels.*, presence.*,   │
│  channels/ · model-hub/    │  │  logs.*, sessions.*, worker.*               │
│  worker/ · skills/         │  │                                             │
│  memory/ · logs/ · stats/  │  │  Auth: next-auth/jwt Cookie-Validation      │
│  control-plane/ · auth/    │  │  Max 5 Connections/User · Tick/Keepalive    │
│  security/                 │  │  Auto-Reconnect Client (ws-client.ts)       │
└─────────────────────────────┘  └─────────────────────────────────────────────┘
                          │                     │
                          └──────────┬──────────┘
                                     ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                        ⚙️  SERVER-SCHICHT                                    │
│                                                                              │
│  ┌─────────────────┐  ┌──────────────┐  ┌──────────────────────────────┐    │
│  │ MessageService  │  │  WS Gateway  │  │      ModelHubService         │    │
│  │   (663 Zeilen)  │  │  Broadcast   │  │       (198 Zeilen)           │    │
│  │                 │  │              │  │                              │    │
│  │ • handleInbound │  │ • broadcast  │  │ • connectAccount             │    │
│  │ • handleWebUI   │  │ • events     │  │ • dispatchChat               │    │
│  │ • saveMessage   │  │ • methods    │  │ • dispatchWithFallback       │    │
│  │ • listMessages  │  │ • presence   │  │ • dispatchEmbedding          │    │
│  │ • sessionMgmt   │  │              │  │ • fetchModelsForAccount      │    │
│  └────────┬────────┘  └──────────────┘  │ • managePipeline             │    │
│           │                              └─────────────┬────────────────┘    │
│           ▼                                            │                    │
│  ┌─────────────────┐  ┌──────────────┐                 ▼                    │
│  │  SQLite DB      │  │ Credential   │  ┌──────────────────────────────┐    │
│  │ (messages.db)   │  │   Store      │  │    Provider Registry          │    │
│  │                 │  │ (SQLite)     │  │         (13 Provider)         │    │
│  │ • conversations │  │ • bot tokens │  │                              │    │
│  │ • messages      │  │ • API keys   │  │ Gemini │ OpenAI │ Anthropic  │    │
│  │ • memory        │  │ • secrets    │  │ Mistral│ Cohere │ xAI       │    │
│  │ • users         │  └──────────────┘  │ OpenRouter│ByteDance│Z.AI   │    │
│  │ • worker_tasks  │                     │ Kimi │ GitHub Copilot       │    │
│  │ • skills        │  ┌──────────────┐  └──────────────────────────────┘    │
│  │ • token_usage   │  │ Worker       │                                      │
│  │ • logs          │  │ Subsystem    │  ┌──────────────────────────────┐    │
│  └─────────────────┘  │              │  │     Skill Handlers           │    │
│                        │ • Agent      │  │                              │    │
│  ┌─────────────────┐  │ • Planner    │  │ file_read · shell_execute    │    │
│  │ Outbound Router │  │ • Executor   │  │ python_execute · github_query│    │
│  │   (6 Channels)  │  │ • Workspace  │  │ db_query · browser_snapshot  │    │
│  │                 │  │ • Repo       │  │ vision_analyze · search      │    │
│  │ Telegram → Bot  │  └──────────────┘  └──────────────────────────────┘    │
│  │ WhatsApp → Brdg │                                                        │
│  │ Discord  → Bot  │  ┌──────────────┐                                      │
│  │ Slack    → Hook │  │ Memory       │                                      │
│  │ iMessage → Brdg │  │ Service      │                                      │
│  │ WebChat  → WS   │  │ • embeddings │                                      │
│  └─────────────────┘  │ • vectorStore│                                      │
│                        └──────────────┘                                      │
└──────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                       🌐 EXTERNE DIENSTE                                     │
│                                                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ Telegram │ │ WhatsApp │ │ Discord  │ │  Slack   │ │   AI Provider    │  │
│  │ Bot API  │ │  Bridge  │ │ Bot API  │ │ Webhook  │ │   APIs (13)      │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │
│  ┌──────────┐ ┌──────────┐                                                   │
│  │ iMessage │ │  Signal  │                                                   │
│  │  Bridge  │ │ (geplant)│                                                   │
│  └──────────┘ └──────────┘                                                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Datenfluss – Nachrichtenverarbeitung

```
    Benutzer sendet Nachricht
            │
            ▼
    ┌───────────────────┐
    │  Eingangskanal     │  (WebChat / Telegram / WhatsApp / Discord / Slack / iMessage)
    │  (Webhook/WS/UI)   │
    └────────┬──────────┘
             │
             ▼
    ┌───────────────────┐
    │  MessageService    │
    │  .handleInbound()  │
    │   (663 Zeilen)     │
    └────────┬──────────┘
             │
     ┌───────┴────────┐
     │                │
     ▼                ▼
  ┌──────┐     ┌────────────────┐
  │SQLite│     │ AI Gateway     │
  │SAVE  │     │ dispatchWith   │
  │user  │     │  Fallback()    │
  │msg   │     └───────┬────────┘
  └──────┘             │
                       ▼
              ┌────────────────┐
              │ Provider 1     │──✗──► Provider 2 ──✗──► Provider 3
              │ (Priority)     │       (Fallback)        (Fallback)
              └───────┬────────┘
                      │ ✓ Response
                      ▼
              ┌────────────────┐
              │ SQLite SAVE    │
              │ agent message  │
              │ + token usage  │
              └───────┬────────┘
                      │
            ┌─────────┴──────────┐
            │                    │
            ▼                    ▼
    ┌───────────────┐    ┌───────────────┐
    │ WS Broadcast  │    │   Outbound    │
    │ → WebUI Live  │    │   Router      │
    │   Update      │    │ → Telegram /  │
    └───────────────┘    │   WhatsApp /  │
                         │   Discord /   │
                         │   Slack /     │
                         │   iMessage    │
                         └───────────────┘
```

### 2.3 Architekturprinzipien

| Regel | Beschreibung                                                           |
| ----- | ---------------------------------------------------------------------- |
| **1** | UI-Komponenten enthalten keine Infrastruktur-Logik                     |
| **2** | API-Routes mappen Request/Response und delegieren an Server Use-Cases  |
| **3** | Business-Operationen leben in dedizierten Services/Use-Cases           |
| **4** | `src/shared` wird von Modulen/Server konsumiert, nicht umgekehrt       |
| **5** | Neuer Code vermeidet `any`-first APIs und hält strikte Typisierung ein |
| **6** | WebSocket für Echtzeit-Events, REST für CRUD-Operationen               |

---

## 3. Technologie-Stack

### 3.1 Kernabhängigkeiten

| Technologie          | Version                          | Zweck                                 |
| -------------------- | -------------------------------- | ------------------------------------- |
| **Next.js**          | 16.1.6                           | Full-Stack Framework (App Router)     |
| **React**            | 19.2.4                           | UI-Bibliothek                         |
| **TypeScript**       | 5.8.2                            | Typsichere Entwicklung (strict mode)  |
| **TailwindCSS**      | 4.1.18                           | Utility-first CSS Framework           |
| **Google GenAI SDK** | 1.40.0                           | Gemini API Client                     |
| **Recharts**         | 3.7.0                            | Dashboard-Charts & Usage Stats        |
| **SQLite**           | Node.js built-in (`node:sqlite`) | Sämtliche Persistierung               |
| **ws**               | 8.19.0                           | WebSocket Server                      |
| **NextAuth**         | 4.24.13                          | Authentifizierung (JWT + Credentials) |
| **Archiver**         | 7.0.1                            | ZIP-Export (Worker Workspaces)        |

### 3.2 Development Tooling

| Tool                            | Version | Zweck                                        |
| ------------------------------- | ------- | -------------------------------------------- |
| **ESLint**                      | 9.39.2  | Linting (Flat Config mit Security & SonarJS) |
| **Prettier**                    | 3.8.1   | Code-Formatierung                            |
| **Vitest**                      | 4.0.18  | Unit/Integration/Contract Testing            |
| **tsx**                         | 4.21.0  | TypeScript-Ausführung für Custom Server      |
| **PostCSS**                     | –       | CSS-Verarbeitung                             |
| **prettier-plugin-tailwindcss** | 0.7.2   | Tailwind-Klassen-Sortierung                  |

### 3.3 Scripts

| Script       | Befehl                              | Zweck                         |
| ------------ | ----------------------------------- | ----------------------------- |
| `dev`        | `tsx watch server.ts`               | Dev-Server (HTTP + WS)        |
| `dev:next`   | `next dev`                          | Reiner Next.js Dev-Server     |
| `build`      | `next build`                        | Production Build (Standalone) |
| `start`      | `node --import tsx server.ts`       | Production Start              |
| `test`       | `vitest run`                        | Test-Suite ausführen          |
| `test:watch` | `vitest`                            | Tests im Watch-Modus          |
| `typecheck`  | `tsc --noEmit`                      | Typ-Prüfung                   |
| `check`      | `typecheck && lint && format:check` | Vollständiger CI-Check        |
| `lint`       | `eslint .`                          | Lint-Prüfung                  |
| `format`     | `prettier . --write`                | Auto-Formatierung             |

### 3.4 ESLint-Konfiguration

Flat Config (50 Zeilen) mit:

- **Next.js Core Web Vitals** Regeln
- **TypeScript-ESLint** mit `@typescript-eslint/no-explicit-any: warn`
- **React Hooks** Plugin
- **Security Plugin** (`eslint-plugin-security`)
- **SonarJS** für Code-Qualität (no-identical-functions, no-ignored-return, no-useless-catch)
- **Prettier** Integration
- **React Refresh** Plugin

---

## 4. Projektstruktur

```
d:\web\clawtest\
├── 📄 App.tsx                        # Haupt-App-Komponente (256 Zeilen)
├── 📄 WorkerView.tsx                 # Autonomous Worker Entry (94 Zeilen)
├── 📄 types.ts                       # Globale Typ-Definitionen (233 Zeilen)
├── 📄 constants.ts                   # Konstanten & Initialdaten (88 Zeilen)
├── 📄 server.ts                      # Custom HTTP + WebSocket Server (100 Zeilen)
│
├── 📁 app/                           # Next.js App Router
│   ├── layout.tsx                    # Root Layout (Inter + Fira Code Fonts)
│   ├── page.tsx                      # Homepage → AppShell
│   ├── globals.css                   # Tailwind + Dark Theme Base
│   ├── 📁 login/                     # Login-Seite (NextAuth) ✅
│   │   ├── page.tsx
│   │   └── LoginForm.tsx
│   └── 📁 api/                       # API Routes (36 route.ts Dateien)
│       ├── 📁 auth/                  # NextAuth Route Handler ✅
│       ├── 📁 channels/              # Messenger APIs (12 Routen)
│       │   ├── conversations/        # Conversation CRUD
│       │   ├── messages/             # Message senden/abrufen
│       │   ├── pair/                 # Channel-Pairing
│       │   ├── inbox/                # Unified Inbox
│       │   ├── state/                # Channel State
│       │   ├── telegram/webhook/     # Telegram Webhook
│       │   ├── telegram/pairing/     # Telegram Pairing (confirm + poll)
│       │   ├── whatsapp/webhook/     # WhatsApp Webhook
│       │   ├── discord/webhook/      # Discord Webhook
│       │   ├── slack/webhook/        # Slack Webhook
│       │   └── imessage/webhook/     # iMessage Webhook
│       ├── 📁 model-hub/             # AI Model Management (10 Routen)
│       │   ├── accounts/             # Provider Accounts CRUD
│       │   ├── accounts/[id]/        # Einzelner Account
│       │   ├── accounts/[id]/models/ # Modelle pro Account
│       │   ├── accounts/[id]/test/   # Einzelner Connection-Test
│       │   ├── accounts/test-all/    # Batch Connection-Test
│       │   ├── gateway/              # KI-Dispatch Endpoint
│       │   ├── oauth/callback/       # OAuth Callback
│       │   ├── oauth/start/          # OAuth Start
│       │   ├── pipeline/             # Pipeline Management
│       │   └── providers/            # Provider-Katalog
│       ├── 📁 worker/                # Worker APIs (4 Routen)
│       │   ├── route.ts              # Task CRUD
│       │   ├── [id]/route.ts         # Einzelner Task
│       │   ├── [id]/export/          # ZIP-Export
│       │   └── [id]/files/           # Workspace Files CRUD
│       ├── 📁 skills/                # Skill APIs (3 Routen)
│       │   ├── route.ts              # Skill CRUD
│       │   ├── [id]/route.ts         # Einzelner Skill
│       │   └── execute/route.ts      # Skill-Ausführung
│       ├── 📁 memory/                # Memory API
│       ├── 📁 logs/                  # Logs API (inkl. Ingest + Stream)
│       ├── 📁 stats/                 # Usage Statistics API
│       ├── 📁 control-plane/         # Control Plane Metrics
│       └── 📁 security/              # Security Status
│
├── 📁 components/                    # UI-Komponenten (20 Dateien + 10 Sub-Komponenten)
│   ├── ChatInterface.tsx             # Multi-Channel Inbox (99 Zeilen, Thin Wrapper)
│   ├── Dashboard.tsx                 # Control Plane Dashboard (175 Zeilen)
│   ├── ModelHub.tsx                  # AI Model Hub (420 Zeilen)
│   ├── Sidebar.tsx                   # Navigation – 13 Views (148 Zeilen)
│   ├── ConnectionStatus.tsx          # WS-Verbindungsstatus (28 Zeilen)
│   ├── StatsView.tsx                 # Usage Statistics (482 Zeilen)
│   ├── LogsView.tsx                  # System Logs (446 Zeilen)
│   ├── TeamManager.tsx               # Team Collaboration (271 Zeilen)
│   ├── SecurityView.tsx              # Security Panel (207 Zeilen)
│   ├── VoiceOverlay.tsx              # Voice Mode (130 Zeilen)
│   ├── LiveCanvas.tsx                # Kamera-Stream + Vision (120 Zeilen)
│   ├── TaskManagerView.tsx           # Task Monitor (105 Zeilen)
│   ├── ProfileView.tsx               # SaaS Identity (99 Zeilen)
│   ├── WorkerFlow.tsx                # Worker Flow Visualisierung (97 Zeilen)
│   ├── ConfigEditor.tsx              # Gateway Config Editor (79 Zeilen)
│   ├── TerminalWizard.tsx            # Onboarding Wizard (79 Zeilen)
│   ├── ExposureManager.tsx           # API Exposure (75 Zeilen)
│   ├── ErrorBoundary.tsx             # React Error Boundary (245 Zeilen)
│   ├── ViewErrorBoundary.tsx         # Per-View Error Boundary (25 Zeilen)
│   ├── WorkerArtifacts.tsx           # Worker Artefakte (26 Zeilen)
│   ├── 📁 model-hub/                # Model Hub Sub-Komponenten (7 Dateien)
│   │   ├── sections/HeaderSection    # Header
│   │   ├── sections/PipelineSection  # Pipeline Config
│   │   ├── sections/SidebarSection   # Provider Sidebar
│   │   ├── modals/AddModelModal      # Add Model Dialog
│   │   ├── constants.ts / types.ts / utils.ts
│   └── 📁 worker/                    # Worker Sub-Komponenten (3 Dateien)
│       ├── WorkerTaskCreation.tsx     # Task-Erstellung (167 Zeilen)
│       ├── WorkerTaskDetail.tsx       # Task-Detail (485 Zeilen)
│       └── WorkerTaskList.tsx         # Task-Liste (134 Zeilen)
│
├── 📁 src/
│   ├── 📄 auth.ts                    # NextAuth Config (66 Zeilen) ✅
│   ├── 📁 modules/                   # Client-seitige Feature-Module
│   │   ├── 📁 app-shell/             # App Shell (14 Dateien, ~959 Zeilen)
│   │   │   ├── AppShell.tsx          # Entry Wrapper (Server Component)
│   │   │   ├── useConversationSync   # WS-basierte Conversation-Sync
│   │   │   ├── useGatewayState       # Gateway State Management
│   │   │   ├── useAgentRuntime       # Agent Response Handling (183 Z.)
│   │   │   ├── useTaskScheduler      # Task Scheduling
│   │   │   ├── useControlPlaneMetrics# Metrics Polling
│   │   │   ├── useChannelStateSync   # Channel State via WS (90 Z.)
│   │   │   ├── channelStorage        # LocalStorage Persistierung
│   │   │   ├── runtimeLogic          # Message-Deduplizierung
│   │   │   └── components/           # AppShellHeader, AppShellViewContent
│   │   ├── 📁 chat/                  # Chat-Modul (11 Dateien, ~762 Zeilen)
│   │   │   ├── hooks/useChatInterfaceState (172 Z.)
│   │   │   ├── components/           # ChatMainPane, ChatInputArea, etc.
│   │   │   └── services/             # routeMessage, handleAgentResponse
│   │   ├── 📁 gateway/               # WS Gateway Client (3 Dateien, 402 Zeilen)
│   │   │   ├── ws-client.ts          # WebSocket Client mit Auto-Reconnect (314 Z.)
│   │   │   └── useGatewayConnection  # React Hook für WS-Verbindung
│   │   ├── 📁 worker/                # Worker Hooks & Services (5 Dateien, 259 Zeilen)
│   │   │   ├── hooks/useWorkerTasks  # CRUD für Worker Tasks (129 Z.)
│   │   │   └── hooks/useWorkspaceFiles # Workspace File Management
│   │   └── 📁 (config|exposure|security|tasks|telemetry)/  # Re-Export Module
│   │
│   ├── 📁 server/                    # Server-seitige Logik
│   │   ├── 📁 auth/                  # Auth-System (3 Dateien, 204 Zeilen) ✅
│   │   │   ├── userStore.ts          # SQLite User Store (166 Z.)
│   │   │   ├── userContext.ts        # User Context Resolution (37 Z.)
│   │   │   └── constants.ts
│   │   ├── 📁 channels/              # Channel-Management (28+ Dateien, ~2.024 Zeilen)
│   │   │   ├── adapters/             # Channel Capabilities & Types
│   │   │   ├── credentials/          # Credential Store (SQLite, AES) ✅
│   │   │   ├── inbound/              # Message Normalization & Envelopes
│   │   │   ├── messages/             # Message Service (663 Z.) + SQLite Repo (535 Z.)
│   │   │   ├── outbound/             # Router (6 Channels: Telegram, WhatsApp, Discord, Slack, iMessage)
│   │   │   ├── pairing/              # Channel-Pairing (Telegram, Slack, Discord, unpair)
│   │   │   ├── routing/              # Adapter Registry, Inbound/Outbound Router
│   │   │   └── webhookAuth.ts        # Webhook Authentifizierung (56 Z.)
│   │   ├── 📁 gateway/               # WebSocket Gateway (14 Dateien, ~1.059 Zeilen) ✅
│   │   │   ├── connection-handler.ts # WS Connection Lifecycle (97 Z.)
│   │   │   ├── client-registry.ts    # Track connected WS Clients (75 Z.)
│   │   │   ├── broadcast.ts          # Broadcast to WS Clients (83 Z.)
│   │   │   ├── method-router.ts      # Route WS Method Calls (45 Z.)
│   │   │   ├── protocol.ts           # WS Protocol Definitions (82 Z.)
│   │   │   ├── events.ts             # Event Dispatch (92 Z.)
│   │   │   └── methods/              # chat, channels, presence, logs, sessions, worker
│   │   ├── 📁 model-hub/             # AI Provider Management (23 Dateien, ~1.699 Zeilen)
│   │   │   ├── Models/               # 13 Provider-Implementierungen
│   │   │   │   ├── gemini/           # Google Gemini (143 Z.)
│   │   │   │   ├── anthropic/        # Anthropic Claude (106 Z.)
│   │   │   │   ├── cohere/           # Cohere (105 Z.)
│   │   │   │   ├── github-copilot/   # GitHub Copilot (81 Z.)
│   │   │   │   ├── openai/           # OpenAI (20 Z.)
│   │   │   │   ├── openrouter/       # OpenRouter (39 Z.)
│   │   │   │   ├── bytedance/        # ByteDance (43 Z.)
│   │   │   │   ├── kimi/             # Kimi (20 Z.)
│   │   │   │   ├── mistral/          # Mistral (20 Z.)
│   │   │   │   ├── xai/              # xAI / Grok (20 Z.)
│   │   │   │   ├── zai/              # ZAI (32 Z.)
│   │   │   │   └── shared/           # HTTP Utils + OpenAI-compatible Base (191 Z.)
│   │   │   ├── repositories/         # SQLite Persistence (203 Z.) ✅
│   │   │   ├── service.ts            # ModelHubService (198 Z.)
│   │   │   ├── providerCatalog.ts    # Provider-Katalog (123 Z.)
│   │   │   ├── gateway.ts            # Gateway Dispatch (78 Z.)
│   │   │   ├── crypto.ts             # AES Verschlüsselung (50 Z.)
│   │   │   ├── oauth.ts              # OAuth Flow (59 Z.)
│   │   │   ├── connectivity.ts       # Health Checks (43 Z.)
│   │   │   └── modelFetcher.ts       # Modell-Abruf (42 Z.)
│   │   ├── 📁 skills/                # Skill-System (9+ Dateien, 656 Zeilen)
│   │   │   ├── skillRepository.ts    # SQLite Skill Repository (186 Z.)
│   │   │   ├── skillInstaller.ts     # GitHub/npm Skill Installer (177 Z.)
│   │   │   ├── builtInSkills.ts      # 8 Built-in Skills (33 Z.)
│   │   │   ├── executeSkill.ts       # Dispatcher (26 Z.)
│   │   │   └── handlers/             # 7 Skill-Handler
│   │   ├── 📁 worker/                # Worker Subsystem (7 Dateien, 1.258 Zeilen) ✅
│   │   │   ├── workerAgent.ts        # AI Agent (203 Z.)
│   │   │   ├── workerExecutor.ts     # Step-by-Step Execution (293 Z.)
│   │   │   ├── workerRepository.ts   # SQLite Task/Step/Artifact Storage (388 Z.)
│   │   │   ├── workspaceManager.ts   # Workspace Creation + ZIP Export (150 Z.)
│   │   │   ├── workerPlanner.ts      # AI-Driven Task Planning (49 Z.)
│   │   │   ├── workerCallback.ts     # Callback Handling (56 Z.)
│   │   │   └── workerTypes.ts        # Worker Types (119 Z.)
│   │   ├── 📁 memory/                # Memory Subsystem (5 Dateien, 272 Zeilen)
│   │   │   ├── service.ts            # Memory CRUD (80 Z.)
│   │   │   ├── sqliteMemoryRepository.ts # SQLite Memory Store (116 Z.)
│   │   │   ├── embeddings.ts         # Gemini Embedding Generation (52 Z.)
│   │   │   └── runtime.ts / repository.ts
│   │   ├── 📁 security/              # Security Status (212 Z.)
│   │   ├── 📁 stats/                 # Token Usage Tracking (223 Z.)
│   │   └── 📁 telemetry/             # Log Storage + Service (261 Z.)
│   │
│   └── 📁 shared/                    # Geteilte Utilities (7 Dateien, 213 Zeilen)
│       ├── toolConverters.ts         # Gemini ↔ OpenAI Tool Format (112 Z.)
│       ├── toolSchema.ts             # Tool Schema Definitionen (61 Z.)
│       ├── normalizeArgs.ts          # Argument Normalization (23 Z.)
│       └── config/ · lib/ · types/
│
├── 📁 services/                      # Client-Side Services (2 Dateien)
│   ├── audio.ts                      # Audio Recording/Playback (45 Z.)
│   └── gateway.ts                    # Legacy Gateway Client (193 Z.)
│
├── 📁 skills/                        # Client-Side Skill Definitions (12 Dateien, 600 Zeilen)
│   ├── SkillsRegistry.tsx            # Skills Management UI (317 Z.)
│   ├── definitions.ts / execute.ts / runtime-client.ts
│   └── (browser|filesystem|github-manager|python-runtime|search|shell-access|sql-bridge|vision)/
│
├── 📁 messenger/                     # Messenger UI Handlers (4 Dateien, 571 Zeilen)
│   ├── ChannelPairing.tsx            # Channel Pairing UI (294 Z.)
│   ├── shared/GenericChannelHandler  # Generischer Handler (120 Z.)
│   ├── telegram/TelegramHandler      # Telegram-spezifisch (98 Z.)
│   └── whatsapp/WhatsAppHandler      # WhatsApp-spezifisch (59 Z.)
│
├── 📁 core/memory/                   # Memory Client (5 Dateien, 217 Zeilen)
│   ├── embeddings.ts / gemini.ts / vectorStore.ts / types.ts / index.ts
│
├── 📁 tests/                         # Test-Suite (87 Dateien)
│   ├── 8 Root-Level Tests
│   ├── 📁 contract/                  # Contract Tests (2 Dateien)
│   ├── 📁 integration/               # Integration Tests (19 Dateien)
│   └── 📁 unit/                      # Unit Tests (58 Dateien, 15 Domains)
│
├── 📁 types/                         # Type Augmentations
│   └── next-auth.d.ts                # NextAuth Session/JWT Types
│
├── 📁 styles/                        # Zusätzliche Styles
│   └── worker.css                    # Worker UI Styles (681 Zeilen)
│
└── 📁 docs/                          # Dokumentation (15+ Dateien)
```

---

## 5. Frontend-Komponenten

### 5.1 App Shell & Navigation

**`App.tsx`** (256 Zeilen) ist die zentrale Komponente und orchestriert:

- **7 Custom Hooks**: `useConversationSync`, `useGatewayState`, `useTaskScheduler`, `useControlPlaneMetrics`, `useAgentRuntime`, `useChannelStateSync`, `useCallback`
- **State Management**: `currentView`, `onboarded`, `isCanvasOpen`, `isServerResponding`, `teams`, `tasks`, `skills`, `coupledChannels`
- **Dynamic Imports**: Alle Views werden lazy-loaded via `next/dynamic`
- **WebSocket-Integration**: Channel State Sync via WebSocket Gateway
- **Conversation-Management**: Multi-Conversation-Support via `useConversationSync`
- **Feature Flag**: `NEXT_PUBLIC_CHAT_PERSISTENT_SESSION_V2` togglet zwischen persistenter und Legacy-Message-Routing
- **Onboarding**: Guard rendert `TerminalWizard` bei Ersteinrichtung

**`Sidebar.tsx`** (148 Zeilen) bietet Navigation zu **13 Views**:

| View ID     | Label               | Funktion                      |
| ----------- | ------------------- | ----------------------------- |
| `dashboard` | Control Plane       | System-Übersicht & Metriken   |
| `worker`    | Autonomous Worker   | KI-Task-Ausführung            |
| `teams`     | Team Collaboration  | Multi-Team-Management         |
| `models`    | AI Model Hub        | Provider & Pipeline           |
| `channels`  | Messenger Coupling  | Channel-Pairing               |
| `chat`      | Multi-Channel Inbox | Nachrichten-Interface         |
| `skills`    | Skill Registry      | Tool-Verwaltung               |
| `tasks`     | Task Monitor        | Prozess-Monitoring            |
| `logs`      | System Logs         | Telemetrie-Stream             |
| `stats`     | Usage Stats         | Token-Verbrauch & Statistiken |
| `security`  | Security Panel      | Firewall & Whitelist          |
| `config`    | Gateway Config      | JSON-Konfiguration            |
| `profile`   | SaaS Identity       | Profil & Billing              |

Plus: **Companion Apps Status** (macOS Node, iOS Node), **ConnectionStatus**, **LIVE CANVAS** Button, Version `v1.2.4`.

### 5.2 Komponenten-Detail

#### Chat Interface (`ChatInterface.tsx`, 99 Zeilen – Thin Wrapper)

Vollständig modularisiert in `src/modules/chat/`:

- **`useChatInterfaceState`** (172 Z.): State-Management-Hook
- **`ChatMainPane`** (124 Z.): Nachrichten-Anzeige mit Auto-Scroll
- **`ChatInputArea`** (137 Z.): Eingabe mit Datei-Upload (Drag & Drop, 10 MB Limit)
- **`ChatConversationList`** (93 Z.): Konversationsliste mit Wechsel
- **`InboxFilters`** (47 Z.): Unified Inbox Filter (All/webchat/telegram/whatsapp/discord/slack)
- **`ChatMessageAttachment`** (37 Z.): Attachment-Vorschau
- **`ChatDragOverlay`** (23 Z.): Drag-Overlay

#### Model Hub (`ModelHub.tsx`, 420 Zeilen)

Aufgeteilt in Sub-Komponenten unter `components/model-hub/`:

- **`HeaderSection`** (62 Z.): Hub-Header mit Status
- **`PipelineSection`** (173 Z.): Pipeline-Konfiguration mit Prioritäten
- **`SidebarSection`** (182 Z.): Provider-Liste mit Accounts
- **`AddModelModal`** (168 Z.): Model-Hinzufügen-Dialog
- **Persistenz**: Alle Daten via API in SQLite gespeichert ✅

#### Worker View (`WorkerView.tsx`, 94 Zeilen)

- **3-View State Machine**: `list` → `create` → `detail`
- **`useWorkerTasks`** Hook: CRUD (create, cancel, retry, resume, approve, delete, refresh)
- Sub-Komponenten: `WorkerTaskList` (134 Z.), `WorkerTaskCreation` (167 Z.), `WorkerTaskDetail` (485 Z.)
- Fresh Task Detail via `/api/worker/{id}` mit Steps + Artifacts

#### Stats View (`StatsView.tsx`, 482 Zeilen)

- **Token Usage Tracking**: Pro Provider, Modell und Zeitraum
- **Recharts Integration**: Area/Bar/Pie Charts
- **Zeitraum-Filter**: 24h, 7d, 30d, All

---

## 6. API-Schicht

### 6.1 Übersicht

**39 API-Routes** unter `app/api/`, aufgeteilt in 9 Domänen:

### 6.2 Channel APIs (12 Routen)

| Endpoint                                 | Methode   | Beschreibung                       |
| ---------------------------------------- | --------- | ---------------------------------- |
| `/api/channels/conversations`            | GET, POST | Konversationen auflisten/erstellen |
| `/api/channels/messages`                 | GET, POST | Nachrichten abrufen/senden         |
| `/api/channels/pair`                     | POST      | Channel koppeln/entkoppeln         |
| `/api/channels/inbox`                    | GET       | Unified Inbox (kanalübergreifend)  |
| `/api/channels/state`                    | GET       | Channel State abrufen              |
| `/api/channels/telegram/webhook`         | POST      | Telegram Webhook                   |
| `/api/channels/telegram/pairing/confirm` | POST      | Telegram Code-Pairing Bestätigung  |
| `/api/channels/telegram/pairing/poll`    | GET       | Telegram Pairing Polling           |
| `/api/channels/whatsapp/webhook`         | POST      | WhatsApp Webhook                   |
| `/api/channels/discord/webhook`          | POST      | Discord Webhook                    |
| `/api/channels/slack/webhook`            | POST      | Slack Webhook                      |
| `/api/channels/imessage/webhook`         | POST      | iMessage Webhook                   |

### 6.3 Model Hub APIs (10 Routen)

| Endpoint                              | Methode                  | Beschreibung                       |
| ------------------------------------- | ------------------------ | ---------------------------------- |
| `/api/model-hub/providers`            | GET                      | Provider-Katalog abrufen           |
| `/api/model-hub/accounts`             | GET, POST                | Provider-Accounts verwalten ✅     |
| `/api/model-hub/accounts/[id]`        | DELETE                   | Account löschen                    |
| `/api/model-hub/accounts/[id]/models` | GET                      | Modelle eines Accounts abrufen     |
| `/api/model-hub/accounts/[id]/test`   | POST                     | Einzelnen Account testen           |
| `/api/model-hub/accounts/test-all`    | POST                     | Alle Accounts testen               |
| `/api/model-hub/gateway`              | POST                     | KI-Request-Dispatch (mit Fallback) |
| `/api/model-hub/oauth/start`          | POST                     | OAuth Flow starten                 |
| `/api/model-hub/oauth/callback`       | GET                      | OAuth Callback                     |
| `/api/model-hub/pipeline`             | GET, POST, DELETE, PATCH | Pipeline-Modelle verwalten ✅      |

### 6.4 Worker APIs (4 Routen)

| Endpoint                  | Methode             | Beschreibung                  |
| ------------------------- | ------------------- | ----------------------------- |
| `/api/worker`             | GET, POST           | Tasks auflisten/erstellen     |
| `/api/worker/[id]`        | GET, PATCH, DEL     | Task-Detail/Update/Löschen    |
| `/api/worker/[id]/export` | GET                 | Workspace als ZIP exportieren |
| `/api/worker/[id]/files`  | GET, POST, PUT, DEL | Workspace Files CRUD          |

### 6.5 Weitere APIs

| Endpoint                     | Methode        | Beschreibung                  |
| ---------------------------- | -------------- | ----------------------------- |
| `/api/auth/[...nextauth]`    | GET, POST      | NextAuth Handler ✅           |
| `/api/skills`                | GET, POST      | Skills auflisten/installieren |
| `/api/skills/[id]`           | DELETE, PATCH  | Skill löschen/updaten         |
| `/api/skills/execute`        | POST           | Skill ausführen               |
| `/api/memory`                | GET, POST, DEL | Memory Entries CRUD           |
| `/api/logs`                  | GET            | Logs abrufen                  |
| `/api/logs/ingest`           | POST           | Log-Eintrag erstellen         |
| `/api/stats`                 | GET            | Usage Statistics abrufen      |
| `/api/control-plane/metrics` | GET            | Control Plane Metriken        |
| `/api/security/status`       | GET            | Security Status ✅            |

---

## 7. Server-Schicht

### 7.1 Custom Server (`server.ts`, 100 Zeilen)

Der Dev-/Production-Server kombiniert **Next.js HTTP** + **WebSocket** auf demselben Port:

- `http.createServer` wrapping Next.js Request Handler
- `WebSocketServer` mit `noServer`-Modus, Upgrade nur auf `/ws` Path
- **Auth**: `next-auth/jwt` `getToken` zur WS-Authentifizierung via Cookie
- **Fallback**: `legacy-local-user` wenn `REQUIRE_AUTH=false`
- **Limit**: Max 5 WS-Connections pro User
- **Keepalive**: Tick-Broadcast auf Intervall
- **Graceful Shutdown**: SIGTERM/SIGINT mit 10s Force-Exit

### 7.2 MessageService (`service.ts`, 663 Zeilen)

**Zentrale Nachrichtenverarbeitung** – deutlich gewachsen:

- Handelt Inbound Messages (WebChat, Telegram, WhatsApp, Discord, Slack, iMessage)
- Session Management (`sessionManager.ts`, 38 Z.)
- History Management (`historyManager.ts`, 38 Z.)
- Context Building (`contextBuilder.ts`, 34 Z.)
- Feature Flag Integration (`featureFlag.ts`, 3 Z.)
- Message Routing (`messageRouter.ts`, 57 Z.)
- Channel Bindings (`channelBindings.ts`, 29 Z.)
- SQLite Message Repository (`sqliteMessageRepository.ts`, 535 Z.)

### 7.3 Outbound Router

Routes Antworten an **6 externe Kanäle**:

| Kanal    | Datei         | Zeilen |
| -------- | ------------- | ------ |
| Telegram | `telegram.ts` | 25     |
| WhatsApp | `whatsapp.ts` | 19     |
| Discord  | `discord.ts`  | 25     |
| Slack    | `slack.ts`    | 26     |
| iMessage | `imessage.ts` | 19     |
| Router   | `router.ts`   | 87     |

### 7.4 Credential Store

**Persistenter Key-Value Store** (`credentialStore.ts`, 75 Z.):

- Speichert Bot-Tokens, API-Keys, Pairing-Secrets in **SQLite** (`channel_credentials`) ✅
- AES-Verschlüsselung
- Bleibt nach Neustart erhalten

---

## 8. WebSocket Gateway

### 8.1 Architektur (14 Dateien, ~1.059 Zeilen)

Vollständig neues **bidirektionales Echtzeit-Gateway** als Ersatz für das reine SSE-Push-Modell:

| Datei                   | Zeilen | Funktion                                     |
| ----------------------- | ------ | -------------------------------------------- |
| `connection-handler.ts` | 97     | WS Connection Lifecycle (auth, setup, close) |
| `client-registry.ts`    | 75     | Connected Clients pro User tracken           |
| `broadcast.ts`          | 83     | Broadcast an alle/gefilterte WS Clients      |
| `method-router.ts`      | 45     | Eingehende WS-Methoden routen                |
| `protocol.ts`           | 82     | Nachrichtenformat, Error Codes, Typen        |
| `events.ts`             | 92     | Event Dispatch an Clients                    |
| `constants.ts`          | 15     | Tick Interval, Max Payload                   |

### 8.2 WS Method-Handler

| Domäne   | Datei                 | Zeilen | Methoden                                                                            |
| -------- | --------------------- | ------ | ----------------------------------------------------------------------------------- |
| Chat     | `methods/chat.ts`     | 120    | `chat.send`, `chat.stream`, `chat.history`, `chat.conversations.list`, `chat.abort` |
| Channels | `methods/channels.ts` | 174    | `channels.list`, `channels.pair`, `channels.unpair`, `inbox.list`                   |
| Presence | `methods/presence.ts` | 38     | `presence.list`, `presence.whoami`                                                  |
| Logs     | `methods/logs.ts`     | 69     | `logs.list`, `logs.subscribe`, `logs.unsubscribe`, `logs.sources`, `logs.clear`     |
| Sessions | `methods/sessions.ts` | 67     | `sessions.delete`, `sessions.reset`, `sessions.patch`                               |
| Worker   | `methods/worker.ts`   | 81     | `worker.task.*`, `worker.approval.respond`                                          |

### 8.3 Client-Side WS Client (`ws-client.ts`, 314 Zeilen)

- **Auto-Reconnect** mit Exponential Backoff
- **Message Protocol** mit Request/Response Correlation
- **Event Subscription** für Echtzeit-Updates
- **React Hook** (`useGatewayConnection`, 84 Z.) für Komponentenintegration

---

## 9. Datenhaltung

### 9.1 SQLite-Datenbank

**Standort:** `.local/messages.db` (konfigurierbar)

Alle Repositories nutzen `node:sqlite` (experimentell). **SQLite-Tabellen:**

| Tabelle               | Repository                    | Zweck                       |
| --------------------- | ----------------------------- | --------------------------- |
| `conversations`       | `sqliteMessageRepository.ts`  | Chat-Konversationen         |
| `messages`            | `sqliteMessageRepository.ts`  | Nachrichten mit Attachments |
| `channel_credentials` | `credentialStore.ts`          | Bot-Tokens, API-Keys (AES)  |
| `model_hub_accounts`  | `sqliteModelHubRepository.ts` | Provider-Accounts (AES)     |
| `model_hub_pipeline`  | `sqliteModelHubRepository.ts` | Pipeline-Modelle            |
| `skills`              | `skillRepository.ts`          | Skill-Definitionen          |
| `worker_tasks`        | `workerRepository.ts`         | Worker Tasks                |
| `worker_steps`        | `workerRepository.ts`         | Task-Execution Steps        |
| `worker_artifacts`    | `workerRepository.ts`         | Task-Artefakte              |
| `memory_entries`      | `sqliteMemoryRepository.ts`   | Memory mit Embeddings       |
| `token_usage`         | `tokenUsageRepository.ts`     | Token-Verbrauch pro Request |
| `logs`                | `logRepository.ts`            | Strukturierte System-Logs   |
| `users`               | `userStore.ts`                | User Credentials (Auth)     |

### 9.2 Verschlüsselung

- **AES-Verschlüsselung** für sensitive Felder (API Keys, Bot Tokens)
- Implementiert in `crypto.ts` (50 Z.)
- Genutzt von Credential Store und Model Hub Repository

---

## 10. Messenger-Integration

### 10.1 Unterstützte Kanäle

| Kanal    | Typ     | Pairing      | Status     |
| -------- | ------- | ------------ | ---------- |
| WebChat  | Direkt  | –            | ✅ Voll    |
| Telegram | Webhook | Code-Pairing | ✅ Voll    |
| WhatsApp | Bridge  | Bridge-Setup | ✅ Basis   |
| Discord  | Webhook | Bot-Token    | ✅ Basis   |
| Slack    | Webhook | Webhook-URL  | ✅ Basis   |
| iMessage | Bridge  | Bridge-Setup | ✅ Basis   |
| Signal   | –       | –            | 🔮 Geplant |
| MS Teams | –       | –            | 🔮 Geplant |

### 10.2 Telegram-Integration (Detailliert)

- **Webhook** + **Long Polling** mit Auto-Resume
- **Code-Pairing**: Sicheres Koppeln über 6-stelligen Code
- **Pairing Flow**: `telegramCodePairing.ts` (132 Z.) + `telegramPolling.ts` (107 Z.)
- **Inbound Processing**: `telegramInbound.ts` (63 Z.)

### 10.3 Channel Pairing UI

`ChannelPairing.tsx` (294 Z.) bietet einheitliches UI für alle Plattformen.

---

## 11. AI Model Hub

### 11.1 Provider-Katalog (13 Provider)

| Provider        | Adapter-Typ           | Auth    |
| --------------- | --------------------- | ------- |
| Google Gemini   | Native SDK (143 Z.)   | API Key |
| Anthropic       | Custom (106 Z.)       | API Key |
| OpenAI          | OpenAI-compat (20 Z.) | API Key |
| Cohere          | Custom (105 Z.)       | API Key |
| Mistral         | OpenAI-compat (20 Z.) | API Key |
| xAI (Grok)      | OpenAI-compat (20 Z.) | API Key |
| OpenRouter      | OpenAI-compat (39 Z.) | API Key |
| ByteDance       | OpenAI-compat (43 Z.) | API Key |
| Kimi            | OpenAI-compat (20 Z.) | API Key |
| ZAI             | Custom (32 Z.)        | API Key |
| GitHub Copilot  | Custom (81 Z.)        | OAuth   |
| _OpenAI-compat_ | Shared Base (131 Z.)  | API Key |

### 11.2 Shared Patterns

- **`openaiCompatible.ts`** (131 Z.): Wiederverwendbarer Adapter für Provider mit OpenAI-kompatiblen APIs
- **`http.ts`** (60 Z.): Shared HTTP Request Utilities
- **`registry.ts`** (31 Z.): Provider Registry mit Lookup

### 11.3 Gateway Dispatch

- **Fallback-Chain**: Priorisierte Pipeline, automatischer Wechsel bei Fehler
- **Tool-Konvertierung**: Gemini ↔ OpenAI Format (`toolConverters.ts`, 112 Z.)
- **Embedding Support**: Dedizierter Embedding-Dispatch

---

## 12. Skills-System

### 12.1 Server-Side Skills

**8 Built-in Skill Handler:**

| Skill              | Handler-Datei        | Zeilen | Funktion                  |
| ------------------ | -------------------- | ------ | ------------------------- |
| `file_read`        | `fileRead.ts`        | 25     | Dateien lesen             |
| `shell_execute`    | `shellExecute.ts`    | 31     | Shell-Kommandos ausführen |
| `python_execute`   | `pythonExecute.ts`   | 26     | Python-Code ausführen     |
| `github_query`     | `githubQuery.ts`     | 98     | GitHub API abfragen       |
| `db_query`         | `dbQuery.ts`         | 35     | SQL-Queries ausführen     |
| `browser_snapshot` | `browserSnapshot.ts` | 24     | Browser-Screenshots       |
| `vision_analyze`   | `visionAnalyze.ts`   | 40     | Bildanalyse via AI        |
| `search`           | _(client-side)_      | –      | Web-Suche                 |

### 12.2 Skill-Persistenz

- **SQLite Repository** (`skillRepository.ts`, 186 Z.): CRUD für Skill-Definitionen
- **Skill Installer** (`skillInstaller.ts`, 177 Z.): Installation von GitHub/npm
- Skills werden initial aus `builtInSkills.ts` geladen und in SQLite persisted

### 12.3 Client-Side Skills UI

- **`SkillsRegistry.tsx`** (317 Z.): Vollständige Skill-Verwaltungsoberfläche
- 8 Client-Side Skill-Adapter (browser, filesystem, github-manager, python-runtime, search, shell-access, sql-bridge, vision)

---

## 13. Autonomous Worker

### 13.1 Architektur (7 Dateien, 1.258 Zeilen)

Vollständig autonomes Task-Execution-System:

| Datei                 | Zeilen | Funktion                                    |
| --------------------- | ------ | ------------------------------------------- |
| `workerRepository.ts` | 388    | SQLite Storage für Tasks, Steps, Artifacts  |
| `workerExecutor.ts`   | 293    | Step-by-Step Task Execution Engine          |
| `workerAgent.ts`      | 203    | AI Agent für autonome Entscheidungen        |
| `workspaceManager.ts` | 150    | Workspace-Erstellung, File CRUD, ZIP Export |
| `workerTypes.ts`      | 119    | Typdefinitionen (10 Task-Status)            |
| `workerCallback.ts`   | 56     | Callback Handling für Worker Events         |
| `workerPlanner.ts`    | 49     | AI-gesteuertes Task Planning                |

### 13.2 Task-Lifecycle

```
queued → planning → executing → [waiting_approval] → review → completed
                 ↘ clarifying ↗          ↘ failed / cancelled / interrupted
```

**10 Task-Status:** `queued`, `planning`, `clarifying`, `executing`, `waiting_approval`, `review`, `completed`, `failed`, `cancelled`, `interrupted`

### 13.3 Workspace-Management

- Isolierte Workspaces pro Task
- File CRUD via `/api/worker/[id]/files`
- ZIP-Export via `/api/worker/[id]/export` (nutzt `archiver`)
- Workspace-Typen: `research`, `webapp`, `creative`, `data`, `general`

---

## 14. Memory-System

### 14.1 Server-Side (5 Dateien, 272 Zeilen)

- **`service.ts`** (80 Z.): Memory CRUD Operations
- **`sqliteMemoryRepository.ts`** (116 Z.): SQLite-basierter Memory Store
- **`embeddings.ts`** (52 Z.): Gemini Embedding Generation für semantische Suche
- **API**: `/api/memory` (GET, POST, DELETE)

### 14.2 Client-Side (`core/memory/`, 217 Zeilen)

- **`vectorStore.ts`** (47 Z.): In-Memory Vector Store für Client-Side Similarity Search
- **`gemini.ts`** (44 Z.): Gemini API Integration für Embeddings
- **`embeddings.ts`** (58 Z.): Embedding Utilities

---

## 15. Sicherheit & Authentifizierung

### 15.1 Authentifizierung ✅ (Zuvor P1-Schwäche – jetzt behoben)

**NextAuth v4** mit JWT-Strategie vollständig implementiert:

| Komponente        | Datei                                  | Zeilen | Funktion                                         |
| ----------------- | -------------------------------------- | ------ | ------------------------------------------------ |
| Auth Config       | `src/auth.ts`                          | 66     | `authOptions` mit Credentials Provider           |
| User Store        | `src/server/auth/userStore.ts`         | 166    | SQLite User Store mit Password Hashing           |
| User Context      | `src/server/auth/userContext.ts`       | 37     | `resolveUserIdFromSession()`, `isAuthRequired()` |
| Route Handler     | `app/api/auth/[...nextauth]`           | 6      | NextAuth API Routes                              |
| Login Page        | `app/login/page.tsx` + `LoginForm.tsx` | 82     | Login UI                                         |
| Type Augmentation | `types/next-auth.d.ts`                 | 23     | Session/JWT Type Extensions                      |
| WS Auth           | `server.ts`                            | –      | `getToken` Cookie-Validation                     |

- **`REQUIRE_AUTH`** Umgebungsvariable: `true` = Login erforderlich, `false` = `legacy-local-user` Fallback
- **WS-Authentifizierung**: Cookie-basiert via `next-auth/jwt` `getToken`
- **Max 5 WS-Connections** pro authentifiziertem User

### 15.2 Security Panel

- **`/api/security/status`** liefert echte Checks (Firewall, Encryption, Audit, Isolation) ✅
- **`SecurityView.tsx`** (207 Z.) zeigt Live-Status inkl. Severity und Detailtext
- **`CommandPermission`** System: 6 vordefinierte Regeln in `SECURITY_RULES`

### 15.3 Webhook-Authentifizierung

- `webhookAuth.ts` (56 Z.): Validiert eingehende Webhooks pro Kanal

---

## 16. Qualitätssicherung

### 16.1 Test-Suite

**87 Test-Dateien** mit **378 Tests** – alle bestanden ✅

| Kategorie       | Dateien | Beschreibung                                                                                                   |
| --------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| **Unit**        | 58      | 15 Domänen (auth, channels, chat, gateway, memory, model-hub, security, shared, stats, telemetry, worker, ...) |
| **Integration** | 19      | API-Route Tests, Persistent Session, Worker Files, Omnichannel                                                 |
| **Contract**    | 2       | Public API Contract, Provider Catalog                                                                          |
| **Root**        | 8       | Audio, Channel Pairing, Message Router, Skills, Tool Converters, Worker Repository                             |

**Test-Laufzeit:** ~9,5 Sekunden

### 16.2 Linting & Formatierung

- **ESLint 9** (Flat Config) mit 6 Plugin-Sets
- **Prettier** mit Tailwind CSS Plugin
- **TypeScript Strict Mode** mit `noEmit` Typecheck
- **CI-Check**: `npm run check` = typecheck + lint + format:check

---

## 17. Konfiguration & Umgebung

### 17.1 TypeScript (`tsconfig.json`, 54 Zeilen)

- **Target:** ES2022
- **Module Resolution:** Bundler
- **Strict Mode:** Enabled
- **Path Alias:** `@/*` → `./`

### 17.2 Next.js (`next.config.ts`, 10 Zeilen)

- **React Strict Mode:** Enabled
- **Output:** Standalone

### 17.3 Docker (`Dockerfile`, 41 Zeilen)

- Multi-Stage Build vorhanden

### 17.4 Umgebungsvariablen

| Variable                                 | Zweck                             |
| ---------------------------------------- | --------------------------------- |
| `REQUIRE_AUTH`                           | Auth aktivieren/deaktivieren      |
| `NEXTAUTH_SECRET`                        | NextAuth JWT Secret               |
| `NEXTAUTH_URL`                           | NextAuth Base URL                 |
| `NEXT_PUBLIC_CHAT_PERSISTENT_SESSION_V2` | Feature Flag: Persistent Sessions |
| `GEMINI_API_KEY`                         | Google Gemini API Key             |
| `ENCRYPTION_SECRET`                      | AES Encryption Key                |

---

## 18. Stärken & Schwächen

### ✅ Stärken

| #   | Bereich                        | Beschreibung                                                                |
| --- | ------------------------------ | --------------------------------------------------------------------------- |
| 1   | **Multi-Provider Gateway**     | 13 AI-Provider mit automatischem Fallback über Pipeline                     |
| 2   | **Vollständige Persistierung** | Alle Daten in SQLite (13 Tabellen) – kein Datenverlust bei Neustart         |
| 3   | **Authentifizierung**          | NextAuth v4 mit JWT, User Store, WS-Auth implementiert ✅                   |
| 4   | **WebSocket Gateway**          | Bidirektionales Echtzeit-Gateway mit Method Routing (1.059 Zeilen) ✅       |
| 5   | **TypeScript Strict**          | Strikte Typisierung mit 233 Zeilen Typ-Definitionen + Augmentations         |
| 6   | **Modulare Architektur**       | App.tsx auf 256 Zeilen reduziert, 7 Custom Hooks, Sub-Komponenten           |
| 7   | **Test-Abdeckung**             | 87 Test-Dateien, 378 Tests, alle bestanden                                  |
| 8   | **Autonomous Worker**          | Vollständiges Task-System mit AI Planning, Execution, Workspaces (1.258 Z.) |
| 9   | **Omnichannel Messaging**      | 6 aktive Kanäle + 2 geplant, Unified Inbox mit Filtern                      |
| 10  | **Telegram-Integration**       | Vollständig: Webhook + Polling + Auto-Resume + Code-Pairing                 |
| 11  | **Error Boundaries**           | Global + per-View Error Boundaries ✅                                       |
| 12  | **Memory System**              | Embedding-basierte semantische Suche mit Gemini                             |

### ⚠️ Offene Schwächen

| #   | Priorität | Bereich                 | Beschreibung                                                             |
| --- | --------- | ----------------------- | ------------------------------------------------------------------------ |
| 1   | **P2**    | **Rate Limiting**       | Kein Rate Limiting für API-Routes implementiert                          |
| 2   | **P2**    | **CORS-Konfiguration**  | Keine explizite CORS-Einschränkung                                       |
| 3   | **P2**    | **LogsView.tsx groß**   | 446 Zeilen – Kandidat für Modularisierung                                |
| 4   | **P2**    | **StatsView.tsx groß**  | 482 Zeilen – Kandidat für Modularisierung                                |
| 5   | **P3**    | **SQLite Experimental** | `node:sqlite` ist als experimental markiert – Risiko bei Node.js-Updates |

### ✅ Seit v1.2.5 behoben

| Bereich                          | Lösung                                                                      |
| -------------------------------- | --------------------------------------------------------------------------- |
| **(P1) Keine Authentifizierung** | NextAuth v4 mit JWT + Credentials Provider ✅                               |
| **(P1) Model Hub In-Memory**     | SQLite `sqliteModelHubRepository.ts` ✅                                     |
| **(P1) Credential Store**        | SQLite `credentialStore.ts` mit AES ✅                                      |
| **(P2) App.tsx Komplexität**     | 256 Zeilen, 7 Hooks, Sub-Komponenten ✅                                     |
| **(P2) Error Boundaries**        | `ErrorBoundary.tsx` + `ViewErrorBoundary.tsx` ✅                            |
| **(P2) ChatInterface.tsx groß**  | 99 Zeilen (Thin Wrapper), modularisiert in `src/modules/chat/` ✅           |
| **(P3) Security Panel statisch** | Live-Checks via `/api/security/status` ✅                                   |
| **(P3) Dual-Protokoll**          | SSE-Legacy entfernt (`channels/stream`, `logs/stream`, `sse/manager.ts`) ✅ |

---

## 19. Empfehlungen

### 🟡 Wichtig (P2)

1. **Rate Limiting implementieren**
   - Middleware für API-Routes
   - Per-User und Per-IP Limits

2. **CORS einschränken**
   - Explizite Allowed Origins in `next.config.ts`

3. **Komponenten-Splitting**
   - `LogsView.tsx` (446 Z.) → Hook + Sub-Komponenten
   - `StatsView.tsx` (482 Z.) → Hook + Sub-Komponenten
   - `WorkerTaskDetail.tsx` (485 Z.) → Sub-Komponenten

### 🟢 Nice-to-have (P3)

4. **SQLite-Migration**
   - Formales Migrations-System für Schema-Änderungen

5. **E2E-Tests**
   - Playwright/Cypress für kritische User Flows

6. **Monitoring**
   - Structured Logging für Production
   - Health-Check Endpoint für Load Balancer

---

## 20. Metriken

| Metrik                      | Wert                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Projekt-Name**            | `openclaw-gateway-control-plane`                                                                       |
| **Framework**               | Next.js 16.1.6 + React 19.2.4                                                                          |
| **Sprache**                 | TypeScript 5.8.2 (strict mode)                                                                         |
| **Runtime**                 | Custom Server (`tsx`) + WebSocket (`ws`)                                                               |
| **Auth**                    | NextAuth v4 (JWT + Credentials)                                                                        |
| **AI Engine**               | Google Gemini (`@google/genai`) + Multi-Provider Hub                                                   |
| **AI Provider**             | 13                                                                                                     |
| **Datenbank**               | SQLite (13 Tabellen via `node:sqlite`)                                                                 |
| **Messenger-Kanäle**        | 8 definiert, 6 aktiv                                                                                   |
| **Skills**                  | 8 Built-in                                                                                             |
| **Frontend Views**          | 15 (13 in Sidebar + Exposure + Wizard)                                                                 |
| **API Routes**              | 36 `route.ts` Dateien                                                                                  |
| **Komponenten**             | 30 Dateien, ~4.726 Zeilen                                                                              |
| **Server-Module**           | ~7.700 Zeilen (auth, channels, gateway, memory, model-hub, security, skills, stats, telemetry, worker) |
| **Client-Module**           | ~2.400 Zeilen (app-shell, chat, gateway, worker, ...)                                                  |
| **Test-Dateien**            | 87                                                                                                     |
| **Tests**                   | 378 (alle bestanden ✅)                                                                                |
| **TS/TSX Dateien (gesamt)** | ~346                                                                                                   |
| **TS/TSX Zeilen (gesamt)**  | ~26.300                                                                                                |
| **Styling**                 | Tailwind CSS 4.1.18 + `worker.css` (681 Z.)                                                            |
| **Docker**                  | Dockerfile (41 Z., Multi-Stage)                                                                        |
| **Dependencies**            | 8 Runtime + 24 Dev                                                                                     |
| **Dev-Server**              | `tsx watch server.ts`                                                                                  |
| **Build**                   | `next build` (Standalone Output)                                                                       |

---

_Dieser Review wurde auf Basis der tatsächlichen Codebasis aktualisiert._  
_Stand: 11. Februar 2026 · v1.2.6_
