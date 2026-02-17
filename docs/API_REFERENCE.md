# API Reference

**Version:** 1.0.0  
**Last Updated:** 2026-02-17  
**Runtime:** Node.js  
**Base URL:** `/api`

---

## Overview

The OpenClaw API provides a comprehensive interface for building AI-powered applications with multi-channel messaging, persona management, task orchestration, and memory systems. This reference covers all available endpoints, authentication patterns, request/response formats, and error handling.

### Key Features

- **Multi-Channel Messaging** - Unified interface for Telegram, Discord, WhatsApp, Slack, and iMessage
- **Persona & Room Management** - Orchestrate multi-persona conversations
- **Worker System** - Execute complex tasks with planning, subagents, and deliverables
- **Model Hub** - Manage AI providers with fallback pipelines
- **Memory System** - Semantic and episodic memory storage with recall
- **Skills & ClawHub** - Extensible skill system with marketplace integration
- **Automation** - Cron-based rule execution with retry logic

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           OPENCLAW API ARCHITECTURE                             │
│                       Complete Endpoint Organization                            │
└─────────────────────────────────────────────────────────────────────────────────┘

                                    ┌─────────────┐
                                    │   Client    │
                                    │  (Web/App)  │
                                    └──────┬──────┘
                                           │
              ┌────────────────────────────┼────────────────────────────┐
              │                            │                            │
              ▼                            ▼                            ▼
    ┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐
    │  AUTH LAYER     │          │  WEBSOCKET      │          │  REST API       │
    │  (NextAuth)     │          │  GATEWAY        │          │  (Protected)    │
    │                 │          │                 │          │                 │
    │ • Session Mgmt  │          │ • Real-time     │          │ • CRUD Ops      │
    │ • OAuth Flows   │          │ • Events        │          │ • Webhooks      │
    └────────┬────────┘          └─────────────────┘          └────────┬────────┘
             │                                                         │
             └─────────────────────────┬───────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              API DOMAIN LAYERS                                  │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ╔═══════════════════════════════════════════════════════════════════════════╗  │
