# Session Management System

**Stand:** 2026-02-17

## 1. Funktionserläuterung

Das Session-Management-System verwaltet Konversationen (Sessions) zwischen Benutzern und der KI. Es bietet vollständige Kontrolle über Chat-Verläufe inklusive Abbruch laufender Anfragen, Löschen, Zurücksetzen und Model-Overrides.

### Kernkonzepte

- **Conversation**: Eine Chat-Session mit Nachrichtenverlauf
- **Message**: Einzelne Nachricht (User oder AI)
- **AbortSignal**: Mechanismus zum Abbrechen laufender KI-Anfragen
- **Idempotency**: Verhinderung doppelter Nachrichten
- **Model Override**: Pro-Session Model-Auswahl

---

## 2. Workflow-Diagramme

### 2.1 Session Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Active: create
    Active --> Active: new message
    Active --> Generating: send to AI
    Generating --> Active: response
    Generating --> Aborted: abort()
    Active --> Deleted: delete()
    Active --> Reset: reset()
    Reset --> Active: new session
    Deleted --> [*]
```

### 2.2 Chat Flow mit Abort

```mermaid
sequenceDiagram
    participant U as User
    participant UI as ChatInput
    participant GW as Gateway
    participant MS as MessageService
    participant AC as AbortController
    participant MH as ModelHub

    U->>UI: Type message
    U->>UI: Press Send
    UI->>GW: chat.send
    GW->>MS: handleInbound()

    MS->>MS: Generate clientMessageId
    MS->>MS: Check deduplication
    MS->>AC: Create AbortController
    MS->>MS: Store active request

    MS->>MH: dispatchWithFallback(signal)

    par AI Processing
        MH-->>MS: Stream response
        MS-->>GW: Broadcast chunks
        GW-->>UI: Display stream
    and User Abort
        U->>UI: Click Stop
        UI->>GW: chat.abort
        GW->>MS: abortGeneration()
        MS->>AC: abort()
        AC-->>MH: AbortSignal triggered
        MH-->>MS: Request cancelled
        MS-->>GW: chat.aborted event
        GW-->>UI: Show stopped
    end
```

### 2.3 Idempotency Flow

```mermaid
flowchart TD
    A[Send Message] --> B[Generate clientMessageId]
    B --> C{In processing?}
    C -->|Yes| D[Return existing]
    C -->|No| E{In database?}
    E -->|Yes| F[Return saved]
    E -->|No| G[Add to processing]
    G --> H[Process message]
    H --> I[Save to DB]
    I --> J[Remove from processing]
    J --> K[Return result]
    D --> L[Response]
    F --> L
    K --> L
```

### 2.4 Model Override Flow

```mermaid
flowchart LR
    A[User selects model] --> B["PATCH /api/channels/conversations"]
    B --> C[Update model_override]
    C --> D[Store in DB]
    D --> E[Next message]
    E --> F{modelOverride?}
    F -->|Yes| G[Bypass fallback]
    F -->|No| H[Normal pipeline]
    G --> I[Use selected model]
    H --> J[Try fallback chain]
    I --> K[Response]
    J --> K
```

### 2.5 Session Reset Flow

```mermaid
sequenceDiagram
    participant U as User
    participant MR as MessageRouter
    participant MS as MessageService
    participant DB as SQLite
    participant GW as Gateway

    U->>MR: Type /new
    MR->>MR: Recognize SESSION_COMMAND
    MR->>MS: handleSessionCommand()
    MS->>DB: Create new conversation
    DB-->>MS: newConversationId
    MS->>GW: Broadcast conversation.reset
    GW->>U: Switch to new session
    MS-->>U: Confirmation message
```

---

## 3. Technische Architektur

### 3.1 Komponenten-Übersicht

```
src/server/channels/messages/
├── service.ts              # MessageService (Kern-Logik)
├── repository.ts           # Repository-Interface
├── sqliteMessageRepository.ts  # SQLite-Implementierung
├── messageRouter.ts        # Routing-Logik
├── messageRowMappers.ts    # DB-Mapping
├── historyManager.ts       # Verlaufs-Management
├── sessionManager.ts       # Session-Management
├── contextBuilder.ts       # Kontext-Aufbau
├── attachments.ts          # Datei-Anhänge
├── autoMemory.ts           # Automatisches Memory
└── statusIcons.ts          # Status-Indikatoren
```

### 3.2 Klassendiagramm

```mermaid
classDiagram
    class MessageService {
        +handleInbound(message): Result
        +sendMessage(conversationId, content): Message
        +abortGeneration(conversationId): void
        +deleteConversation(id): void
        +resetConversation(id): Conversation
        +setModelOverride(id, model): void
        -processingMessages: Set
        -activeRequests: Map
    }

    class Conversation {
        +string id
        +string userId
        +string title
        +string modelOverride
        +Date createdAt
        +Date updatedAt
        +Message[] messages
    }

    class Message {
        +string id
        +string conversationId
        +string clientMessageId
        +string role
        +string content
        +string status
        +Date createdAt
    }

    class MessageRepository {
        <<interface>>
        +save(message): void
        +findById(id): Message
        +findByConversation(id): Message[]
        +findByClientId(clientId): Message
        +deleteConversation(id): void
        +updateModelOverride(id, model): void
    }

    class MessageRouter {
        +route(message): RouteResult
        +isSessionCommand(text): boolean
    }

    class AbortController {
        +AbortSignal signal
        +abort(): void
    }

    MessageService --> MessageRepository
    MessageService --> MessageRouter
    MessageService --> AbortController
    MessageRepository --> Conversation
    MessageRepository --> Message
