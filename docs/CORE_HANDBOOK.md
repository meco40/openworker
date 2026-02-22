# Core Handbook

**Status:** 2026-02-22  
**Version:** 1.0.0  
**Purpose:** Authoritative technical reference for the OpenClaw Gateway Control Plane codebase

---

## Overview

This document serves as the **single source of truth** for the OpenClaw Gateway Control Plane architecture, development practices, and operational procedures. It provides comprehensive guidance for developers, operators, and maintainers working with the system.

Historical analyses, deprecated designs, and completed implementation plans are archived in `docs/archive/`.

## 2026-02-22 Errata (Current Runtime Delta)

- The legacy Rooms domain is removed from active runtime (`/api/rooms/*`, `src/server/rooms/*` no longer exist).
- New debug routes are active: `/api/debug/conversations`, `/api/debug/conversations/[id]/turns`, `/api/debug/conversations/[id]/replay`.
- Automation flow authoring is active via `/api/automations/[id]/flow` (`GET`/`PUT`) with server-side validation/compile.
- Proactive coupling was replaced by typed internal events (`chat.message.persisted`, `chat.summary.refreshed`) via `src/server/events/*` and `src/server/proactive/subscribers.ts`.
- If any deeper section in this handbook still references active Rooms runtime behavior, treat that section as historical until full handbook refresh.

---

