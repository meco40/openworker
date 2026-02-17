# Worker System

**Version:** 1.0  
**Last Updated:** 2026-02-17

## Overview

The Worker System is an enterprise-grade asynchronous task execution platform that enables multi-stage AI-driven workflows. It provides a robust foundation for autonomous task planning, execution with tool integration, human-in-the-loop approval workflows, and sophisticated Orchestra flow orchestration.

The system combines state-machine-driven task lifecycle management with AI-powered step execution, supporting both local executor runtimes and OpenAI's hosted worker infrastructure. Each task operates within an isolated workspace with full audit trails, deliverables tracking, and subagent delegation capabilities.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              WORKER SYSTEM ARCHITECTURE                                  │
│                     Task Lifecycle & Execution Flow                                     │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                    API LAYER                                            │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐  │
│  │ /api/worker  │ │ /planning    │ │ /subagents   │ │/deliverables │ │ /orchestra   │  │
│  │   CRUD       │ │   Phase      │ │   Sessions   │ │   Output     │ │   Flows      │  │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘  │
└─────────┼────────────────┼────────────────┼────────────────┼────────────────┼──────────┘
          │                │                │                │                │
          ▼                ▼                ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                               SERVICE LAYER                                             │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│  │                         STATE MACHINE (workerStateMachine.ts)                    │   │
│  │  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐       │   │
│  │  │  MANUAL │◄──►│  SYSTEM │◄──►│ WAITING │◄──►│  AUTO   │◄──►│  FINAL  │       │   │
│  │  │TRANSITIONS│   │TRANSITIONS│   │APPROVAL   │   │EXECUTION │   │ STATES  │       │   │
│  │  └─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘       │   │
│  └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                         │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────────────────┐ │
│  │   PLANNER           │  │   EXECUTOR          │  │   ORCHESTRA RUNNER              │ │
│  │   (workerPlanner.ts)│  │   (workerExecutor.ts)│  │   (orchestraRunner.ts)          │ │
│  │                     │  │                     │  │                                 │ │
│  │  • AI Plan Gen      │  │  • Tool Loop (10x)  │  │  • Graph Execution              │ │
│  │  • Persona Context  │  │  • Shell/File/Browser│  │  • Static/LLM Routing           │ │
│  │  • Step Breakdown   │  │  • Python Execution │  │  • Parallel Node Execution      │ │
│  └─────────────────────┘  └─────────────────────┘  └─────────────────────────────────┘ │
│                                                                                         │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────────────────┐ │
│  │   WORKSPACE MANAGER │  │   PERSONA INTEGRATION│  │   OPENAI RUNTIME               │ │
│  │   (workspaceManager)│  │   (personaIntegration)│  │   (openaiWorkerRuntime)        │ │
│  │                     │  │                      │  │                                │ │
│  │  • Type Scaffolds   │  │  • SOUL.md Context   │  │  • Budget Controls             │ │
│  │  • File I/O         │  │  • TOOLS.md Filter   │  │  • Rate Limiting               │ │
│  │  • Export/Archive   │  │  • Prompt Building   │  │  • Event Processing            │ │
│  └─────────────────────┘  └─────────────────────┘  └─────────────────────────────────┘ │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              REPOSITORY LAYER                                           │
│                                                                                         │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────────────┐│
│  │TaskRepository│ │StepRepository│ │ArtifactRepository│ │FlowRepository│ │SubagentRepository   ││
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────────────┘│
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────┐ ┌─────────────────────────────┐│
│  │Deliverable  │ │Activity     │ │ApprovalRule         │ │UserSettingsRepository       ││
│  │Repository   │ │Repository   │ │Repository           │ │                             ││
│  └─────────────┘ └─────────────┘ └─────────────────────┘ └─────────────────────────────┘│
│                                                                                         │
│                              SQLite (worker.db)                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

## Core Concepts

### Task

A Task is the fundamental work unit in the Worker System. It represents a persisted, trackable objective that progresses through a defined lifecycle from creation to completion.

**Key Properties:**

- **ID**: Unique identifier (UUID)
- **Status**: Current state in the state machine
- **Priority**: `low` | `normal` | `high` | `urgent`
- **Workspace**: Isolated file system context
- **Persona**: Optional AI persona assignment for customized behavior
- **Planning Messages**: Conversation history during planning phase

### Step

Steps are discrete, executable actions derived from task planning. Each step tracks:

