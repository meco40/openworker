# OpenClaw Architecture Blueprint

This diagram represents the actual implemented architecture of the **OpenClaw Gateway Control Plane**, reflecting the codebase structure including the **Orchestra** worker system, **ClawHub** services, and the **Multi-Provider** model hub.

```mermaid
graph TD
    %% ─── STYLES ──────────────────────────────────────────────────────────
    classDef client fill:#0f172a,stroke:#38bdf8,stroke-width:2px,color:#e0f2fe;
    classDef gateway fill:#1e293b,stroke:#a78bfa,stroke-width:2px,color:#ddd6fe;
    classDef core fill:#172554,stroke:#60a5fa,stroke-width:3px,color:#dbeafe;
    classDef worker fill:#3f1f1d,stroke:#f87171,stroke-width:2px,color:#fee2e2;
    classDef memory fill:#064e3b,stroke:#34d399,stroke-width:2px,color:#d1fae5;
    classDef ai fill:#312e81,stroke:#818cf8,stroke-width:2px,color:#e0e7ff;

    %% ─── 1. CLIENTS & CHANNELS ───────────────────────────────────────────
    subgraph Clients ["📡 Channels & Clients"]
        direction TB
        Web["💻 Web UI (Next.js)"]:::client

        subgraph Messenger ["Messaging Adapters"]
            TG["✈️ Telegram"]:::client
            WA["💬 WhatsApp"]:::client
            DIS["🎮 Discord"]:::client
            SL["🏢 Slack"]:::client
            IM["🍎 iMessage"]:::client
        end
    end

    %% ─── 2. SECURITY GATEWAY ─────────────────────────────────────────────
    subgraph Gateway ["🛡️ Security Layer"]
        direction TB
        WSS["WebSocket Server (ws)"]:::gateway
        Auth["NextAuth.js (JWT)"]:::gateway
        Webhook["Webhook Validator"]:::gateway
        RateLimit["Rate Limiter"]:::gateway
    end

    %% ─── 3. CORE SYSTEM ──────────────────────────────────────────────────
    subgraph Core ["🧠 Core Control Plane"]
        direction TB
        RoomOrch{{"Room Orchestrator"}}:::core
        Router["Message Router"]:::core
        ClawHub["ClawHub Service"]:::core

        %% Connect internal core components
        RoomOrch <--> Router
        RoomOrch <--> ClawHub
    end

    %% ─── 4. WORKER ORCHESTRA ─────────────────────────────────────────────
    subgraph Orchestra ["🎻 Orchestra Worker System"]
        direction TB
        Planner["Worker Planner"]:::worker
        Agent["Worker Agent"]:::worker
        Executor["Task Executor"]:::worker
        Scheduler["Orchestra Scheduler"]:::worker

        Planner --> Agent --> Executor
        Scheduler -.-> Planner
    end

    %% ─── 5. MODEL HUB ────────────────────────────────────────────────────
    subgraph ModelHub ["🤖 Model Hub (Multi-Provider)"]
        direction LR
        ProviderGateway["Provider Gateway"]:::ai

        Gemini["Google Gemini"]:::ai
        OpenAI["OpenAI / O4"]:::ai
        Anthropic["Anthropic Claude"]:::ai
        OpenRouter["OpenRouter"]:::ai
        xAI["xAI / Grok"]:::ai
        Mistral["Mistral"]:::ai
        Cohere["Cohere"]:::ai
        ByteDance["ByteDance"]:::ai
        GitHub["GitHub Models"]:::ai

        ProviderGateway --> Gemini & OpenAI & Anthropic & OpenRouter & xAI & Mistral & Cohere & ByteDance & GitHub
    end

    %% ─── 6. MEMORY SYSTEM ────────────────────────────────────────────────
    subgraph Memory ["💾 Memory Engine"]
        direction TB
        Mem0["Mem0 Client (User Memory)"]:::memory
        SQLite["SQLite Repository"]:::memory
        Vectors["Vector Embeddings"]:::memory
    end

    %% ─── CONNECTIONS ─────────────────────────────────────────────────────

    %% Client -> Gateway
    Web <==>|WS / HTTP| WSS
    Messenger -->|Webhook POST| Webhook

    %% Gateway -> Core
    WSS <==> RoomOrch
    Webhook --> Router
    RateLimit -.-> WSS

    %% Core -> Components
    RoomOrch <-->|Tasks| Planner
    RoomOrch <-->|Inference| ProviderGateway
    RoomOrch <-->|Context| Mem0
    ClawHub <-->|Sync| SQLite

    %% Worker Internal
    Executor -->|File I/O| SQLite

```

## System Modules

1.  **Channels**: Fully implemented adapters for Telegram, WhatsApp, Discord, Slack, and iMessage.
2.  **Core**: The `RoomOrchestrator` manages the event loop, while `ClawHub` manages distributed state.
3.  **Orchestra**: A dedicated worker system with its own Scheduler, Planner, and Executors for running background tasks.
4.  **Model Hub**: A unified gateway supporting 10+ providers including Gemini 2.5, GPT-4, Claude 3.7, and Grok.
5.  **Memory**: Hybrid memory system using `Mem0` and local SQLite vector storage.