```

### 3.3 Datenbank-Schema

```sql
-- Conversations
CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT,
    model_override TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Messages
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    client_message_id TEXT UNIQUE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

-- Unique Index für Idempotency
CREATE UNIQUE INDEX idx_client_message
ON messages(conversation_id, client_message_id);
```

### 3.4 Systemarchitektur

```mermaid
flowchart TB
    subgraph Client
        Chat[Chat UI]
        Input[ChatInputArea]
        List[ConversationList]
    end

    subgraph Gateway
        WS[WebSocket]
        RPC[RPC Methods]
        Events[Events]
    end

    subgraph Domain
        MR[MessageRouter]
        MS[MessageService]
        CB[ContextBuilder]
        HM[HistoryManager]
    end

    subgraph Database
        DB[(SQLite)]
    end

    subgraph External
        MH[Model Hub]
    end

    Chat --> WS
    Input --> WS
    List --> WS

    WS --> RPC
    RPC --> MR
    RPC --> MS

    MR --> MS
    MS --> CB
    MS --> HM
    MS --> MH

    MR --> DB
    MS --> DB
    HM --> DB

    Events --> Chat
```

---

## 4. Session Commands

| Command | Beschreibung                |
| ------- | --------------------------- |
| /new    | Neue Konversation erstellen |
| /reset  | Session zurücksetzen        |

---

## 5. WebSocket Events

### 5.1 Client -> Server

```typescript
// Nachricht senden
interface ChatSendRequest {
  conversationId: string;
  content: string;
  clientMessageId?: string;
}

// Generierung abbrechen
interface ChatAbortRequest {
  conversationId: string;
}

// Session löschen
interface SessionDeleteRequest {
  conversationId: string;
}

// Session zurücksetzen
interface SessionResetRequest {
  title?: string;
}

// Model Override
interface SessionPatchRequest {
  conversationId: string;
  modelOverride?: string;
}
```

### 5.2 Server -> Client

```typescript
// Neue Konversation
interface ConversationNewEvent {
  conversation: Conversation;
}

// Konversation gelöscht
interface ConversationDeletedEvent {
  conversationId: string;
}

// Session zurückgesetzt
interface ConversationResetEvent {
  oldConversationId: string;
  newConversationId: string;
}

// Generierung abgebrochen
interface ChatAbortedEvent {
  conversationId: string;
  messageId: string;
}
```

---

## 6. AbortSignal Chain

```mermaid
flowchart TD
    A[User Abort] --> B[Gateway]
    B --> C[MessageService]
    C --> D[AbortController]
    D --> E[AbortSignal]
    E --> F[dispatchWithFallback]
    F --> G[Provider Adapter]
    G --> H[HTTP Request]
    E -.->|triggers| H
```

---

## 7. API-Referenz

### 7.1 REST Endpunkte

```
GET    /api/channels/conversations       # Alle Konversationen
POST   /api/channels/conversations       # Konversation erstellen
DELETE /api/channels/conversations       # Konversation löschen
PATCH  /api/channels/conversations       # Model Override
GET    /api/channels/messages            # Nachrichten
POST   /api/channels/messages            # Nachricht senden
```

### 7.2 WebSocket RPC

```
chat.send           # Nachricht senden
chat.stream         # Streaming-Nachricht
chat.abort          # Generierung abbrechen
sessions.delete     # Session löschen
sessions.reset      # Session zurücksetzen
sessions.patch      # Session aktualisieren
```

---

## 8. Verifikation

```bash
# Unit Tests
npm run test -- tests/unit/channels

# Integration Tests
npm run test -- tests/integration/channels

# Contract Tests
npm run test -- tests/integration/persistent-chat-session-v2.contract.test.ts

# Lint
npm run lint

# Typecheck
npm run typecheck
```

---

## 9. Siehe auch

- docs/SESSION_MANAGEMENT_IMPLEMENTATION.md - Implementierungsdetails
- docs/MEMORY_SYSTEM.md - Memory-Integration
- docs/CORE_HANDBOOK.md