- Index (execution order)
- Description (action to perform)
- Status: `pending` | `running` | `completed` | `failed` | `skipped`
- Output (execution result)
- Tool calls (record of AI tool invocations)

### Workspace

Every task receives an isolated file system workspace under `workspaces/<taskId>/`. Workspaces are typed (`research`, `webapp`, `creative`, `data`, `general`) and pre-populated with scaffold directories appropriate to the type.

### Persona Integration

Tasks can be assigned AI personas that customize:

- **System Instructions** (from SOUL.md + AGENTS.md + USER.md)
- **Allowed Tools** (from TOOLS.md)
- **Response Style** (vibe and emoji identity)
- **Model Preferences** (preferred model and Model Hub profile)

## Architecture Components

### State Machine (`workerStateMachine.ts`)

The state machine governs all status transitions, enforcing rules for both manual (user) and system (agent) operations.

**Active Statuses** (block most manual transitions):

- `planning` - AI analyzing and planning task
- `executing` - Step execution in progress
- `clarifying` - Awaiting user clarification
- `waiting_approval` - Paused for human approval

### Repository Pattern (`workerRepository.ts`)

The repository layer uses a facade pattern delegating to specialized repositories:

| Repository               | Responsibility                          |
| ------------------------ | --------------------------------------- |
| `TaskRepository`         | Task CRUD, lifecycle, status management |
| `StepRepository`         | Step creation, status updates           |
| `ArtifactRepository`     | Generated artifact storage              |
| `FlowRepository`         | Orchestra flows, drafts, runs, nodes    |
| `SubagentRepository`     | Subagent session management             |
| `DeliverableRepository`  | Task output deliverables                |
| `ApprovalRuleRepository` | Command approval whitelist              |
| `ActivityRepository`     | Audit trail logging                     |

### Workspace Manager (`workspaceManager.ts`)

Cross-platform file system abstraction providing:

- Type-specific scaffold creation
- File read/write operations
- Recursive directory listing
- Size calculation and export

**Workspace Types:**

```typescript
type WorkspaceType = 'research' | 'webapp' | 'creative' | 'data' | 'general';
```

**Scaffold Templates:**

- `research`: `sources/`, `notes/`, `output/`, `logs/`
- `webapp`: `output/`, `logs/`
- `creative`: `assets/`, `output/`, `logs/`
- `data`: `input/`, `output/`, `logs/`
- `general`: `output/`, `logs/`

## Task Lifecycle

### State Machine Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              TASK STATE MACHINE                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘

    ┌─────────┐
    │  INBOX  │ ◄─────────────────────────────────────────────────────────────────────┐
    └────┬────┘                                                                      │
         │ manual: queue                                                              │
         ▼                                                                           │
    ┌─────────┐     manual: assign      ┌─────────┐                                  │
    │ QUEUED  │◄───────────────────────►│ ASSIGNED│                                  │
    └────┬────┘                         └─────────┘                                  │
         │ system: start_planning                                                    │
         ▼                                                                           │
    ┌─────────┐     needs clarification  ┌─────────┐                                 │
    │PLANNING │◄────────────────────────►│CLARIFYING│                                │
    └────┬────┘                          └────┬────┘                                 │
         │ planning complete                   │ answer received                      │
         ▼                                      ▼                                     │
    ┌─────────┐     approval required     ┌─────────┐                                │
    │EXECUTING│◄─────────────────────────►│WAITING  │                                │
    └────┬────┘    (shell commands)       │APPROVAL │                                │
         │                                 └────┬────┘                                │
         │ system: step done                      │ approve/deny                      │
         ▼                                        ▼                                   │
    ┌─────────┐     ┌─────────┐     ┌─────────┐                                     │
    │ TESTING │────►│ REVIEW  │────►│COMPLETED│─────────────────────────────────────┘
    └────┬────┘     └────┬────┘     └─────────┘
         │               │
         └───────────────┘
                │
                ▼
    ┌─────────┐     ┌─────────┐     ┌─────────┐
    │  FAILED │◄────│INTERRUPTED│◄──│CANCELLED│
    └────┬────┘     └─────────┘     └─────────┘
         │
         │ manual: retry
         └───────────────────────► QUEUED