## ASCII Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           OPENCLAW GATEWAY CONTROL PLANE                                │
│                              System Architecture Overview                               │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────┐     ┌─────────────────────────────────────────────┐
│         PRESENTATION LAYER          │     │          EXTERNAL SERVICES                  │
│  ┌───────────────────────────────┐  │     │  ┌─────────────┐  ┌─────────────────────┐   │
│  │     Next.js App Router        │  │     │  │   Mem0      │  │  LLM Providers      │   │
│  │  ┌─────────┐ ┌─────────────┐  │  │     │  │  (Vector    │  │  ┌───────────────┐  │   │
│  │  │   UI    │ │   API       │  │  │     │  │   Memory)   │  │  │  OpenAI       │  │   │
│  │  │ Routes  │ │   Routes    │  │  │     │  └──────┬──────┘  │  │  Anthropic    │  │   │
│  │  │ (app/*) │ │ (app/api/*) │  │  │     │         │         │  │  Gemini       │  │   │
│  │  └────┬────┘ └─────┬───────┘  │  │     │  ┌──────┴──────┐  │  │  Kimi         │  │   │
│  │       └────────────┘          │  │     │  │   SQLite    │  │  │  OpenRouter   │  │   │
│  │            │                  │  │     │  │  (Fallback) │  │  │  ...          │  │   │
│  └────────────┼──────────────────┘  │     │  └─────────────┘  │  └───────────────┘  │   │
│               │                     │     └───────────────────┴─────────────────────┘   │
│               │ WebSocket           │                              │                    │
│               ▼ /ws                 │                              │ HTTP/REST          │
├─────────────────────────────────────┤                              │                    │
│           GATEWAY LAYER             │◄─────────────────────────────┘                    │
│  ┌───────────────────────────────┐  │                                                   │
│  │   WebSocket Gateway (ws)      │  │     ┌─────────────────────────────────────────┐   │
│  │  ┌─────────────────────────┐  │  │     │     CHANNEL ADAPTERS                    │   │
│  │  │  Client Registry        │  │  │     │  ┌─────────┐ ┌─────────┐ ┌──────────┐   │   │
│  │  │  - Connection mgmt      │  │  │     │  │ Discord │ │ Slack   │ │ Telegram │   │   │
│  │  │  - Auth verification    │  │  │     │  └────┬────┘ └────┬────┘ └────┬─────┘   │   │
│  │  └─────────────────────────┘  │  │     │       │           │           │         │   │
│  │  ┌─────────────────────────┐  │  │     │  ┌────┴────┐ ┌───┴────┐ ┌──┴───────┐    │   │
│  │  │  Method Router          │  │  │     │  │ iMessage│ │WhatsApp│ │  Email   │    │   │
│  │  │  - RPC calls            │  │  │     │  └─────────┘ └────────┘ └──────────┘    │   │
│  │  │  - Event broadcasting   │  │  │     └─────────────────────────────────────────┘   │
│  │  └─────────────────────────┘  │  │                                                   │
│  └───────────────────────────────┘  │                                                   │
└───────────────────┬─────────────────┘                                                   │
                    │                                                                     │
                    │ Services                                                            │
┌───────────────────┼─────────────────────────────────────────────────────────────────────┤
│                   ▼                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │                         SERVER DOMAIN LAYER                                     │    │
│  │                                                                                 │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │    │
│  │  │   Channels  │  │    Rooms    │  │   Memory    │  │      Model Hub          │ │    │
│  │  │  ─────────  │  │  ─────────  │  │  ─────────  │  │  ────────────────────   │ │    │
│  │  │ • Routing   │  │ • Personas  │  │ • Mem0      │  │ • Multi-provider        │ │    │
│  │  │ • Adapters  │  │ • Sessions  │  │ • SQLite    │  │ • Fallback chain        │ │    │
│  │  │ • Webhooks  │  │ • Tools     │  │ • Recall    │  │ • Token tracking        │ │    │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └───────────┬─────────────┘ │    │
│  │         │                │                │                     │               │    │
│  │  ┌──────┴──────┐  ┌──────┴──────┐  ┌──────┴──────┐  ┌───────────┴─────────────┐ │    │
│  │  │  ClawHub    │  │   Skills    │  │  Knowledge  │  │      Automation         │ │    │
│  │  │  ─────────  │  │  ─────────  │  │  ─────────  │  │  ────────────────────   │ │    │
│  │  │ • Catalog   │  │ • Built-in  │  │ • Episodes  │  │ • Scheduled tasks       │ │    │
│  │  │ • Install   │  │ • Custom    │  │ • Ledgers   │  │ • HTTP triggers         │ │    │
│  │  │ • Lifecycle │  │ • Execution │  │ • Ingestion │  │ • Cron engine           │ │    │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────────────┘ │    │
│  │                                                                                 │    │
│  │  ┌─────────────────────────────────────────────────────────────────────────┐    │    │
│  │  │                         AUTH & SECURITY                                 │    │    │
│  │  │  • NextAuth v4 (JWT/Credentials)  • User Context  • Permission Checks   │    │    │
│  │  └─────────────────────────────────────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                     │                                                   │
│                                     │ Repositories                                      │
│                                     ▼                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │                      DATA PERSISTENCE LAYER                                     │    │
│  │                                                                                 │    │
│  │   SQLite (better-sqlite3)                                                       │    │
│  │   ├── messages          (chat history, FTS5 enabled)                            │    │
│  │   ├── conversations     (session metadata)                                      │    │
│  │   ├── channels          (omnichannel bindings)                                  │    │
│  │   ├── rooms             (collaboration spaces)                                  │    │
│  │   ├── memory_nodes      (local memory fallback)                                 │    │
│  │   ├── knowledge_*       (episodic memory)                                       │    │

│  │   └── automations       (scheduled jobs)                                        │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              RUNTIME MODES                                              │
│                                                                                         │
│   ┌─────────────────────┐    ┌─────────────────────┐    ┌─────────────────────────┐     │
│   │   Web Server        │    │   Scheduler         │    │   Combined (Dev)        │     │
│   │   (server.ts)       │    │   (scheduler.ts)    │    │   ROOMS_RUNNER=both     │     │
│   │   ─────────────     │    │   ─────────────     │    │   ─────────────────     │     │
│   │   HTTP + WS API     │    │   Cron execution    │    │   Full stack single     │     │
│   │   User-facing       │    │   Background tasks  │    │   process               │     │
│   └─────────────────────┘    └─────────────────────┘    └─────────────────────────┘     │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Technology Stack

### Core Framework

| Component            | Package      | Version | Purpose                     |
| -------------------- | ------------ | ------- | --------------------------- |
| **Framework**        | `next`       | ^16.1.6 | App Router, SSR, API routes |
| **UI Library**       | `react`      | ^19.2.4 | Component rendering, hooks  |
| **UI Library (DOM)** | `react-dom`  | ^19.2.4 | DOM bindings                |
| **Language**         | `typescript` | ~5.8.2  | Type-safe development       |
| **Runtime**          | `tsx`        | ^4.21.0 | TypeScript execution        |

### Realtime & Communication

| Component     | Package     | Version  | Purpose                        |
| ------------- | ----------- | -------- | ------------------------------ |
| **WebSocket** | `ws`        | ^8.19.0  | Gateway server & client        |
| **Auth**      | `next-auth` | ^4.24.13 | JWT/Credentials authentication |

### Data Persistence

| Component    | Package          | Version | Purpose               |
| ------------ | ---------------- | ------- | --------------------- |
| **Database** | `better-sqlite3` | ^12.6.2 | Primary SQLite driver |
| **Cron**     | `cron-parser`    | ^5.5.0  | Schedule parsing      |

### External Integrations

| Component         | Package         | Version  | Purpose                  |
| ----------------- | --------------- | -------- | ------------------------ |
| **Google GenAI**  | `@google/genai` | ^1.40.0  | Gemini API access        |
| **Flow Diagrams** | `@xyflow/react` | ^12.10.0 | Graph/flow visualization |
| **Archives**      | `archiver`      | ^7.0.1   | Workspace export         |
| **Charts**        | `recharts`      | ^3.7.0   | Metrics visualization    |

### Development Tools

| Category              | Package                | Version | Purpose                |
| --------------------- | ---------------------- | ------- | ---------------------- |
| **Linting**           | `oxlint`               | ^1.48.0 | Primary linter (fast)  |
| **TypeScript ESLint** | `@typescript-eslint/*` | ^8.55.0 | TS-specific rules      |
| **Formatting**        | `prettier`             | ^3.8.1  | Code formatting        |
| **Testing**           | `vitest`               | ^4.0.18 | Unit/integration tests |
| **Coverage**          | `@vitest/coverage-v8`  | ^4.0.18 | Test coverage          |
| **Styling**           | `tailwindcss`          | ^4.1.18 | Utility CSS            |
| **Git Hooks**         | `husky`                | ^9.1.7  | Pre-commit validation  |
| **Dead Code**         | `knip`                 | ^5.83.1 | Unused code detection  |

---

## Project Structure

```
openclaw-gateway-control-plane/
│
├── app/                                    # Next.js App Router
│   ├── api/                               # API route handlers
│   │   ├── auth/[...nextauth]/            # NextAuth configuration
│   │   ├── automations/                   # Automation rule endpoints
│   │   ├── channels/                      # Channel webhook endpoints
│   │   ├── clawhub/                       # ClawHub skill catalog routes
│   │   ├── health/                        # Health check endpoint
│   │   ├── model-hub/                     # Model Hub provider routes
│   │   ├── ops/                           # Ops/monitoring routes
│   │   ├── personas/                      # Persona CRUD routes
│   │   ├── rooms/                         # Room orchestration routes
│   │   └── skills/                        # Skill management routes
│   ├── layout.tsx                         # Root layout
│   ├── page.tsx                           # Home page
│   └── globals.css                        # Global styles
│
├── src/
│   ├── modules/                           # Frontend feature modules
│   │   ├── app-shell/                     # Core app state & runtime
│   │   ├── chat/                          # Chat interface components
│   │   ├── config/                        # Config UI module
│   │   ├── cron/                          # Automation scheduling UI
│   │   ├── exposure/                      # Exposure/analytics module
│   │   ├── gateway/                       # WebSocket client connection
│   │   ├── ops/                           # Ops dashboard module
│   │   ├── personas/                      # Persona management UI
│   │   ├── profile/                       # User profile configuration
│   │   ├── rooms/                         # Room management UI
│   │   ├── security/                      # Security overview UI
│   │   ├── tasks/                         # Task management UI
│   │   └── telemetry/                     # Telemetry/metrics UI
│   │
│   ├── server/                            # Server-side domains
│   │   ├── auth/                          # Authentication & authorization
│   │   │   ├── principal.ts               # Single-principal fallback
│   │   │   ├── userContext.ts             # User context resolution
│   │   │   └── userStore.ts               # User data persistence
│   │   │
│   │   ├── automation/                    # Scheduled task system
│   │   │   ├── cronEngine.ts              # Cron execution engine
│   │   │   ├── executor.ts                # Task execution logic
│   │   │   └── repository.ts              # Automation persistence
│   │   │
│   │   ├── channels/                      # Omnichannel messaging
│   │   │   ├── adapters/                  # Channel adapter definitions
│   │   │   ├── credentials/               # Secure credential storage
│   │   │   ├── inbound/                   # Incoming message handling
│   │   │   ├── messages/                  # Message processing pipeline
│   │   │   ├── outbound/                  # Outbound message dispatch
│   │   │   ├── pairing/                   # Channel-user pairing
│   │   │   └── routing/                   # Message routing logic
│   │   │
│   │   ├── clawhub/                       # ClawHub skill repository
│   │   │   ├── clawhubService.ts          # Skill search & install
│   │   │   └── searchParser.ts            # Query parsing
│   │   │
│   │   ├── gateway/                       # WebSocket gateway
│   │   │   ├── client-registry.ts         # Connection management
│   │   │   ├── connection-handler.ts      # WS connection lifecycle
│   │   │   ├── method-router.ts           # RPC method routing
│   │   │   └── methods/                   # Gateway method handlers
│   │   │
│   │   ├── knowledge/                     # Knowledge repository
│   │   │   ├── ingestionService.ts        # Auto-ingestion pipeline
│   │   │   ├── retrievalService.ts        # Context retrieval
│   │   │   └── sqliteKnowledgeRepository.ts # SQLite storage
│   │   │
│   │   ├── memory/                        # Memory system
│   │   │   ├── mem0Client.ts              # Mem0 API client
│   │   │   ├── service.ts                 # Memory operations
│   │   │   └── sqliteMemoryRepository.ts  # Local fallback storage
│   │   │
│   │   ├── model-hub/                     # LLM provider hub
│   │   │   ├── Models/                    # Provider implementations
│   │   │   │   ├── anthropic/             # Claude models
│   │   │   │   ├── gemini/                # Google Gemini
│   │   │   │   ├── kimi/                  # Moonshot Kimi
│   │   │   │   ├── openai/                # OpenAI GPT
│   │   │   │   ├── openrouter/            # OpenRouter gateway
│   │   │   │   └── ...                    # Additional providers
│   │   │   ├── service.ts                 # Provider selection & routing
│   │   │   └── types.ts                   # Shared type definitions
│   │   │
│   │   ├── personas/                      # AI persona definitions
│   │   │   └── personaTypes.ts            # Persona configuration types
│   │   │
│   │   ├── rooms/                         # Rooms collaboration system
│   │   │   ├── orchestrator.ts            # Room lifecycle management
│   │   │   ├── repositories/              # Data access layer
│   │   │   ├── toolExecutor.ts            # Room tool execution
│   │   │   └── runtimeRole.ts             # Runtime role configuration
│   │   │
│   │   ├── skills/                        # Skill system
│   │   │   ├── builtInSkills.ts           # Core skill definitions
│   │   │   ├── executeSkill.ts            # Skill execution engine
│   │   │   └── handlers/                  # Skill implementations
│   │   │       ├── shellExecute.ts        # Shell command skill
│   │   │       ├── fileRead.ts            # File reading skill
│   │   │       ├── pythonExecute.ts       # Python execution skill
│   │   │       └── ...                    # Additional skills
│   │   │
│   │   ├── stats/                         # Token usage & pricing
│   │   ├── telemetry/                     # Telemetry & events
│   │   └── config/                        # Configuration management
│   │
│   ├── shared/                            # Shared utilities & types
│   │   ├── config/                        # Shared configuration
│   │   ├── lib/                           # Utility functions
│   │   └── types/                         # Global type definitions
│   │
│   └── commands/                          # CLI commands & health checks
│       ├── doctorCommand.ts               # System diagnostics
│       └── health/                        # Health check implementations
│
├── components/                            # React UI components
│   └── ui/                               # Base UI component library
│
├── lib/                                  # Client-side utilities
│
├── tests/                                # Test suites
│   ├── unit/                             # Unit tests
│   ├── integration/                      # Integration tests
│   ├── contract/                         # Contract tests
│   ├── e2e/                              # End-to-end tests
│   └── helpers/                          # Shared test utilities
│
├── docs/                                 # Documentation
│   ├── archive/                          # Historical docs
│   ├── plans/                            # Active implementation plans
│   ├── runbooks/                         # Operational runbooks
│   └── *.md                              # System documentation
│
├── scripts/                              # Utility scripts
├── skills/                               # Custom skill definitions
├── workspaces/                           # Worker workspace storage
├── .local/                               # Local data & SQLite DBs
├── server.ts                             # Web server entry point
└── scheduler.ts                          # Scheduler entry point
```

---

## Architecture Principles

### 1. Separation of Concerns

**Principle:** UI components must not contain infrastructure execution logic.

```typescript
// ❌ BAD: Component handling business logic directly
function ChatComponent() {
  const handleSend = async (message) => {
    const response = await fetch('/api/model-hub/gateway', { ... });  // Don't do this
    const result = await processResponse(response);      // Business logic
    await saveToDatabase(result);                        // Infrastructure
  };
}

// ✅ GOOD: Component delegates to services
function ChatComponent() {
  const handleSend = async (message) => {
    await chatService.sendMessage(message);  // Delegated to service layer
  };
}
```

### 2. API Route Responsibility

**Principle:** API routes parse requests and delegate to services/use-cases. They contain no business logic.

```typescript
// app/api/channels/messages/route.ts
export async function POST(request: Request) {
  // 1. Parse & validate input
  const body = await request.json();
  const validated = chatRequestSchema.parse(body);

  // 2. Extract user context
  const userContext = await getUserContext();

  // 3. Delegate to service
  const result = await chatService.processMessage(validated, userContext);

  // 4. Return response
  return Response.json(result);
}
```

### 3. Business Logic Location

**Principle:** All business logic resides in `src/server/*` or feature-specific services.

```
src/server/
├── channels/messages/service.ts      # Message processing logic
├── memory/service.ts                  # Memory operations
├── rooms/orchestrator.ts              # Room orchestration
└── ...
```

### 4. Shared Dependencies

**Principle:** `src/shared` may be imported by any module, but never imports from `src/modules/*` or `src/server/*`.

```
Dependency Direction:
┌─────────────────┐
│  src/modules/*  │ ──┐
│  src/server/*   │ ──┼──► ┌───────────────┐
└─────────────────┘ ──┘    │  src/shared   │
                           │  (shared types│
                           │   & utilities)│
                           └───────────────┘
```

### 5. Type Safety

**Principle:** All code must be strictly typed with no `any` types except in exceptional cases with justification.

```typescript
// ✅ Good: Explicit types
interface UserContext {
  userId: string;
  personaId: string;
  permissions: Permission[];
}

function getUserContext(): UserContext {
  // ...
}

// ❌ Bad: Implicit any
function processData(data) {
  // Missing return type
  return data.map((x) => x.id); // x is implicitly any
}
```

### 6. Testability

**Principle:** All business logic must be testable without UI or infrastructure dependencies.

```typescript
// ✅ Good: Pure logic, injectable dependencies
export class MessageRouter {
  constructor(
    private channelRepo: ChannelRepository,
    private adapterRegistry: AdapterRegistry,
  ) {}

  async route(message: InboundMessage): Promise<RouteResult> {
    // Testable logic
  }
}

// Usage in tests
const router = new MessageRouter(mockRepo, mockRegistry);
```

---

## Development Workflow

### Getting Started

```bash
# Install dependencies
npm install

# Set up environment
copy .env.local.example .env.local
# Edit .env.local with your configuration

# Run development server (web + scheduler combined)
npm run dev

# Or run separately:
npm run dev:next      # Next.js only
npm run dev:scheduler # Scheduler only
```

### Development Modes

| Command                 | Description              | Use Case             |
| ----------------------- | ------------------------ | -------------------- |
| `npm run dev`           | Web + Scheduler combined | Local development    |
| `npm run dev:next`      | Next.js dev server only  | UI-focused work      |
| `npm run dev:scheduler` | Background tasks only    | Automation testing   |
| `npm run dev:stack`     | Alias for `npm run dev`  | Standard development |

### Code Quality Gates

Before committing, ensure all quality gates pass:

```bash
# Run all checks
npm run check

# Individual checks:
npm run typecheck   # TypeScript compilation check
npm run lint        # Oxlint validation
npm run format:check # Prettier format check
npm run test        # Vitest test suite
npm run build       # Production build
```

### Git Workflow

1. **Pre-commit hooks** (via Husky + lint-staged) automatically run:
   - Oxlint with auto-fix
   - Prettier formatting

2. **Commit message** should reference issue/plan when applicable:

   ```
   feat(rooms): add multi-persona support (#123)

   Implements room-level persona switching as per
   docs/archive/plans/completed/2026-02-12-rooms-multi-persona-design.md
   ```

3. **Pre-push verification** (recommended):
   ```bash
   npm run check && npm run test
   ```

### Adding New Features

1. **Document first:** Create or update plan in `docs/plans/`
2. **Define types:** Add shared types in `src/shared/types/`
3. **Implement server logic:** Add services in `src/server/<domain>/`
4. **Expose API:** Add route handlers in `app/api/`
5. **Build UI:** Add components in `src/modules/<feature>/`
6. **Write tests:** Add tests in `tests/`
7. **Update docs:** Keep this handbook and relevant docs current

---

## Realtime and Messaging System

### Architecture Overview

The system uses **WebSocket** as the primary realtime channel, replacing legacy SSE (Server-Sent Events) for chat and logs.

```
┌─────────────────────────────────────────────────────────────────┐
│                    REALTIME ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Client                      Gateway                    Server │
│   ─────                       ───────                    ────── │
│                                                                 │
│   ┌─────────┐                ┌──────────┐              ┌──────┐ │
│   │  React  │◄───WebSocket──►│  ws      │◄───Events──► │Rooms │ │
│   │  Hook   │    /ws         │  Server  │              │Orch. │ │
│   └────┬────┘                └────┬─────┘              └──┬───┘ │
│        │                          │                       │     │
│        │ JSON-RPC                 │ Broadcast             │     │
│        │ + Event Frames           │                       │     │
│   ┌────┴────┐                ┌────┴──────┐           ┌────┴───┐ │
│   │ Methods │                │ Registry  │           │Memory  │ │
│   │ - chat  │                │ - Users   │           │Channels│ │
│   │ - logs  │                │ - Sessions│           └────────┘ │
│   │ - sessns│                └───────────┘                      │
│   └─────────┘                                                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Message Frame Types

| Frame Type | Direction       | Description                                 |
| ---------- | --------------- | ------------------------------------------- |
| `req`      | Client → Server | Method invocation (`RequestFrame`)          |
| `res`      | Server → Client | Method result (`ResponseFrame`)             |
| `event`    | Server → Client | Broadcast notification (`EventFrame`)       |
| `stream`   | Server → Client | Token-by-token AI streaming (`StreamFrame`) |

### Channel Operations

Channel and inbox operations run server-side through `src/server/channels/*`:

```typescript
// Inbound message flow
Webhook → adapter → normalizer → router → message service → response

// Outbound message flow
Message service → outbound router → adapter → external API
```

### Supported Channels

| Channel  | Inbound | Outbound | Pairing Mode  |
| -------- | ------- | -------- | ------------- |
| Discord  | ✅      | ✅       | Webhook + Bot |
| Slack    | ✅      | ✅       | App + OAuth   |
| Telegram | ✅      | ✅       | Bot Token     |
| WhatsApp | ✅      | ✅       | Business API  |
| iMessage | ✅      | ✅       | Relay         |

---

## Rooms and Personas System

### Concept

**Rooms** are collaborative spaces where AI personas interact with users and each other. Each room has:

- **Members:** Users and personas participating
- **Context:** Shared conversation history
- **Tools:** Available capabilities for the room
- **Session:** Active conversation state

### Runtime Role Configuration

The `ROOMS_RUNNER` environment variable controls which runtime executes rooms:

| Value       | Description                               |
| ----------- | ----------------------------------------- |
| `web`       | Web server handles rooms (default)        |
| `scheduler` | Scheduler handles rooms                   |
| `both`      | Both runtimes can handle rooms (dev mode) |

### Persona Configuration

Personas define AI behavior, capabilities, and context:

```typescript
interface PersonaConfig {
  id: string;
  name: string;
  systemPrompt: string;
  model: string; // e.g., "gpt-4", "claude-3-opus"
  skills: string[]; // Available skill IDs
  memoryScope: 'user' | 'room' | 'global';
  temperature: number;
}
```

### Canonical Documentation

For complete rooms/personas documentation, see:

- `docs/PERSONA_ROOMS_SYSTEM.md` - System design
- `docs/SESSION_MANAGEMENT.md` - Session handling

---

## Security Model

### Authentication

- **Primary:** NextAuth v4 with JWT tokens
- **Fallback:** Credentials provider for local development
- **Anonymous:** Single-principal mode when `REQUIRE_AUTH=false`

### Authorization Layers

```
1. Gateway Level
   └── WebSocket connection authentication

2. API Route Level
   └── Privileged API checks (user context validation)

3. Service Level
   └── Resource ownership verification

4. Repository Level
   └── Query scoping by userId/personaId
```

### Command Security

Skills that execute system commands have additional safeguards:

```typescript
// Shell command validation in src/server/skills/handlers/shellExecute.ts
interface ShellCommandRule {
  allowedCommands: string[];
  blockedPatterns: RegExp[];
  requireConfirmation: boolean;
  maxExecutionTime: number;
}
```

### Channel Security

- **Webhook Authentication:** HMAC signature verification
- **Credential Storage:** Encrypted at rest via `src/server/channels/credentials/`
- **Rate Limiting:** Per-channel and per-user quotas

### Environment Variables

| Variable          | Security Level | Description             |
| ----------------- | -------------- | ----------------------- |
| `NEXTAUTH_SECRET` | Critical       | JWT signing key         |
| `MEM0_API_KEY`    | High           | External memory service |
| Provider API keys | High           | LLM service credentials |
| Channel tokens    | Medium         | Bot/app credentials     |

---

## Quality Gates

### Required Checks

All code must pass before merging:

```bash
# 1. TypeScript compilation
npm run typecheck

# 2. Oxlint validation
npm run lint

# 3. Test suite
npm run test

# 4. Production build
npm run build
```

### Automated Enforcement

**Pre-commit (Husky + lint-staged):**

```bash
*.{js,jsx,ts,tsx,mjs,cjs}
  → oxlint --fix
  → prettier --write

*.{json,md,css,scss,yml,yaml}
  → prettier --write
```

### Coverage Requirements

| Metric     | Minimum | Target |
| ---------- | ------- | ------ |
| Statements | 60%     | 70%    |
| Branches   | 60%     | 70%    |
| Functions  | 60%     | 70%    |
| Lines      | 60%     | 70%    |

Run coverage: `npm run test:coverage`

---

## Debugging Guide

### WebSocket Debugging

```bash
# Enable verbose logging
DEBUG=ws npm run dev

# Monitor gateway connections
curl http://localhost:3000/api/health
```

### Database Inspection

```bash
# SQLite CLI
sqlite3 .local/messages.db

# Common queries
.tables                                    # List tables
.schema channels                           # Table schema
SELECT * FROM messages LIMIT 10;          # Recent messages
```

### Common Issues

| Issue                         | Cause               | Solution                          |
| ----------------------------- | ------------------- | --------------------------------- |
| `WS 401 Unauthorized`         | Missing/invalid JWT | Check cookie, `NEXTAUTH_SECRET`   |
| `WS 429 Too Many Connections` | Connection limit    | Close old connections, max 5/user |
| `Mem0ConnectionError`         | API unreachable     | Check `MEM0_BASE_URL`, network    |
| `TypeError: Cannot read...`   | Missing null check  | Enable strict null checks         |
| `Build fails`                 | Type error          | Run `npm run typecheck`           |

### Logging Levels

```typescript
// Server-side logging
console.error('[domain] Fatal error'); // System errors
console.warn('[domain] Warning'); // Recoverable issues
console.info('[domain] Information'); // Significant events
console.debug('[domain] Debug'); // Development only
```

### Debug Mode

Enable debug features:

```bash
# .env.local
DEBUG_MODE=true
VERBOSE_LOGGING=true
```

---

## Testing Strategy

### Test Categories

| Category        | Location             | Purpose               | Example                 |
| --------------- | -------------------- | --------------------- | ----------------------- |
| **Unit**        | `tests/unit/`        | Individual functions  | Memory service tests    |
| **Integration** | `tests/integration/` | Component interaction | Gateway WebSocket tests |
| **Contract**    | `tests/contract/`    | API contracts         | Model provider tests    |
| **E2E**         | `tests/e2e/`         | End-to-end flows      | Chat flow tests         |

### Test Commands

```bash
# Run all tests
npm run test

# Watch mode
npm run test:watch

# With coverage
npm run test:coverage

# Specific test
npm run test -- tests/unit/memory/service.test.ts
```

### Writing Tests

```typescript
// tests/unit/example.test.ts
import { describe, it, expect, vi } from 'vitest';
import { myService } from '@/server/my/service';

describe('myService', () => {
  it('should process valid input', async () => {
    const result = await myService.process({ input: 'test' });
    expect(result).toEqual({ success: true });
  });

  it('should reject invalid input', async () => {
    await expect(myService.process({ input: '' })).rejects.toThrow('Input required');
  });
});
```

---

## Documentation Map

### Getting Started

| Document                | Purpose                                 | Audience   |
| ----------------------- | --------------------------------------- | ---------- |
| `docs/README.md`        | Entry point, navigation hub             | Everyone   |
| `docs/CORE_HANDBOOK.md` | This document - authoritative reference | Developers |

### System Documentation

| Document                                 | Purpose               | Key Topics                                       |
| ---------------------------------------- | --------------------- | ------------------------------------------------ |
| `docs/PERSONA_ROOMS_SYSTEM.md`           | Rooms & Personas      | Architecture, lifecycle, multi-persona           |
| `docs/OMNICHANNEL_GATEWAY_OPERATIONS.md` | Gateway operations    | WebSocket protocol, scaling                      |
| `docs/OMNICHANNEL_GATEWAY_SYSTEM.md`     | Gateway system design | Message routing, adapters                        |
| `docs/AUTH_SYSTEM.md`                    | Auth runtime          | NextAuth, session resolution, principal fallback |
| `docs/SESSION_MANAGEMENT.md`             | Session concepts      | Design principles, abort, idempotency            |

### Subsystem Documentation

| Document                           | Purpose                 | Key Topics                               |
| ---------------------------------- | ----------------------- | ---------------------------------------- |
| `docs/SKILLS_SYSTEM.md`            | Skill framework         | Built-in skills, custom skills           |
| `docs/WORKER_SYSTEM.md`            | Worker replacement docs | Current status, Ops/Rooms replacements   |
| `docs/WORKER_ORCHESTRA_SYSTEM.md`  | Orchestra replacement   | Rooms-based orchestration                |
| `docs/AUTOMATION_SYSTEM.md`        | Scheduled automation    | Cron, triggers, HTTP hooks               |
| `docs/MEMORY_SYSTEM.md`            | Memory system overview  | Mem0, SQLite, retrieval                  |
| `docs/memory-architecture.md`      | Memory architecture     | Detailed data flow, recall pipeline      |
| `docs/KNOWLEDGE_BASE_SYSTEM.md`    | Knowledge repository    | Episodes, ledgers, ingestion             |
| `docs/CLAWHUB_SYSTEM.md`           | Skill marketplace       | Search, install, management              |
| `docs/MODEL_HUB_SYSTEM.md`         | LLM provider hub        | Multi-provider, fallbacks                |
| `docs/OPS_OBSERVABILITY_SYSTEM.md` | Ops & observability     | Config, health, doctor, logs, stats, ops |
| `docs/SECURITY_SYSTEM.md`          | Security architecture   | Auth, authorization, encryption          |
| `docs/DEPLOYMENT_OPERATIONS.md`    | Deployment guide        | Production rollout, monitoring           |
| `docs/API_REFERENCE.md`            | API documentation       | Endpoints, schemas                       |

### Architecture References

| Document                                         | Purpose                      |
| ------------------------------------------------ | ---------------------------- |
| `docs/architecture/model-hub-provider-matrix.md` | Provider capability matrix   |
| `docs/ARCHITECTURE_DIAGRAM.md`                   | Visual architecture overview |

### Implementation Plans (Active)

Located in `docs/plans/` - Contains detailed implementation plans for in-progress features.

### Operational Runbooks

Located in `docs/runbooks/` - Step-by-step operational procedures:

- Gateway configuration rollout
- Chat CLI smoke approval
- Worker-related historical runbooks (see archive)

### Archive

Located in `docs/archive/` - Historical documents:

- Completed plans
- Review reports
- Legacy architecture docs

---

## Quick Reference

### Environment Variables (Essential)

```bash
# Core
NODE_ENV=development|production
PORT=3000
HOSTNAME=0.0.0.0

# Auth
NEXTAUTH_SECRET=your-secret-key
REQUIRE_AUTH=false|true

# Memory
MEMORY_PROVIDER=mem0|sqlite
MEM0_BASE_URL=https://api.mem0.ai
MEM0_API_KEY=your-mem0-key

# Model Hub
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
# ... provider-specific keys

# Runtime
ROOMS_RUNNER=web|scheduler|both
```

### Common Commands

```bash
# Development
npm run dev              # Start dev server
npm run dev:scheduler    # Start scheduler only

# Quality
npm run check            # All checks (type, lint, format)
npm run test             # Run tests
npm run test:coverage    # Coverage report

# Build
npm run build            # Production build
npm run start            # Start production server

# Utilities
npm run memory:reset     # Reset memory database
npm run knip             # Find unused code
```

---

**Document Maintenance:** Update this handbook when making architectural changes. Last updated: 2026-02-21