│  ║  1. IDENTITY & ACCESS                       /api/auth/*                   ║  │
│  ╠═══════════════════════════════════════════════════════════════════════════╣  │
│  ║  • Session authentication • OAuth providers • Token management            ║  │
│  ╚═══════════════════════════════════════════════════════════════════════════╝  │
│                                     │                                           │
│  ╔═══════════════════════════════════════════════════════════════════════════╗  │
│  ║  2. CHANNELS & MESSAGING                    /api/channels/*               ║  │
│  ╠═══════════════════════════════════════════════════════════════════════════╣  │
│  ║  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐      ║  │
│  ║  │  Telegram    │ │   Discord    │ │  WhatsApp    │ │    Slack     │      ║  │
│  ║  │  Webhooks    │ │   Webhooks   │ │  Webhooks    │ │   Webhooks   │      ║  │
│  ║  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘      ║  │
│  ║  ┌─────────────────────────────────────────────────────────────────────┐   ║  │
│  ║  │  Conversations  •  Messages  •  Attachments  •  Inbox               │   ║  │
│  ║  └─────────────────────────────────────────────────────────────────────┘   ║  │
│  ╚═══════════════════════════════════════════════════════════════════════════╝  │
│                                     │                                           │
│  ╔═══════════════════════════════════════════════════════════════════════════╗  │
│  ║  3. PERSONAS & ROOMS                                                    ║  │
│  ║     /api/personas/*  •  /api/rooms/*                                      ║  │
│  ╠═══════════════════════════════════════════════════════════════════════════╣  │
│  ║  ┌─────────────────────────────┐    ┌─────────────────────────────────┐   ║  │
│  ║  │      PERSONA MANAGEMENT     │    │         ROOM ORCHESTRATION      │   ║  │
│  ║  │  • CRUD Operations          │    │  • Multi-Persona Conversations  │   ║  │
│  ║  │  • File Attachments         │    │  • Turn Management              │   ║  │
│  ║  │  • Permission Control       │    │  • Interventions                │   ║  │
│  ║  │  • Templates                │    │  • Member Management            │   ║  │
│  ║  └─────────────────────────────┘    └─────────────────────────────────┘   ║  │
│  ╚═══════════════════════════════════════════════════════════════════════════╝  │
│                                     │                                           │
│  ╔═══════════════════════════════════════════════════════════════════════════╗  │
│  ║  4. WORKER SYSTEM                         /api/worker/*                     ║  │
│  ╠═══════════════════════════════════════════════════════════════════════════╣  │
│  ║  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐      ║  │
│  ║  │    Tasks     │ │   Planning   │ │  Workspace   │ │  Subagents   │      ║  │
│  ║  │  • Create    │ │  • Generate  │ │  • Files     │ │  • Sessions  │      ║  │
│  ║  │  • Execute   │ │  • Answer    │ │  • Export    │ │  • Control   │      ║  │
│  ║  │  • Cancel    │ │  • Approve   │ │              │ │              │      ║  │
│  ║  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘      ║  │
│  ║  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                        ║  │
│  ║  │ Deliverables │ │   Orchestra  │ │   Settings   │                        ║  │
│  ║  │  • Track     │ │  • Flows     │ │  • Config    │                        ║  │
│  ║  │  • Manage    │ │  • Publish   │ │  • Tools     │                        ║  │
│  ║  └──────────────┘ └──────────────┘ └──────────────┘                        ║  │
│  ╚═══════════════════════════════════════════════════════════════════════════╝  │
│                                     │                                           │
│  ╔═══════════════════════════════════════════════════════════════════════════╗  │
│  ║  5. SKILLS & CLAWHUB                                                    ║  │
│  ║     /api/skills/*  •  /api/clawhub/*                                      ║  │
│  ╠═══════════════════════════════════════════════════════════════════════════╣  │
│  ║  ┌─────────────────────────────┐    ┌─────────────────────────────────┐   ║  │
│  ║  │     SKILL EXECUTION         │    │         CLAWHUB MARKETPLACE     │   ║  │
│  ║  │  • Install/Remove           │    │  • Search & Explore             │   ║  │
│  ║  │  • Enable/Disable           │    │  • Install from Registry        │   ║  │
│  ║  │  • Execute Handler          │    │  • Update Management            │   ║  │
│  ║  │  • Runtime Config           │    │  • Prompt Blocks                │   ║  │
│  ║  └─────────────────────────────┘    └─────────────────────────────────┘   ║  │
│  ╚═══════════════════════════════════════════════════════════════════════════╝  │
│                                     │                                           │
│  ╔═══════════════════════════════════════════════════════════════════════════╗  │
│  ║  6. MODEL HUB                             /api/model-hub/*                ║  │
│  ╠═══════════════════════════════════════════════════════════════════════════╣  │
│  ║  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐      ║  │
│  ║  │   Accounts   │ │   Gateway    │ │   Pipeline   │ │   OAuth      │      ║  │
│  ║  │  • 14+       │ │  • Dispatch  │ │  • Fallback  │ │  • Connect   │      ║  │
│  ║  │    Providers │ │  • Route     │ │  • Strategy  │ │  • Callback  │      ║  │
│  ║  │  • Test      │ │              │ │              │ │              │      ║  │
│  ║  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘      ║  │
│  ╚═══════════════════════════════════════════════════════════════════════════╝  │
│                                     │                                           │
│  ╔═══════════════════════════════════════════════════════════════════════════╗  │
│  ║  7. MEMORY SYSTEM                         /api/memory                       ║  │
│  ╠═══════════════════════════════════════════════════════════════════════════╣  │
│  ║  • Semantic Search (Mem0)  • Episodic Storage  • Recall/Store Operations  ║  │
│  ╚═══════════════════════════════════════════════════════════════════════════╝  │
│                                     │                                           │
│  ╔═══════════════════════════════════════════════════════════════════════════╗  │
│  ║  8. AUTOMATIONS                           /api/automations/*                ║  │
│  ╠═══════════════════════════════════════════════════════════════════════════╣  │
│  ║  • Cron Rules  • Manual Runs  • Execution History  • Retry Logic          ║  │
│  ╚═══════════════════════════════════════════════════════════════════════════╝  │
│                                     │                                           │
│  ╔═══════════════════════════════════════════════════════════════════════════╗  │
│  ║  9. SYSTEM & MONITORING                                                 ║  │
│  ║     /api/config  •  /api/security/*  •  /api/health  •  /api/stats/*      ║  │
│  ╠═══════════════════════════════════════════════════════════════════════════╣  │
│  ║  • Configuration  • Security Status  • Health Checks  • Metrics & Logs    ║  │
│  ╚═══════════════════════════════════════════════════════════════════════════╝  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Table of Contents

1. [Authentication](#authentication)
2. [Channels & Messaging](#channels--messaging)
3. [Rooms](#rooms)
4. [Personas](#personas)
5. [Worker System](#worker-system)
6. [Skills & ClawHub](#skills--clawhub)
7. [Model Hub](#model-hub)
8. [Memory](#memory)
9. [Automations](#automations)
10. [System](#system)
11. [Error Reference](#error-reference)
12. [Webhooks](#webhooks)

---

## Authentication

All API endpoints require authentication via session cookie, except for explicitly public endpoints listed below. The system uses NextAuth.js for session management.

### Authentication Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│    Client   │────▶│  NextAuth   │────▶│   Session   │
│             │◀────│   Handler   │◀────│    Store    │
└─────────────┘     └─────────────┘     └─────────────┘
       │
       │ Session Cookie
       ▼
┌─────────────┐
│  Protected  │
│  API Route  │
└─────────────┘
```

### Public Endpoints (No Authentication Required)

| Endpoint                               | Purpose                               |
| -------------------------------------- | ------------------------------------- |
| `GET/POST /api/auth/[...nextauth]`     | NextAuth authentication flows         |
| `POST /api/channels/{channel}/webhook` | Channel webhooks (signature verified) |
| `GET /api/health`                      | Health check endpoint                 |
| `GET /api/doctor`                      | Diagnostics endpoint                  |

### Session Authentication

```http
GET /api/personas HTTP/1.1
Host: api.openclaw.local
Cookie: next-auth.session-token=eyJhbGciOiJIUzI1NiIs...
```

### Response: Authenticated

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "personas": [...]
}
```

### Response: Unauthorized

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{
  "error": "Unauthorized",
  "message": "Authentication required"
}
```

---

## Rate Limiting

API requests are subject to rate limiting based on endpoint sensitivity:

| Endpoint Type     | Limit | Window   |
| ----------------- | ----- | -------- |
| General API       | 100   | 1 minute |
| Webhooks          | 1000  | 1 minute |
| Authentication    | 10    | 1 minute |
| Memory Operations | 50    | 1 minute |

Rate limit headers are included in all responses:

```http
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1708195200
```

---

## Channels & Messaging

The Channels API provides unified messaging across multiple platforms including Telegram, Discord, WhatsApp, Slack, and iMessage.

### Base URL: `/api/channels`

---

### Channel State Management

#### Get Channel State

```http
GET /api/channels/state
```

Returns the current state of all configured channels and their connectivity status.

**Response:**

```json
{
  "channels": [
    {
      "type": "telegram",
      "status": "connected",
      "pairedAt": "2026-02-17T10:30:00Z",
      "username": "@example_user"
    },
    {
      "type": "discord",
      "status": "disconnected",
      "lastError": "Token expired"
    }
  ]
}
```

---

### Channel Pairing

#### Pair Channel

```http
POST /api/channels/pair
Content-Type: application/json

{
  "channelType": "telegram",
  "credentials": {
    "token": "bot123456:ABC-DEF1234..."
  }
}
```

#### Unpair Channel

```http
DELETE /api/channels/pair
Content-Type: application/json

{
  "channelType": "telegram"
}
```

---

### Conversations

#### List Conversations

```http
GET /api/channels/conversations?channel=telegram&limit=20&offset=0
```

**Response:**

```json
{
  "conversations": [
    {
      "id": "conv_123",
      "channel": "telegram",
      "counterpart": "@user123",
      "lastMessageAt": "2026-02-17T14:30:00Z",
      "messageCount": 42,
      "unreadCount": 3
    }
  ],
  "total": 156
}
```

#### Create Conversation

```http
POST /api/channels/conversations
Content-Type: application/json

{
  "channel": "telegram",
  "counterpart": "@newuser",
  "initialMessage": "Hello! How can I help you today?"
}
```

#### Update Conversation Settings

```http
PATCH /api/channels/conversations
Content-Type: application/json

{
  "conversationId": "conv_123",
  "modelOverride": "gpt-4",
  "personaOverride": "persona_456"
}
```

#### Delete Conversation

```http
DELETE /api/channels/conversations?conversationId=conv_123
```

---

### Messages

#### Get Messages

```http
GET /api/channels/messages?conversationId=conv_123&limit=50&before=msg_789
```

**Response:**

```json
{
  "messages": [
    {
      "id": "msg_790",
      "role": "user",
      "content": "What's the weather like?",
      "timestamp": "2026-02-17T14:30:00Z",
      "attachments": []
    },
    {
      "id": "msg_791",
      "role": "assistant",
      "content": "I don't have access to real-time weather data...",
      "timestamp": "2026-02-17T14:30:05Z",
      "model": "gpt-4"
    }
  ],
  "hasMore": true
}
```

#### Send Message

```http
POST /api/channels/messages
Content-Type: application/json

{
  "conversationId": "conv_123",
  "content": "Hello! How can I help you?",
  "options": {
    "stream": true,
    "model": "gpt-4"
  }
}
```

#### Get Attachment

```http
GET /api/channels/messages/attachments?messageId=msg_790&attachmentId=att_001
```

---

### Inbox

#### Get Aggregated Inbox

```http
GET /api/channels/inbox?unreadOnly=true&limit=20
```

**Response:**

```json
{
  "items": [
    {
      "conversationId": "conv_123",
      "channel": "telegram",
      "counterpart": "@user123",
      "lastMessage": {
        "content": "Can you help me with...",
        "timestamp": "2026-02-17T14:30:00Z",
        "isUnread": true
      },
      "unreadCount": 3
    }
  ],
  "totalUnread": 12
}
```

---

### Telegram Pairing

#### Confirm Pairing

```http
POST /api/channels/telegram/pairing/confirm
Content-Type: application/json

{
  "token": "PAIR-123456",
  "userId": "user_789"
}
```

#### Poll Pairing Status

```http
POST /api/channels/telegram/pairing/poll
Content-Type: application/json

{
  "token": "PAIR-123456"
}
```

---

## Rooms

Rooms provide multi-persona conversation orchestration with turn-based message flow.

### Base URL: `/api/rooms`

---

### Room Management

#### List Rooms

```http
GET /api/rooms?status=active&limit=20
```

**Response:**

```json
{
  "rooms": [
    {
      "id": "room_123",
      "name": "Project Discussion",
      "status": "running",
      "memberCount": 3,
      "createdAt": "2026-02-17T10:00:00Z",
      "lastActivityAt": "2026-02-17T14:30:00Z"
    }
  ],
  "total": 5
}
```

#### Create Room

```http
POST /api/rooms
Content-Type: application/json

{
  "name": "Strategy Meeting",
  "description": "Quarterly planning discussion",
  "personaIds": ["persona_1", "persona_2", "persona_3"],
  "config": {
    "turnTimeout": 30000,
    "maxRounds": 10
  }
}
```

**Response:**

```json
{
  "id": "room_456",
  "name": "Strategy Meeting",
  "status": "created",
  "members": [
    {
      "personaId": "persona_1",
      "status": "ready",
      "model": "gpt-4"
    }
  ],
  "createdAt": "2026-02-17T14:30:00Z"
}
```

#### Get Room

```http
GET /api/rooms/room_456
```

#### Delete Room

```http
DELETE /api/rooms/room_456
```

---

### Room Control

#### Start Room

```http
POST /api/rooms/room_456/start
```

#### Stop Room

```http
POST /api/rooms/room_456/stop
```

#### Get Room State

```http
GET /api/rooms/room_456/state
```

**Response:**

```json
{
  "id": "room_456",
  "status": "running",
  "currentTurn": {
    "round": 3,
    "personaId": "persona_2",
    "startedAt": "2026-02-17T14:35:00Z"
  },
  "members": [
    {
      "personaId": "persona_1",
      "status": "waiting",
      "lastSpokeAt": "2026-02-17T14:34:00Z"
    },
    {
      "personaId": "persona_2",
      "status": "speaking",
      "lastSpokeAt": null
    }
  ]
}
```

---

### Room Messages

#### Get Room Messages

```http
GET /api/rooms/room_456/messages?limit=50&before=msg_123
```

#### Send Room Message

```http
POST /api/rooms/room_456/messages
Content-Type: application/json

{
  "content": "Let's discuss the Q1 objectives",
  "senderType": "user",
  "senderId": "user_789"
}
```

---

### Interventions

#### List Interventions

```http
GET /api/rooms/room_456/interventions
```

#### Create Intervention

```http
POST /api/rooms/room_456/interventions
Content-Type: application/json

{
  "type": "pause",
  "reason": "User needs to interject",
  "duration": 60000
}
```

---

### Member Management

#### Add Member

```http
POST /api/rooms/room_456/members
Content-Type: application/json

{
  "personaId": "persona_4",
  "modelOverride": "claude-3-opus",
  "role": "observer"
}
```

#### Update Member

```http
PATCH /api/rooms/room_456/members/persona_4
Content-Type: application/json

{
  "modelOverride": "gpt-4",
  "role": "participant"
}
```

#### Remove Member

```http
DELETE /api/rooms/room_456/members/persona_4
```

---

### Membership Counts

#### Get Membership Statistics

```http
GET /api/rooms/membership-counts
```

**Response:**

```json
{
  "totalPersonas": 12,
  "activeInRooms": 8,
  "available": 4,
  "roomDistribution": {
    "room_456": 3,
    "room_789": 5
  }
}
```

---

## Personas

Personas represent configurable AI identities with file-based context and permission controls.

### Base URL: `/api/personas`

---

### Persona Management

#### List Personas

```http
GET /api/personas?includeArchived=false
```

**Response:**

```json
{
  "personas": [
    {
      "id": "persona_123",
      "name": "Research Assistant",
      "description": "Expert in academic research",
      "defaultModel": "gpt-4",
      "status": "active",
      "createdAt": "2026-02-01T10:00:00Z"
    }
  ],
  "total": 8
}
```

#### Create Persona

```http
POST /api/personas
Content-Type: application/json

{
  "name": "Code Reviewer",
  "description": "Senior developer focused on code quality",
  "systemPrompt": "You are an expert code reviewer...",
  "defaultModel": "claude-3-opus",
  "temperature": 0.3
}
```

**Response:**

```json
{
  "id": "persona_789",
  "name": "Code Reviewer",
  "status": "active",
  "createdAt": "2026-02-17T14:30:00Z"
}
```

#### Get Persona

```http
GET /api/personas/persona_789
```

#### Update Persona

```http
PUT /api/personas/persona_789
Content-Type: application/json

{
  "name": "Senior Code Reviewer",
  "systemPrompt": "Updated prompt...",
  "temperature": 0.2
}
```

#### Delete Persona

```http
DELETE /api/personas/persona_789
```

---

### Persona Files

Personas can have attached files for context (e.g., knowledge bases, style guides).

#### Get Persona File

```http
GET /api/personas/persona_789/files/knowledge-base.md
```

#### Upload Persona File

```http
PUT /api/personas/persona_789/files/knowledge-base.md
Content-Type: text/markdown

# Knowledge Base

## Coding Standards
...
```

---

### Permissions

#### Get Persona Permissions

```http
GET /api/personas/persona_789/permissions
```

**Response:**

```json
{
  "permissions": {
    "canExecuteCommands": true,
    "canAccessFiles": ["/workspace/**"],
    "canUseSkills": ["file_read", "shell_execute"],
    "riskLevel": "medium"
  }
}
```

#### Update Persona Permissions

```http
PUT /api/personas/persona_789/permissions
Content-Type: application/json

{
  "canExecuteCommands": false,
  "canAccessFiles": ["/workspace/readonly/**"],
  "riskLevel": "low"
}
```

---

### Templates

#### Get Persona Templates

```http
GET /api/personas/templates
```

**Response:**

```json
{
  "templates": [
    {
      "id": "template_1",
      "name": "Research Assistant",
      "category": "productivity",
      "description": "Helps with academic research"
    },
    {
      "id": "template_2",
      "name": "Creative Writer",
      "category": "creative",
      "description": "Assists with storytelling"
    }
  ]
}
```

---

## Worker System

The Worker System executes complex multi-step tasks with planning, subagents, deliverables, and Orchestra workflow orchestration.

### Base URL: `/api/worker`

---

### Task Management

#### List Tasks

```http
GET /api/worker?status=running&limit=20
```

**Response:**

```json
{
  "tasks": [
    {
      "id": "task_123",
      "title": "Implement authentication",
      "status": "running",
      "progress": 45,
      "createdAt": "2026-02-17T10:00:00Z",
      "startedAt": "2026-02-17T10:05:00Z",
      "estimatedCompletion": "2026-02-17T11:00:00Z"
    }
  ],
  "total": 15
}
```

#### Create Task

```http
POST /api/worker
Content-Type: application/json

{
  "title": "Build API documentation",
  "description": "Create comprehensive API docs for the project",
  "requirements": [
    "Include authentication examples",
    "Cover all endpoints",
    "Add error handling samples"
  ],
  "priority": "high",
  "personaId": "persona_456"
}
```

**Response:**

```json
{
  "id": "task_789",
  "title": "Build API documentation",
  "status": "created",
  "workspacePath": "/workspaces/task_789",
  "createdAt": "2026-02-17T14:30:00Z"
}
```

#### Get Task

```http
GET /api/worker/task_789
```

**Response:**

```json
{
  "id": "task_789",
  "title": "Build API documentation",
  "status": "planning",
  "steps": [
    {
      "id": "step_1",
      "description": "Analyze API structure",
      "status": "completed"
    },
    {
      "id": "step_2",
      "description": "Document endpoints",
      "status": "in_progress"
    }
  ],
  "artifacts": [
    {
      "id": "art_1",
      "name": "api_reference.md",
      "type": "document",
      "path": "/workspaces/task_789/api_reference.md"
    }
  ]
}
```

#### Task Actions (PATCH)

```http
PATCH /api/worker/task_789
Content-Type: application/json

{
  "action": "cancel"
}
```

**Supported Actions:**

| Action           | Description                      |
| ---------------- | -------------------------------- |
| `cancel`         | Cancel a running task            |
| `resume`         | Resume a paused task             |
| `retry`          | Retry a failed task              |
| `approve`        | Approve a waiting_approval task  |
| `deny`           | Deny a waiting_approval task     |
| `approve-always` | Approve and add to allowlist     |
| `assign`         | Assign task to different persona |
| `move`           | Move task to different status    |

#### Bulk Delete Tasks

```http
DELETE /api/worker
Content-Type: application/json

{
  "taskIds": ["task_123", "task_456"]
}
```

#### Delete Single Task

```http
DELETE /api/worker/task_789
```

---

### Task Testing

#### Run Worker Test

```http
POST /api/worker/task_789/test
Content-Type: application/json

{
  "testInput": "Sample input for testing",
  "options": {
    "dryRun": true
  }
}
```

---

### Activities

#### Get Activity Feed

```http
GET /api/worker/task_789/activities
```

**Response:**

```json
{
  "activities": [
    {
      "id": "act_1",
      "type": "step_completed",
      "message": "Completed: Analyze API structure",
      "timestamp": "2026-02-17T14:35:00Z"
    },
    {
      "id": "act_2",
      "type": "artifact_created",
      "message": "Created: api_reference.md",
      "timestamp": "2026-02-17T14:40:00Z"
    }
  ]
}
```

---

### Planning

#### Get Planning Status

```http
GET /api/worker/task_789/planning
```

#### Generate Plan

```http
POST /api/worker/task_789/planning
Content-Type: application/json

{
  "approach": "iterative",
  "depth": "detailed"
}
```

#### Answer Planning Question

```http
POST /api/worker/task_789/planning/answer
Content-Type: application/json

{
  "questionId": "q_1",
  "answer": "The API uses REST with JSON payloads"
}
```

---

### Workspace Files

#### List Files

```http
GET /api/worker/task_789/files?path=/
```

#### Write File

```http
POST /api/worker/task_789/files
Content-Type: application/json

{
  "path": "/docs/README.md",
  "content": "# Documentation\n\n..."
}
```

#### Export Workspace

```http
GET /api/worker/task_789/export?format=zip
```

---

### Subagents

#### List Subagent Sessions

```http
GET /api/worker/task_789/subagents
```

#### Create Subagent Session

```http
POST /api/worker/task_789/subagents
Content-Type: application/json

{
  "personaId": "persona_researcher",
  "task": "Research authentication best practices",
  "context": {
    "parentTaskId": "task_789"
  }
}
```

#### Update Subagent Status

```http
PATCH /api/worker/task_789/subagents
Content-Type: application/json

{
  "subagentId": "sub_123",
  "status": "paused"
}
```

---

### Deliverables

#### List Deliverables

```http
GET /api/worker/task_789/deliverables
```

#### Create Deliverable

```http
POST /api/worker/task_789/deliverables
Content-Type: application/json

{
  "name": "API Documentation",
  "description": "Complete API reference document",
  "type": "document",
  "path": "/docs/api_reference.md"
}
```

---

### Orchestra Workflow

#### Get Workflow View

```http
GET /api/worker/task_789/workflow
```

---

### Worker Settings

#### Get Settings

```http
GET /api/worker/settings
```

#### Update Settings

```http
PUT /api/worker/settings
Content-Type: application/json

{
  "defaultPersona": "persona_456",
  "maxConcurrentTasks": 3,
  "autoApproveRiskLevel": "low"
}
```

---

### Orchestra Flows

#### List Flows

```http
GET /api/worker/orchestra/flows
```

#### Create Flow

```http
POST /api/worker/orchestra/flows
Content-Type: application/json

{
  "name": "Documentation Flow",
  "description": "Standard documentation workflow",
  "steps": [
    {
      "id": "step_1",
      "type": "plan",
      "config": {}
    },
    {
      "id": "step_2",
      "type": "execute",
      "dependsOn": ["step_1"]
    }
  ]
}
```

#### Publish Flow

```http
POST /api/worker/orchestra/flows/flow_123/publish
```

---

### OpenAI Tools

#### Get Tool Status

```http
GET /api/worker/openai/tools
```

#### Update Tools

```http
PATCH /api/worker/openai/tools
Content-Type: application/json

{
  "tools": {
    "file_search": {
      "enabled": true,
      "requiresApproval": false
    },
    "code_interpreter": {
      "enabled": true,
      "requiresApproval": true
    }
  }
}
```

---

## Skills & ClawHub

The Skills system provides extensible capabilities with a marketplace for discovery and installation.

### Base URLs: `/api/skills`, `/api/clawhub`

---

### Skills Management

#### List Skills

```http
GET /api/skills
```

**Response:**

```json
{
  "skills": [
    {
      "id": "skill_browser",
      "name": "Browser",
      "description": "Web browsing capabilities",
      "version": "1.2.0",
      "enabled": true,
      "builtIn": true
    },
    {
      "id": "skill_shell",
      "name": "Shell",
      "description": "Command execution",
      "version": "1.0.0",
      "enabled": false,
      "builtIn": true
    }
  ]
}
```

#### Install Skill

```http
POST /api/skills
Content-Type: application/json

{
  "skillId": "skill_custom",
  "source": "clawhub",
  "version": "1.0.0"
}
```

#### Update Skill Status

```http
PATCH /api/skills/skill_shell
Content-Type: application/json

{
  "enabled": true
}
```

#### Remove Skill

```http
DELETE /api/skills/skill_custom
```

---

### Skill Execution

#### Execute Skill

```http
POST /api/skills/execute
Content-Type: application/json

{
  "name": "file_read",
  "args": {
    "path": "README.md"
  }
}
```

**Response:**

```json
{
  "success": true,
  "result": "# Project Name\n\nDescription...",
  "executionTime": 45
}
```

**Supported Handlers:**

| Handler            | Description            |
| ------------------ | ---------------------- |
| `file_read`        | Read file contents     |
| `shell_execute`    | Execute shell commands |
| `python_execute`   | Run Python code        |
| `github_query`     | Query GitHub API       |
| `db_query`         | Execute SQL queries    |
| `browser_snapshot` | Capture web pages      |
| `vision_analyze`   | Analyze images         |

---

### Runtime Configuration

#### Get Runtime Config

```http
GET /api/skills/runtime-config
```

**Response:**

```json
{
  "configs": [
    {
      "key": "vision.gemini_api_key",
      "type": "secret",
      "source": "env",
      "value": "***"
    },
    {
      "key": "sql-bridge.sqlite_db_path",
      "type": "text",
      "source": "config",
      "value": ".local/messages.db"
    }
  ]
}
```

#### Set Runtime Config

```http
PUT /api/skills/runtime-config
Content-Type: application/json

{
  "key": "github-manager.github_token",
  "value": "ghp_xxxxxxxxxxxx",
  "type": "secret"
}
```

#### Delete Runtime Config

```http
DELETE /api/skills/runtime-config?key=github-manager.github_token
```

---

### ClawHub Marketplace

#### Search ClawHub

```http
GET /api/clawhub/search?q=git&category=dev-tools
```

**Response:**

```json
{
  "results": [
    {
      "slug": "git-helper",
      "name": "Git Helper",
      "description": "Advanced Git operations",
      "author": "openclaw",
      "version": "2.1.0",
      "downloads": 15420,
      "rating": 4.8
    }
  ]
}
```

#### Explore ClawHub

```http
GET /api/clawhub/explore?category=featured
```

#### Get Installed Skills

```http
GET /api/clawhub/installed
```

#### Install from ClawHub

```http
POST /api/clawhub/install
Content-Type: application/json

{
  "slug": "git-helper",
  "version": "latest"
}
```

#### Update Installed Skills

```http
POST /api/clawhub/update
Content-Type: application/json

{
  "skills": ["git-helper", "docker-manager"]
}
```

#### Get Prompt Block

```http
GET /api/clawhub/prompt?skill=git-helper
```

#### Update Skill State

```http
PATCH /api/clawhub/git-helper
Content-Type: application/json

{
  "enabled": false
}
```

#### Uninstall Skill

```http
DELETE /api/clawhub/git-helper
```

---

## Model Hub

The Model Hub manages AI provider accounts, model discovery, and fallback pipelines.

### Base URL: `/api/model-hub`

---

### Accounts

#### List Accounts

```http
GET /api/model-hub/accounts
```

**Response:**

```json
{
  "accounts": [
    {
      "id": "acc_openai_1",
      "provider": "openai",
      "name": "Primary OpenAI",
      "status": "connected",
      "models": ["gpt-4", "gpt-4-turbo", "gpt-3.5-turbo"],
      "lastTestedAt": "2026-02-17T10:00:00Z"
    },
    {
      "id": "acc_anthropic_1",
      "provider": "anthropic",
      "name": "Anthropic Backup",
      "status": "connected",
      "models": ["claude-3-opus", "claude-3-sonnet"]
    }
  ]
}
```

#### Create Account

```http
POST /api/model-hub/accounts
Content-Type: application/json

{
  "provider": "openai",
  "name": "Secondary OpenAI",
  "credentials": {
    "apiKey": "sk-xxxxxxxx"
  }
}
```

#### Delete Account

```http
DELETE /api/model-hub/accounts/acc_openai_2
```

#### Get Models for Account

```http
GET /api/model-hub/accounts/acc_openai_1/models
```

#### Test Account Connectivity

```http
POST /api/model-hub/accounts/acc_openai_1/test
```

**Response:**

```json
{
  "success": true,
  "latency": 245,
  "testedAt": "2026-02-17T14:30:00Z"
}
```

#### Test All Accounts

```http
POST /api/model-hub/accounts/test-all
```

---

### Gateway & Pipeline

#### Gateway Dispatch

```http
POST /api/model-hub/gateway
Content-Type: application/json

{
  "messages": [
    {
      "role": "user",
      "content": "Hello!"
    }
  ],
  "model": "gpt-4",
  "stream": false
}
```

**Response:**

```json
{
  "content": "Hello! How can I help you today?",
  "model": "gpt-4",
  "provider": "openai",
  "accountId": "acc_openai_1",
  "usage": {
    "promptTokens": 10,
    "completionTokens": 15,
    "totalTokens": 25
  }
}
```

#### Get Pipeline

```http
GET /api/model-hub/pipeline
```

**Response:**

```json
{
  "pipeline": [
    {
      "accountId": "acc_openai_1",
      "priority": 1,
      "models": ["gpt-4", "gpt-4-turbo"]
    },
    {
      "accountId": "acc_anthropic_1",
      "priority": 2,
      "models": ["claude-3-opus"],
      "fallbackTrigger": "rate_limit"
    }
  ]
}
```

#### Save Pipeline

```http
POST /api/model-hub/pipeline
Content-Type: application/json

{
  "pipeline": [
    {
      "accountId": "acc_openai_1",
      "priority": 1
    }
  ]
}
```

#### Replace Pipeline

```http
PUT /api/model-hub/pipeline
Content-Type: application/json

{
  "pipeline": [...]
}
```

---

### Providers

#### Get Provider Catalog

```http
GET /api/model-hub/providers
```

**Response:**

```json
{
  "providers": [
    {
      "id": "openai",
      "name": "OpenAI",
      "requiresApiKey": true,
      "supportsStreaming": true,
      "supportedModels": ["gpt-4", "gpt-4-turbo", "gpt-3.5-turbo"]
    },
    {
      "id": "ollama",
      "name": "Ollama",
      "requiresApiKey": false,
      "supportsStreaming": true,
      "supportedModels": ["llama2", "mistral", "codellama"]
    }
  ]
}
```

**Supported Providers:**

| Provider         | Auth Type | Streaming |
| ---------------- | --------- | --------- |
| `gemini`         | API Key   | ✅        |
| `openai`         | API Key   | ✅        |
| `openai-codex`   | API Key   | ✅        |
| `anthropic`      | API Key   | ✅        |
| `openrouter`     | API Key   | ✅        |
| `ollama`         | None      | ✅        |
| `lmstudio`       | None      | ✅        |
| `xai`            | API Key   | ✅        |
| `mistral`        | API Key   | ✅        |
| `cohere`         | API Key   | ✅        |
| `zai`            | API Key   | ✅        |
| `kimi`           | API Key   | ✅        |
| `bytedance`      | API Key   | ✅        |
| `github-copilot` | OAuth     | ✅        |

---

### OAuth

#### Start OAuth Flow

```http
GET /api/model-hub/oauth/start?provider=github-copilot&redirectUri=https://app.local/callback
```

**Response:**

```json
{
  "authorizationUrl": "https://github.com/login/oauth/authorize?client_id=..."
}
```

#### OAuth Callback

```http
GET /api/model-hub/oauth/callback?code=xxx&state=yyy
```

---

## Memory

The Memory API provides semantic storage and recall using Mem0 Cloud and local SQLite fallback.

### Base URL: `/api/memory`

---

### Memory Operations

#### Get Memory Snapshot

```http
GET /api/memory?personaId=persona_123&limit=50
```

**Response:**

```json
{
  "memories": [
    {
      "id": "mem_1",
      "content": "User prefers email over Slack",
      "type": "preference",
      "importance": 4,
      "confidence": 0.85,
      "createdAt": "2026-02-01T10:00:00Z"
    }
  ],
  "total": 156
}
```

#### Store Memory (Function Call)

```http
POST /api/memory
Content-Type: application/json

{
  "function": "core_memory_store",
  "arguments": {
    "content": "User works in design industry",
    "type": "fact",
    "importance": 3
  }
}
```

#### Recall Memory (Function Call)

```http
POST /api/memory
Content-Type: application/json

{
  "function": "core_memory_recall",
  "arguments": {
    "query": "communication preferences",
    "limit": 5
  }
}
```

**Response:**

```json
{
  "memories": [
    {
      "id": "mem_1",
      "content": "User prefers email over Slack",
      "type": "preference",
      "similarity": 0.92
    }
  ]
}
```

#### Update Memory Node

```http
PUT /api/memory
Content-Type: application/json

{
  "id": "mem_1",
  "content": "User strongly prefers email over Slack",
  "importance": 5
}
```

#### Bulk Update/Delete

```http
PATCH /api/memory
Content-Type: application/json

{
  "operation": "delete",
  "ids": ["mem_2", "mem_3"]
}
```

#### Delete Memory

```http
DELETE /api/memory?id=mem_1
```

#### Delete Persona Memory

```http
DELETE /api/memory?personaId=persona_123
```

---

## Automations

The Automations API manages cron-based rule execution with persistent runs and retry logic.

### Base URL: `/api/automations`

---

### Rule Management

#### List Automation Rules

```http
GET /api/automations?enabledOnly=true
```

**Response:**

```json
{
  "rules": [
    {
      "id": "auto_123",
      "name": "Daily Summary",
      "description": "Generate daily activity summary",
      "cronExpression": "0 9 * * *",
      "timezone": "Europe/Berlin",
      "enabled": true,
      "lastRunAt": "2026-02-17T09:00:00Z",
      "nextRunAt": "2026-02-18T09:00:00Z"
    }
  ]
}
```

#### Create Rule

```http
POST /api/automations
Content-Type: application/json

{
  "name": "Weekly Report",
  "description": "Generate weekly analytics report",
  "cronExpression": "0 9 * * 1",
  "timezone": "America/New_York",
  "prompt": "Generate a comprehensive weekly report including...",
  "enabled": true
}
```

**Response:**

```json
{
  "id": "auto_456",
  "name": "Weekly Report",
  "enabled": true,
  "createdAt": "2026-02-17T14:30:00Z"
}
```

#### Get Rule

```http
GET /api/automations/auto_456
```

#### Update Rule

```http
PATCH /api/automations/auto_456
Content-Type: application/json

{
  "cronExpression": "0 10 * * 1",
  "enabled": false
}
```

#### Delete Rule

```http
DELETE /api/automations/auto_456
```

---

### Rule Execution

#### Trigger Manual Run

```http
POST /api/automations/auto_456/run
Content-Type: application/json

{
  "triggerSource": "manual",
  "context": {
    "priority": "high"
  }
}
```

#### List Rule Runs

```http
GET /api/automations/auto_456/runs?limit=10
```

**Response:**

```json
{
  "runs": [
    {
      "id": "run_789",
      "ruleId": "auto_456",
      "status": "succeeded",
      "triggerSource": "cron",
      "startedAt": "2026-02-17T09:00:00Z",
      "completedAt": "2026-02-17T09:05:00Z",
      "output": "Report generated successfully"
    },
    {
      "id": "run_790",
      "ruleId": "auto_456",
      "status": "failed",
      "triggerSource": "manual",
      "startedAt": "2026-02-17T14:00:00Z",
      "error": "API rate limit exceeded",
      "retryCount": 2
    }
  ]
}
```

**Run Statuses:**

| Status        | Description            |
| ------------- | ---------------------- |
| `queued`      | Waiting to be executed |
| `running`     | Currently executing    |
| `succeeded`   | Completed successfully |
| `failed`      | Failed, may retry      |
| `dead_letter` | Max retries exceeded   |

---

## System

System endpoints provide configuration, monitoring, and operational data.

---

### Configuration

#### Get Configuration

```http
GET /api/config
```

**Response:**

```json
{
  "gateway": {
    "defaultModel": "gpt-4",
    "maxTokens": 4000,
    "temperature": 0.7
  },
  "features": {
    "memoryEnabled": true,
    "knowledgeLayerEnabled": true,
    "workerEnabled": true
  }
}
```

#### Save Configuration

```http
PUT /api/config
Content-Type: application/json

{
  "gateway": {
    "defaultModel": "claude-3-opus"
  }
}
```

---

### Security

#### Get Security Status

```http
GET /api/security/status
```

**Response:**

```json
{
  "overallStatus": "secure",
  "checks": {
    "firewall": {
      "status": "ok",
      "message": "High-risk commands properly restricted"
    },
    "encryption": {
      "status": "ok",
      "message": "HTTPS and WebCrypto enabled"
    },
    "audit": {
      "status": "ok",
      "message": "Audit logging active"
    },
    "isolation": {
      "status": "ok",
      "message": "Task isolation configured"
    }
  },
  "lastCheckedAt": "2026-02-17T14:30:00Z"
}
```

---

### Health & Diagnostics

#### Health Check

```http
GET /api/health
```

**Response:**

```json
{
  "status": "healthy",
  "version": "1.0.0",
  "uptime": 86400,
  "checks": {
    "database": "connected",
    "modelHub": "connected",
    "memory": "connected"
  }
}
```

#### Diagnostics Check

```http
GET /api/doctor
```

**Response:**

```json
{
  "status": "ok",
  "diagnostics": [
    {
      "component": "database",
      "status": "ok",
      "details": "SQLite connection healthy"
    },
    {
      "component": "channels",
      "status": "warning",
      "details": "Discord webhook not configured"
    }
  ]
}
```

---

### Metrics

#### Get Control Plane Metrics

```http
GET /api/control-plane/metrics
```

---

### Statistics

#### Get Statistics

```http
GET /api/stats
```

**Response:**

```json
{
  "conversations": {
    "total": 156,
    "active": 12,
    "messagesTotal": 4520
  },
  "tasks": {
    "total": 89,
    "completed": 76,
    "failed": 5,
    "running": 8
  },
  "apiCalls": {
    "total": 15420,
    "today": 450
  }
}
```

---

### Prompt Logs

#### Get Prompt Logs

```http
GET /api/stats/prompt-logs?limit=50&model=gpt-4
```

#### Delete Prompt Logs

```http
DELETE /api/stats/prompt-logs?before=2026-02-01
```

---

### System Logs

#### Get Logs

```http
GET /api/logs?level=error&limit=100
```

#### Delete Logs

```http
DELETE /api/logs?before=2026-02-01
```

#### Ingest Logs

```http
POST /api/logs/ingest
Content-Type: application/json

{
  "logs": [
    {
      "level": "info",
      "message": "Custom log entry",
      "timestamp": "2026-02-17T14:30:00Z"
    }
  ]
}
```

---

## Error Reference

### HTTP Status Codes

| Code  | Meaning               | Description                            |
| ----- | --------------------- | -------------------------------------- |
| `200` | OK                    | Request succeeded                      |
| `201` | Created               | Resource created successfully          |
| `204` | No Content            | Request succeeded, no content returned |
| `400` | Bad Request           | Invalid request payload or parameters  |
| `401` | Unauthorized          | Authentication required                |
| `403` | Forbidden             | Insufficient permissions               |
| `404` | Not Found             | Resource not found                     |
| `409` | Conflict              | Resource conflict (e.g., duplicate)    |
| `422` | Unprocessable Entity  | Validation error                       |
| `429` | Too Many Requests     | Rate limit exceeded                    |
| `500` | Internal Server Error | Server error                           |
| `503` | Service Unavailable   | Service temporarily unavailable        |

### Error Response Format

```json
{
  "error": "ErrorCode",
  "message": "Human-readable error description",
  "details": {
    "field": "specific field with error",
    "code": "validation_error"
  },
  "requestId": "req_1234567890"
}
```

### Common Error Codes

| Code               | Description                | Resolution             |
| ------------------ | -------------------------- | ---------------------- |
| `UNAUTHORIZED`     | Authentication required    | Check session cookie   |
| `FORBIDDEN`        | Permission denied          | Check user permissions |
| `NOT_FOUND`        | Resource not found         | Verify resource ID     |
| `VALIDATION_ERROR` | Invalid input              | Check request payload  |
| `RATE_LIMITED`     | Too many requests          | Wait and retry         |
| `PROVIDER_ERROR`   | AI provider error          | Check Model Hub status |
| `MEMORY_ERROR`     | Memory operation failed    | Check Mem0 connection  |
| `WORKSPACE_ERROR`  | Workspace operation failed | Check disk space       |

---

## Webhooks

### Channel Webhooks

Channel webhooks receive incoming messages from external platforms. Each webhook is secured with platform-specific signature verification.

#### Telegram Webhook

```http
POST /api/channels/telegram/webhook
X-Telegram-Bot-Api-Secret-Token: {secret}

{
  "update_id": 123456789,
  "message": {
    "message_id": 1,
    "from": { ... },
    "chat": { ... },
    "date": 1708195200,
    "text": "Hello bot!"
  }
}
```

#### Discord Webhook

```http
POST /api/channels/discord/webhook
X-Signature-Ed25519: {signature}
X-Signature-Timestamp: {timestamp}

{
  "id": "interaction_id",
  "type": 1,
  "token": "interaction_token"
}
```

#### WhatsApp Webhook

```http
POST /api/channels/whatsapp/webhook
X-Hub-Signature-256: sha256={signature}

{
  "object": "whatsapp_business_account",
  "entry": [ ... ]
}
```

#### Slack Webhook

```http
POST /api/channels/slack/webhook
X-Slack-Signature: {signature}
X-Slack-Request-Timestamp: {timestamp}

{
  "token": "verification_token",
  "team_id": "T123",
  "event": { ... }
}
```

#### iMessage Webhook

```http
POST /api/channels/imessage/webhook
X-Bridge-Secret: {secret}

{
  "id": "message_id",
  "from": "+1234567890",
  "text": "Hello!"
}
```

### Webhook Security

All webhooks use signature verification to ensure authenticity:

| Platform | Header                            | Algorithm    |
| -------- | --------------------------------- | ------------ |
| Telegram | `X-Telegram-Bot-Api-Secret-Token` | Secret Token |
| Discord  | `X-Signature-Ed25519`             | Ed25519      |
| WhatsApp | `X-Hub-Signature-256`             | HMAC-SHA256  |
| Slack    | `X-Slack-Signature`               | HMAC-SHA256  |
| iMessage | `X-Bridge-Secret`                 | Secret Token |

### Webhook Response Codes

| Code  | Usage                          |
| ----- | ------------------------------ |
| `200` | Message processed successfully |
| `400` | Invalid payload                |
| `403` | Signature verification failed  |
| `404` | Channel not configured         |
| `429` | Rate limited                   |

---

## WebSocket Gateway

Real-time events and RPC are available via WebSocket at `/ws`.

### Connection

```javascript
const ws = new WebSocket('wss://api.openclaw.local/ws');

ws.onopen = () => {
  // Register with session
  ws.send(
    JSON.stringify({
      type: 'auth',
      token: 'session_token',
    }),
  );
};
```

### RPC Methods

```javascript
// Send message
ws.send(
  JSON.stringify({
    id: 'req_1',
    method: 'chat.send',
    params: {
      conversationId: 'conv_123',
      content: 'Hello!',
    },
  }),
);
```

### Event Subscriptions

```javascript
// Events are automatically received
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

  switch (data.type) {
    case 'room.message':
      console.log('New room message:', data.payload);
      break;
    case 'worker.status':
      console.log('Worker update:', data.payload);
      break;
  }
};
```

### Available Events

| Event                  | Description              |
| ---------------------- | ------------------------ |
| `room.message`         | New message in a room    |
| `room.member.status`   | Member status changed    |
| `room.run.status`      | Room execution status    |
| `conversation.new`     | New conversation created |
| `chat.typing`          | Typing indicator         |
| `worker.status`        | Worker task status       |
| `worker.activity`      | Worker activity feed     |
| `automation.triggered` | Automation triggered     |
| `presence.update`      | User presence update     |

---

## SDK Examples

### JavaScript/TypeScript

```typescript
import { OpenClawClient } from '@openclaw/sdk';

const client = new OpenClawClient({
  baseUrl: 'https://api.openclaw.local',
  // Session cookie handled automatically in browser
});

// Create a conversation
const conversation = await client.channels.createConversation({
  channel: 'telegram',
  counterpart: '@user123',
});

// Send a message
await client.channels.sendMessage({
  conversationId: conversation.id,
  content: 'Hello!',
});

// Create a worker task
const task = await client.worker.createTask({
  title: 'Analyze data',
  description: 'Process the sales report',
});

// Monitor task progress
client.worker.on('activity', (event) => {
  console.log('Activity:', event.message);
});
```

### cURL

```bash
# List personas
curl -X GET https://api.openclaw.local/api/personas \
  -H "Cookie: next-auth.session-token=$TOKEN"

# Create room
curl -X POST https://api.openclaw.local/api/rooms \
  -H "Content-Type: application/json" \
  -H "Cookie: next-auth.session-token=$TOKEN" \
  -d '{
    "name": "Team Discussion",
    "personaIds": ["persona_1", "persona_2"]
  }'

# Execute skill
curl -X POST https://api.openclaw.local/api/skills/execute \
  -H "Content-Type: application/json" \
  -H "Cookie: next-auth.session-token=$TOKEN" \
  -d '{
    "name": "file_read",
    "args": {"path": "README.md"}
  }'
```

---

## Changelog

| Version | Date       | Changes                             |
| ------- | ---------- | ----------------------------------- |
| 1.0.0   | 2026-02-17 | Initial comprehensive API reference |

---

## See Also

- [Memory Architecture](memory-architecture.md)
- [Worker System](WORKER_SYSTEM.md)
- [Model Hub System](MODEL_HUB_SYSTEM.md)
- [Skills System](SKILLS_SYSTEM.md)
- [Omnichannel Gateway](OMNICHANNEL_GATEWAY_SYSTEM.md)
- [Persona & Rooms](PERSONA_ROOMS_SYSTEM.md)
- [Automation System](AUTOMATION_SYSTEM.md)
- [Security System](SECURITY_SYSTEM.md)