```

### Status Definitions

| Status             | Description                      | Transitions                                            |
| ------------------ | -------------------------------- | ------------------------------------------------------ |
| `inbox`            | Newly created, awaiting triage   | → `queued`, `assigned`, `cancelled`                    |
| `queued`           | Ready for execution pickup       | → `planning`, `inbox`, `cancelled`                     |
| `assigned`         | Assigned to specific persona     | → `queued`, `inbox`, `cancelled`                       |
| `planning`         | AI creating execution plan       | → `executing`, `clarifying`                            |
| `clarifying`       | Awaiting user input for planning | → `planning`, `executing`                              |
| `executing`        | Active step execution            | → `testing`, `review`, `waiting_approval`, `completed` |
| `waiting_approval` | Paused for command approval      | → `executing`                                          |
| `testing`          | Quality assurance phase          | → `review`, `executing`, `cancelled`                   |
| `review`           | Human review required            | → `completed`, `assigned`, `cancelled`                 |
| `completed`        | Successfully finished            | → `review`                                             |
| `failed`           | Execution failed                 | → `queued`, `cancelled`                                |
| `interrupted`      | External interruption            | → `queued`, `cancelled`                                |
| `cancelled`        | Manually cancelled               | (terminal)                                             |

### Manual vs System Transitions

**Manual transitions** (user-initiated via PATCH API):

- Blocked during active processing (`planning`, `executing`, `clarifying`, `waiting_approval`)
- Only `cancelled` allowed from active states
- Enable Kanban-style workflow management

**System transitions** (agent-initiated):

- Follow logical execution flow
- Universal targets: `failed`, `cancelled`, `interrupted` reachable from any state
- Drive autonomous task progression

## Planning Phase

The planning phase transforms a high-level objective into an executable sequence of steps.

### Planning Flow

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              PLANNING PHASE FLOW                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘

    User Creates Task
           │
           ▼
    ┌─────────────┐
    │   QUEUED    │
    └──────┬──────┘
           │ System picks up task
           ▼
    ┌─────────────┐     ┌─────────────────────────────────────┐
    │  PLANNING   │────►│ AI analyzes objective               │
    │   STATUS    │     │ • Load persona context              │
    └─────────────┘     │ • Build system prompt               │
                        │ • Generate step plan                │
                        └─────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
            ┌───────────┐   ┌───────────┐   ┌───────────┐
            │  Clear    │   │  Needs    │   │  Direct   │
            │  Objective│   │  Clarify  │   │  Execution│
            └─────┬─────┘   └─────┬─────┘   └─────┬─────┘
                  │               │               │
                  ▼               ▼               ▼
            ┌───────────┐   ┌───────────┐   ┌───────────┐
            │  Save     │   │CLARIFYING │   │  Save     │
            │  Steps    │   │  STATUS   │   │  Steps    │
            │  to DB    │   │           │   │  to DB    │
            └─────┬─────┘   └─────┬─────┘   └─────┬─────┘
                  │               │               │
                  │               ▼               │
                  │         User answers          │
                  │         planning question     │
                  │               │               │
                  └───────────────┴───────────────┘
                                  │
                                  ▼
                          ┌─────────────┐
                          │  EXECUTING  │
                          │   STATUS    │
                          └─────────────┘
```

### Planning API

| Method | Endpoint                           | Description                      |
| ------ | ---------------------------------- | -------------------------------- |
| GET    | `/api/worker/[id]/planning`        | Get planning status and messages |
| POST   | `/api/worker/[id]/planning`        | Start or continue planning       |
| POST   | `/api/worker/[id]/planning/answer` | Submit clarification answer      |

### Planning Message Format

```typescript
interface PlanningMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface PlanningQuestion {
  question: string;
  options: string[];
  context?: string;
}
```

### Persona-Aware Planning

When a persona is assigned:

1. Load persona's SOUL.md for behavioral context
2. Apply persona-specific planning style
3. Filter available tools via TOOLS.md
4. Include persona identity in prompts

## Execution Phase

The execution phase runs each planned step using an AI tool-calling loop.

### Execution Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                             EXECUTION PHASE ARCHITECTURE                                 │
└─────────────────────────────────────────────────────────────────────────────────────────┘

    ┌─────────────────────────────────────────────────────────────────────────────────┐
    │                           EXECUTOR (workerExecutor.ts)                           │
    │                                                                                  │
    │  ┌─────────────────────────────────────────────────────────────────────────┐   │
    │  │                      TOOL DEFINITIONS                                  │   │
    │  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────────────┐ │   │
    │  │  │shell_execute│ │  file_read  │ │ write_file  │ │   browser_fetch     │ │   │
    │  │  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────────────┘ │   │
    │  │  ┌─────────────┐ ┌─────────────┐                                        │   │
    │  │  │python_execute│ │ search_web │                                        │   │
    │  │  └─────────────┘ └─────────────┘                                        │   │
    │  └─────────────────────────────────────────────────────────────────────────┘   │
    │                                                                                  │
    │  ┌─────────────────────────────────────────────────────────────────────────┐   │
    │  │                      EXECUTION LOOP (Max 10 iterations)                │   │
    │  │                                                                          │   │
    │  │   ┌─────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────┐    │   │
    │  │   │  AI     │───►│  Function   │───►│   Tool      │───►│ Result  │    │   │
    │  │   │ Request │    │   Call      │    │ Dispatcher  │    │ ──► AI  │    │   │
    │  │   └─────────┘    └─────────────┘    └─────────────┘    └─────────┘    │   │
    │  │        ▲                                                    │         │   │
    │  │        └────────────────────────────────────────────────────┘         │   │
    │  │                              (repeat until no function calls)          │   │
    │  └─────────────────────────────────────────────────────────────────────────┘   │
    │                                                                                  │
    │  ┌─────────────────────────────────────────────────────────────────────────┐   │
    │  │                      TOOL DISPATCHER                                   │   │
    │  │                                                                          │   │
    │  │   • shell_execute ──► shellExecuteHandler()                           │   │
    │  │   • file_read ──────► fileReadHandler()                               │   │
    │  │   • write_file ─────► workspaceManager.writeFile()                    │   │
    │  │   • browser_fetch ──► browserSnapshotHandler()                        │   │
    │  │   • python_execute ─► pythonExecuteHandler()                          │   │
    │  │   • search_web ─────► browserSnapshotHandler(DuckDuckGo)              │   │
    │  └─────────────────────────────────────────────────────────────────────────┘   │
    └─────────────────────────────────────────────────────────────────────────────────┘
```

### Available Tools

| Tool             | Description                              | Persona Control     |
| ---------------- | ---------------------------------------- | ------------------- |
| `shell_execute`  | Execute shell commands (PowerShell/bash) | TOOLS.md restricted |
| `file_read`      | Read file contents                       | TOOLS.md restricted |
| `write_file`     | Write files to workspace                 | TOOLS.md restricted |
| `browser_fetch`  | Fetch and extract web page content       | TOOLS.md restricted |
| `python_execute` | Execute Python code                      | TOOLS.md restricted |
| `search_web`     | Web search via DuckDuckGo                | TOOLS.md restricted |

### Step Result Structure

```typescript
interface StepResult {
  output: string; // AI summary
  toolCalls?: Array<{
    // Tool execution log
    name: string;
    args: Record<string, unknown>;
    result: string;
  }>;
  artifacts?: Array<{
    // Generated deliverables
    name: string;
    type: 'code' | 'file' | 'doc' | 'image' | 'data';
    content: string;
    mimeType?: string;
  }>;
}
```

## Approval Workflow

The approval workflow provides human oversight for sensitive operations, particularly shell command execution.

### Approval Flow

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              APPROVAL WORKFLOW                                           │
└─────────────────────────────────────────────────────────────────────────────────────────┘

    Step Execution
           │
           ▼
    ┌─────────────┐
    │ shell_execute│
    │  requested   │
    └──────┬──────┘
           │
           ▼
    ┌─────────────┐     Whitelisted?     ┌─────────────┐
    │ Check Rules │─────────────────────►│   Execute   │
    │             │        YES           │             │
    └──────┬──────┘                      └─────────────┘
           │ NO
           ▼
    ┌─────────────┐
    │  Save       │
    │  Checkpoint │
    │  (pending)  │
    └──────┬──────┘
           │
           ▼
    ┌─────────────┐
    │WAITING      │◄─────────────────────────────────────────────┐
    │APPROVAL     │                                              │
    └──────┬──────┘                                              │
           │                                                     │
    ┌──────┴──────┐                                              │
    │  User Action │                                             │
    │              │                                             │
    │  ┌────────┐ │    ┌────────┐    ┌────────┐                 │
    │  │/approve│ │    │/deny   │    │/approve│                 │
    │  │        │ │    │        │    │-always │                 │
    │  └───┬────┘ │    └───┬────┘    └───┬────┘                 │
    │      │      │        │             │ (adds to whitelist)   │
    │      └──────┴────────┴─────────────┘                     │
    │                      │                                     │
    │              ┌───────┴───────┐                            │
    │              ▼               ▼                            │
    │      ┌─────────────┐ ┌─────────────┐                      │
    │      │  APPROVED   │ │   DENIED    │                      │
    │      │  Resume     │ │   Fail      │                      │
    │      │  Execution  │ │   Step      │                      │
    │      └──────┬──────┘ └──────┬──────┘                      │
    │             │               │                             │
    │             └───────┬───────┘                             │
    │                     │                                     │
    └─────────────────────┘                                     │
                          │                                     │
                          ▼                                     │
                   ┌─────────────┐                              │
                   │  Poll for   │──────────────────────────────┘
                   │  Response   │
                   │  (5 min max)│
                   └─────────────┘
```

### Approval API Actions

| Action           | Description                                  |
| ---------------- | -------------------------------------------- |
| `approve`        | Approve current pending command              |
| `deny`           | Deny current pending command                 |
| `approve-always` | Approve and add command pattern to whitelist |

### Approval Rules

Approval rules are stored in the database and support pattern matching for commands that should be automatically approved.

```typescript
interface ApprovalRule {
  id: string;
  commandPattern: string;
  createdAt: string;
}
```

## Subagent System

Subagents enable delegation of work to specialized AI agents within a task context.

### Subagent Session Model

```typescript
interface WorkerSubagentSessionRecord {
  id: string;
  taskId: string;
  runId: string | null; // Orchestra run context
  nodeId: string | null; // Orchestra node context
  userId: string;
  personaId: string | null; // Assigned persona
  status: 'started' | 'running' | 'completed' | 'failed' | 'cancelled';
  sessionRef: string | null; // External reference
  metadata: string | null;
  startedAt: string;
  completedAt: string | null;
}
```

### Subagent API

| Method | Endpoint                     | Description             |
| ------ | ---------------------------- | ----------------------- |
| GET    | `/api/worker/[id]/subagents` | List subagent sessions  |
| POST   | `/api/worker/[id]/subagents` | Create subagent session |
| PATCH  | `/api/worker/[id]/subagents` | Update subagent status  |

### Subagent Lifecycle

1. **Creation**: Parent task creates subagent session with optional persona assignment
2. **Execution**: Subagent operates independently with its own context
3. **Monitoring**: Parent tracks subagent progress via status updates
4. **Completion**: Subagent reports results back to parent task

## Deliverables System

Deliverables represent task outputs that should be tracked and potentially exposed to users.

### Deliverable Types

```typescript
type DeliverableType = 'file' | 'url' | 'artifact' | 'text';

interface WorkerTaskDeliverableRecord {
  id: string;
  taskId: string;
  runId: string | null;
  nodeId: string | null;
  type: DeliverableType;
  name: string;
  content: string;
  mimeType: string | null;
  metadata: string | null;
  createdAt: string;
}
```

### Deliverable Creation

Deliverables are created:

- Automatically when `write_file` tool is called
- Manually via API for external resources
- By Orchestra nodes upon completion

### Deliverable API

| Method | Endpoint                        | Description            |
| ------ | ------------------------------- | ---------------------- |
| GET    | `/api/worker/[id]/deliverables` | List task deliverables |
| POST   | `/api/worker/[id]/deliverables` | Create deliverable     |

## Workspace Management

### Workspace Structure

```
workspaces/
└── {taskId}/
    ├── .workspace.json      # Metadata
    ├── output/              # Generated outputs
    ├── logs/                # Execution logs
    ├── sources/             # Research sources (research type)
    ├── notes/               # Research notes (research type)
    ├── assets/              # Creative assets (creative type)
    └── input/               # Input data (data type)
```

### Workspace API

| Method | Endpoint                  | Description                  |
| ------ | ------------------------- | ---------------------------- |
| GET    | `/api/worker/[id]/files`  | List workspace files         |
| POST   | `/api/worker/[id]/files`  | Write file to workspace      |
| GET    | `/api/worker/[id]/export` | Export workspace as archive  |
| POST   | `/api/worker/[id]/test`   | Test workspace accessibility |

### Workspace Operations

The `WorkspaceManager` provides:

```typescript
class WorkspaceManagerImpl {
  createWorkspace(taskId: string, type: WorkspaceType): string;
  writeFile(taskId: string, relativePath: string, content: string | Buffer): void;
  readFile(taskId: string, relativePath: string): Buffer | null;
  readTextFile(taskId: string, relativePath: string): string | null;
  listFiles(taskId: string, subPath?: string): WorkspaceFile[];
  deleteWorkspace(taskId: string): void;
  getWorkspaceSize(taskId: string): number;
}
```

## Orchestra Workflows

Orchestra provides visual workflow orchestration with a graph-based execution model.

### Orchestra Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              ORCHESTRA WORKFLOW SYSTEM                                   │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              FLOW DEFINITION                                             │
│                                                                                          │
│   ┌─────────┐      ┌─────────┐      ┌─────────┐      ┌─────────┐                       │
│   │  Node A │─────►│  Node B │─────►│  Node C │─────►│  Node D │                       │
│   │(Persona │      │(Persona │      │(LLM    │      │(Persona │                       │
│   │   1)    │      │   2)    │      │Routing)│      │   3)    │                       │
│   └─────────┘      └─────────┘      └────┬────┘      └─────────┘                       │
│                                          │                                              │
│                                    ┌─────┴─────┐                                        │
│                                    ▼           ▼                                        │
│                              ┌─────────┐ ┌─────────┐                                    │
│                              │  Node E │ │  Node F │                                    │
│                              │(Skipped)│ │(Running)│                                    │
│                              └─────────┘ └─────────┘                                    │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              RUNTIME EXECUTION                                           │
│                                                                                          │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│   │                         ORCHESTRA RUNNER                                         │   │
│   │                                                                                  │   │
│   │  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐       │   │
│   │  │  Identify   │───►│   Execute   │───►│   Route     │───►│  Mark       │       │   │
│   │  │  Runnable   │    │   Nodes     │    │   Next      │    │  Complete   │       │   │
│   │  │  Nodes      │    │   (Parallel)│    │   Nodes     │    │  / Failed   │       │   │
│   │  └─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘       │   │
│   │         ▲                                                    │                   │   │
│   │         └────────────────────────────────────────────────────┘                   │   │
│   │                              (until no more runnable)                            │   │
│   └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### Orchestra Types

```typescript
interface OrchestraFlowGraph {
  startNodeId?: string;
  nodes: OrchestraGraphNode[];
  edges: OrchestraGraphEdge[];
}

interface OrchestraGraphNode {
  id: string;
  personaId: string;
  position: { x: number; y: number };
  label?: string;
  skillIds?: string[];
  routing?: {
    mode: 'static' | 'llm';
    allowedNextNodeIds?: string[];
  };
}

interface OrchestraGraphEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}
```

### Orchestra Flow Lifecycle

1. **Draft**: Create and edit flow graph
2. **Publish**: Create immutable published version
3. **Run**: Execute flow with task context
4. **Monitor**: Track node status and routing decisions

### Orchestra API

| Method | Endpoint                                   | Description       |
| ------ | ------------------------------------------ | ----------------- |
| GET    | `/api/worker/orchestra/flows`              | List flow drafts  |
| POST   | `/api/worker/orchestra/flows`              | Create flow draft |
| GET    | `/api/worker/orchestra/flows/[id]`         | Get flow details  |
| PATCH  | `/api/worker/orchestra/flows/[id]`         | Update flow       |
| DELETE | `/api/worker/orchestra/flows/[id]`         | Delete flow       |
| POST   | `/api/worker/orchestra/flows/[id]/publish` | Publish flow      |

### Routing Modes

**Static Routing:**

- Follows predefined edges
- Respects `allowedNextNodeIds` restrictions
- Other pending targets marked as `skipped`

**LLM Routing:**

- AI decides which branches to activate
- Context: node summary, available targets
- Decision format: `{ chosenNodeIds: string[], reason: string }`
- Falls back to static routing on failure

## OpenAI Worker

The OpenAI Worker runtime enables delegation to OpenAI's hosted worker infrastructure.

### OpenAI Runtime Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              OPENAI WORKER RUNTIME                                       │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              LOCAL GATEWAY                                               │
│                                                                                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐ │
│  │  Budget Control │  │  Rate Limiting  │  │  Event Handler  │  │  Approval Bridge    │ │
│  │                 │  │                 │  │                 │  │                     │ │
│  │ • Max tokens/run│  │ • Per-user RPM  │  │ • Ingest events │  │ • Convert local     │ │
│  │ • Max cost/run  │  │ • Window tracked│  │ • Apply state   │  │   approval to       │ │
│  │ • Daily limits  │  │ • Auto-retry    │  │   updates       │  │   OpenAI tokens     │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  └─────────────────────┘ │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ HTTP/WebSocket
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           OPENAI WORKER SERVICE                                          │
│                                                                                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐ │
│  │  Task Execution │  │  Tool Calls     │  │  Subagents      │  │  Event Emission     │ │
│  │                 │  │                 │  │                 │  │                     │ │
│  │ • Plan generation│  │ • Code execution│  │ • Delegate work │  │ • task.started      │ │
│  │ • Step execution │  │ • File operations│ │ • Monitor       │  │ • task.progress     │ │
│  │ • Completion     │  │ • Web browsing  │  │ • Collect       │  │ • task.completed    │ │
│  │                  │  │                 │  │   results       │  │ • task.failed       │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  └─────────────────────┘ │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### OpenAI Event Types

```typescript
type OpenAiWorkerEventType =
  | 'task.started'
  | 'task.progress'
  | 'task.approval_required'
  | 'task.completed'
  | 'task.failed'
  | 'subagent.started'
  | 'subagent.progress'
  | 'subagent.completed'
  | 'subagent.failed';
```

### OpenAI Runtime Limits

| Limit                            | Environment Variable                          | Default |
| -------------------------------- | --------------------------------------------- | ------- |
| Max tokens per run               | `OPENAI_WORKER_MAX_TOKENS_PER_RUN`            | 120,000 |
| Max cost per run (USD)           | `OPENAI_WORKER_MAX_COST_USD_PER_RUN`          | $10     |
| Max cost per user per day (USD)  | `OPENAI_WORKER_MAX_COST_USD_PER_USER_PER_DAY` | $25     |
| Max requests per minute per user | `OPENAI_WORKER_MAX_REQ_PER_MIN_PER_USER`      | 60      |

### Model Routing

```typescript
interface OpenAiTaskModelRouting {
  personaId: string | null;
  preferredModelId: string | null;
  modelHubProfileId: string;
}
```

Resolution order:

1. Persona's `modelHubProfileId` (if assigned and valid)
2. `OPENAI_WORKER_MODEL_HUB_PROFILE` environment variable
3. Gateway config `worker.openai.modelHubProfile`
4. Default: `p1`

## API Reference

### Core Task API

| Method | Endpoint                      | Description                       |
| ------ | ----------------------------- | --------------------------------- |
| GET    | `/api/worker`                 | List tasks with filtering         |
| POST   | `/api/worker`                 | Create new task                   |
| DELETE | `/api/worker`                 | Bulk delete tasks                 |
| GET    | `/api/worker/[id]`            | Get task with steps and artifacts |
| PATCH  | `/api/worker/[id]`            | Execute task action               |
| DELETE | `/api/worker/[id]`            | Delete task and workspace         |
| POST   | `/api/worker/[id]/test`       | Test workspace access             |
| GET    | `/api/worker/[id]/activities` | Get activity feed                 |

### Task Actions (PATCH Body)

```typescript
interface PatchRequest {
  action: 'cancel' | 'resume' | 'retry' | 'approve' | 'deny' | 'approve-always' | 'move' | 'assign';
  status?: string; // For 'move' action
  personaId?: string | null; // For 'assign' action
}
```

### Planning API

| Method | Endpoint                           | Description                 |
| ------ | ---------------------------------- | --------------------------- |
| GET    | `/api/worker/[id]/planning`        | Get planning status         |
| POST   | `/api/worker/[id]/planning`        | Start/continue planning     |
| POST   | `/api/worker/[id]/planning/answer` | Submit clarification answer |

### Workspace API

| Method | Endpoint                  | Description          |
| ------ | ------------------------- | -------------------- |
| GET    | `/api/worker/[id]/files`  | List workspace files |
| POST   | `/api/worker/[id]/files`  | Write file           |
| GET    | `/api/worker/[id]/export` | Export workspace     |

### Subagent API

| Method | Endpoint                     | Description    |
| ------ | ---------------------------- | -------------- |
| GET    | `/api/worker/[id]/subagents` | List sessions  |
| POST   | `/api/worker/[id]/subagents` | Create session |
| PATCH  | `/api/worker/[id]/subagents` | Update status  |

### Deliverables API

| Method | Endpoint                        | Description        |
| ------ | ------------------------------- | ------------------ |
| GET    | `/api/worker/[id]/deliverables` | List deliverables  |
| POST   | `/api/worker/[id]/deliverables` | Create deliverable |

### Workflow API

| Method | Endpoint                    | Description                 |
| ------ | --------------------------- | --------------------------- |
| GET    | `/api/worker/[id]/workflow` | Get Orchestra workflow view |

### Settings API

| Method | Endpoint               | Description          |
| ------ | ---------------------- | -------------------- |
| GET    | `/api/worker/settings` | Get worker settings  |
| PUT    | `/api/worker/settings` | Save worker settings |

### Orchestra API

| Method | Endpoint                                   | Description  |
| ------ | ------------------------------------------ | ------------ |
| GET    | `/api/worker/orchestra/flows`              | List flows   |
| POST   | `/api/worker/orchestra/flows`              | Create flow  |
| GET    | `/api/worker/orchestra/flows/[id]`         | Get flow     |
| PATCH  | `/api/worker/orchestra/flows/[id]`         | Update flow  |
| DELETE | `/api/worker/orchestra/flows/[id]`         | Delete flow  |
| POST   | `/api/worker/orchestra/flows/[id]/publish` | Publish flow |

## Configuration

### Environment Variables

| Variable                                      | Description                           | Default            |
| --------------------------------------------- | ------------------------------------- | ------------------ |
| `WORKER_DB_PATH`                              | SQLite database path                  | `.local/worker.db` |
| `WORKER_RUNTIME`                              | Default runtime (`local` \| `openai`) | `local`            |
| `OPENAI_WORKER_MAX_TOKENS_PER_RUN`            | Token limit per OpenAI run            | 120000             |
| `OPENAI_WORKER_MAX_COST_USD_PER_RUN`          | Cost limit per run                    | 10                 |
| `OPENAI_WORKER_MAX_COST_USD_PER_USER_PER_DAY` | Daily cost limit per user             | 25                 |
| `OPENAI_WORKER_MAX_REQ_PER_MIN_PER_USER`      | Rate limit per user                   | 60                 |
| `OPENAI_WORKER_MODEL_HUB_PROFILE`             | Default Model Hub profile             | -                  |

### Gateway Config

```typescript
interface WorkerGatewayConfig {
  runtime: 'local' | 'openai';
  openai?: {
    modelHubProfile?: string;
    enabledTools?: string[];
    toolApprovalPolicy?: 'interactive' | 'auto' | string[];
  };
}
```

### Persona Configuration Files

Personas configure worker behavior through three markdown files:

**SOUL.md**: System instructions and behavioral context  
**IDENTITY.md**: Name, emoji, vibe metadata  
**TOOLS.md**: Allowed tools list

Example TOOLS.md:

```markdown
# Allowed Tools

- file_read
- write_file
- browser_fetch

# shell_execute # Commented = not allowed
```

## Error Handling

### Task Error States

| State         | Cause                         | Recovery        |
| ------------- | ----------------------------- | --------------- |
| `failed`      | Execution error, tool failure | `retry` action  |
| `interrupted` | External interruption, crash  | `resume` action |
| `cancelled`   | User cancellation             | None (terminal) |

### Checkpoint System

Tasks use a checkpoint system for resumable operations:

```typescript
interface TaskCheckpoint {
  pendingCommand?: string;
  approvalResponse?: 'approved' | 'denied' | null;
  openaiApprovalToken?: string;
  phase?: string;
  // Additional context for resumption
}
```

### Error Recovery Flow

1. **Detection**: Error caught during execution
2. **Logging**: Activity record created with error details
3. **Status Update**: Task moved to `failed` or `interrupted`
4. **Notification**: Callback notification sent (if configured)
5. **Recovery**: User initiates `retry` or `resume` action

### Broadcast System

Status changes are broadcast to connected clients:

```typescript
broadcastStatus(taskId: string, status: WorkerTaskStatus, message: string): void
```

## Testing

### Unit Tests

```bash
npm run test -- tests/unit/worker
```

### Integration Tests

```bash
npm run test -- tests/integration/worker
```

### Type Checking

```bash
npm run typecheck
```

### Linting

```bash
npm run lint
```

### Test Utilities

```typescript
// Reset OpenAI runtime state between tests
resetOpenAiRuntimeStateForTests(): void;

// Test workspace access
POST /api/worker/[id]/test
```

## Related Documentation

- [Memory Architecture](./memory-architecture.md) - Context and memory systems
- [Skills System](./SKILLS_SYSTEM.md) - Tool implementation details
- [API Reference](./API_REFERENCE.md) - Complete API documentation
