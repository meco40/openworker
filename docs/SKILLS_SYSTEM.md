# Skills System

## Metadata

- Purpose: Verbindliche Referenz fuer Skill-Lifecycle und Skill-Execution-Governance.
- Scope: Skill-Registry, Installation, Runtime-Konfiguration, Dispatch und Sicherheitsgrenzen.
- Source of Truth: This is the active system documentation for this domain and overrides archived documents on conflicts.
- Last Reviewed: 2026-03-03
- Related Runbooks: docs/runbooks/chat-cli-smoke-approval.md

---

This document describes the complete Skills System architecture, covering skill lifecycle management, execution dispatch, runtime configuration, security sandboxing, and integration with ClawHub.

## Overview

The Skills System is a modular, extensible framework that enables the AI assistant to execute domain-specific capabilities through a unified interface. It combines **built-in skills** (shipped with the system) with **external skills** (installed from GitHub, npm, or manual sources) through a controlled execution environment.

Current runtime baseline: 34 built-in skills (11 installed by default, 23 opt-in/compat).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SKILLS SYSTEM ARCHITECTURE                          │
│                  Modular Execution & Lifecycle Management                   │
└─────────────────────────────────────────────────────────────────────────────┘

╔═══════════════════════════════════════════════════════════════════════════╗
║  LAYER 1: SKILL REGISTRY (Persistence & Metadata)                         ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  • SQLite-backed skill storage (.local/skills.db)                         ║
║  • Skill metadata (name, version, category, install status)               ║
║  • Tool definitions (JSON Schema parameters)                              ║
║  • Source tracking (built-in, github, npm, manual)                        ║
╚═══════════════════════════════════════════════════════════════════════════╝
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
              ▼                     ▼                     ▼
┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
│   BUILT-IN SKILLS │  │  EXTERNAL SKILLS  │  │  CLAWHUB CATALOG  │
│   (Seed on boot)  │  │  (User-installed) │  │  (Discoverable)   │
├───────────────────┤  ├───────────────────┤  ├───────────────────┤
│ • browser         │  │ • GitHub repos    │  │ • Search index    │
│ • search          │  │ • npm packages    │  │ • Categories      │
│ • filesystem      │  │ • Manual manifests│  │ • Ratings         │
│ • python          │  │                   │  │                   │
│ • shell           │  │                   │  │                   │
│ • subagents       │  │                   │  │                   │
│ • web-fetch       │  │                   │  │                   │
│ • ... plus opt-in/compat skills        │  │                   │
└─────────┬─────────┘  └─────────┬─────────┘  └─────────┬─────────┘
          │                      │                      │
          └──────────────────────┼──────────────────────┘
                                 │
                                 ▼
╔═══════════════════════════════════════════════════════════════════════════╗
║  LAYER 2: RUNTIME CONFIGURATION                                           ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  • Secret/text configuration per skill field                              ║
║  • Environment variable fallback                                          ║
║  • Masked value display in UI                                             ║
║                                                                           ║
║  Fields:                                                                  ║
║  • vision.gemini_api_key     (secret, required)                           ║
║  • github-manager.github_token (secret, optional)                         ║
║  • sql-bridge.sqlite_db_path (text, required)                             ║
╚═══════════════════════════════════════════════════════════════════════════╝
                                 │
                                 ▼
╔═══════════════════════════════════════════════════════════════════════════╗
║  LAYER 3: EXECUTION DISPATCH                                              ║
╠═══════════════════════════════════════════════════════════════════════════╣
║                                                                           ║
║  ┌─────────────────────────────────────────────────────────────────────┐ ║
║  │                      HANDLER REGISTRY                               │ ║
║  ├─────────────────┬─────────────────┬─────────────────────────────────┤ ║
║  │  file_read      │  shell_execute  │  python_execute                 │ ║
║  │  ─────────────  │  ────────────── │  ──────────────                 │ ║
║  │  Workspace      │  Shell command  │  Python code                    │ ║
║  │  sandbox read   │  execution      │  execution                      │ ║
║  ├─────────────────┼─────────────────┼─────────────────────────────────┤ ║
║  │  browser_snapshot│ github_query   │  db_query                       │ ║
║  │  ───────────────│  ────────────   │  ────────                       │ ║
║  │  Web page       │  GitHub API     │  SQLite read-only               │ ║
║  │  fetching       │  integration    │  queries                        │ ║
║  ├─────────────────┴─────────────────┴─────────────────────────────────┤ ║
║  │                      vision_analyze                                 │ ║
║  │                      ─────────────                                  │ ║
║  │                      Image analysis via Gemini                      │ ║
║  └─────────────────────────────────────────────────────────────────────┘ ║
║                                                                           ║
║  Flow: name-based lookup → argument normalization → handler execution    ║
╚═══════════════════════════════════════════════════════════════════════════╝
                                 │
                                 ▼
╔═══════════════════════════════════════════════════════════════════════════╗
║  LAYER 4: SECURITY & SANDBOXING                                           ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  • Workspace path restriction (no directory traversal)                    ║
║  • Command blocking (dangerous operations)                                ║
║  • Read-only SQL enforcement                                              ║
║  • Timeout limits (15s shell, 20s python)                                 ║
║  • Output size limits (1MB buffer, 256KB files)                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
```

---

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [Architecture Components](#architecture-components)
3. [Skill Lifecycle](#skill-lifecycle)
4. [Built-in Skills Reference](#built-in-skills-reference)
5. [Handler System](#handler-system)
6. [Runtime Configuration](#runtime-configuration)
7. [Execution Flow](#execution-flow)
8. [Security Model](#security-model)
9. [ClawHub Integration](#clawhub-integration)
10. [API Reference](#api-reference)
11. [Configuration](#configuration)
12. [Error Handling](#error-handling)
13. [Testing](#testing)

---

## Core Concepts

### Skill Definition

A skill is a capability unit consisting of:

```typescript
interface SkillManifest {
  id: string; // Unique identifier (e.g., "filesystem")
  name: string; // Display name (e.g., "File Gateway")
  description: string; // Human-readable description
  version: string; // Semantic version
  category: string; // Grouping category
  functionName: string; // Handler dispatch name
  tool: SkillToolDefinition; // JSON Schema or built-in config
  handler?: string; // External handler path (optional)
}
```

### Tool Definition Types

**Standard Tool** (function-calling):

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameterProperty>;
    required?: string[];
  };
}
```

**Built-in Tool** (provider-native):

```typescript
interface BuiltInToolDefinition {
  builtIn: true;
  providerConfig: Record<string, unknown>;
}
// Example: Google Search Grounding
{
  builtIn: true,
  providerConfig: { gemini: { googleSearch: {} } }
}
```

### Skill Sources

| Source     | Description                      | Example                |
| ---------- | -------------------------------- | ---------------------- |
| `built-in` | Shipped with OpenClaw Gateway    | browser, filesystem    |
| `github`   | Installed from GitHub repository | `owner/repo#branch`    |
| `npm`      | Installed from npm registry      | `package-name`         |
| `manual`   | Direct manifest JSON upload      | Custom API-only skills |

---

## Architecture Components

### 1. Skill Repository (`skillRepository.ts`)

SQLite-based persistence layer for skill metadata.

**Schema:**

```sql
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  version TEXT NOT NULL,
  installed INTEGER NOT NULL DEFAULT 0,
  function_name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'built-in',
  source_url TEXT,
  tool_definition TEXT NOT NULL,
  handler_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**Key Operations:**

- `seedBuiltIns()` - Inserts built-in skills on first run (preserves user toggle state)
- `listSkills()` - Returns all skills with metadata
- `setInstalled(id, boolean)` - Toggles skill activation
- `installSkill(input)` - Registers external skill
- `removeSkill(id)` - Removes external skill (built-ins protected)

### 2. Skill Installer (`skillInstaller.ts`)

Handles skill installation from multiple sources.

**GitHub Flow:**

1. Parse URL (`owner/repo#branch`)
2. Fetch `skill.json` from raw.githubusercontent.com
3. Validate manifest structure
4. Download handler file to `skills/external/<skill-id>/`
5. Register in SQLite

**npm Flow:**

1. Run `npm install <package>`
2. Locate `skill.json` in installed package
3. Register with handler path pointing to `node_modules`

**Validation:**

```typescript
function validateManifest(data: unknown): SkillManifest {
  const required = ['id', 'name', 'description', 'version', 'category', 'functionName', 'tool'];
  // Throws if any required field missing
  // Validates tool definition structure
}
```

### 3. Runtime Configuration (`runtimeConfig.ts`)

Manages skill-specific configuration with environment fallback.

**Configuration Fields:**

```typescript
const SKILL_RUNTIME_CONFIG_FIELDS: SkillRuntimeConfigField[] = [
  {
    id: 'vision.gemini_api_key',
    skillId: 'vision',
    label: 'Vision (Gemini) API Key',
    kind: 'secret',
    required: true,
    envVars: ['GEMINI_API_KEY', 'API_KEY'],
  },
  {
    id: 'github-manager.github_token',
    skillId: 'github-manager',
    label: 'GitHub Token',
    kind: 'secret',
    required: false,
    envVars: ['GITHUB_TOKEN'],
  },
  {
    id: 'sql-bridge.sqlite_db_path',
    skillId: 'sql-bridge',
    label: 'SQLite Database Path',
    kind: 'text',
    required: true,
    envVars: ['SQLITE_DB_PATH'],
  },
];
```

**Resolution Priority:**

1. Stored value in SQLite (`skill_runtime_config` table)
2. Environment variable (first match in `envVars`)
3. null (if not required)

**Value Masking:**

- Secrets: `***` (full mask)
- Text >8 chars: `abcd...wxyz` (first/last 4)
- Text ≤8 chars: shown as-is

### 4. Execution Dispatcher (`executeSkill.ts`)

Central dispatch for skill handler execution.

```typescript
const SKILL_HANDLERS: Record<string, SkillHandler> = {
  file_read: fileReadHandler,
  shell_execute: shellExecuteHandler,
  python_execute: pythonExecuteHandler,
  github_query: githubQueryHandler,
  db_query: dbQueryHandler,
  browser_snapshot: browserSnapshotHandler,
  vision_analyze: visionAnalyzeHandler,
  subagents: subagentsHandler,
  'multi_tool_use.parallel': multiToolUseParallelHandler,
};

export async function dispatchSkill(name: string, args: Record<string, unknown>) {
  const handler = SKILL_HANDLERS[name];
  if (!handler) throw new Error(`Unsupported skill: ${name}`);
  return handler(args);
}
```

---

## Skill Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        SKILL LIFECYCLE                                  │
└─────────────────────────────────────────────────────────────────────────┘

   ┌─────────────┐
   │   CREATE    │
   │  (built-in) │
   └──────┬──────┘
          │ System boot
          ▼
   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
   │   SEED      │────▶│  INSTALLED  │◄────│   INSTALL   │
   │  (SQLite)   │     │  (default)  │     │  (external) │
   └──────┬──────┘     └──────┬──────┘     └─────────────┘
          │                   │
          │ User disables     │ User enables
          ▼                   ▼
   ┌─────────────┐     ┌─────────────┐
   │  DISABLED   │◄───▶│   ACTIVE    │
   │  (stored)   │     │ (available  │
   └─────────────┘     │  for LLM)   │
                       └──────┬──────┘
                              │
                              │ Execute
                              ▼
                       ┌─────────────┐
                       │   EXECUTE   │
                       │  (handler)  │
                       └──────┬──────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ▼               ▼               ▼
        ┌─────────┐    ┌─────────┐    ┌─────────┐
        │ Success │    │  Error  │    │ Timeout │
        └─────────┘    └─────────┘    └─────────┘

   ┌─────────────┐
   │   REMOVE    │ (external only)
   │  (delete)   │
   └─────────────┘
```

### State Transitions

| From            | To        | Trigger                   | API                       |
| --------------- | --------- | ------------------------- | ------------------------- |
| Seeded          | Installed | System boot               | Automatic                 |
| -               | Installed | GitHub/npm/manual install | `POST /api/skills`        |
| Installed       | Active    | User enables              | `PATCH /api/skills/[id]`  |
| Active          | Disabled  | User disables             | `PATCH /api/skills/[id]`  |
| Disabled        | Active    | User enables              | `PATCH /api/skills/[id]`  |
| Active/Disabled | Removed   | User uninstalls           | `DELETE /api/skills/[id]` |

**Note:** Built-in skills cannot be removed, only disabled.

---

## Built-in Skills Reference

### Core Extensions

#### `browser` - Managed Browser

| Attribute    | Value              |
| ------------ | ------------------ |
| **Function** | `browser_snapshot` |
| **Default**  | Installed          |
| **Category** | Web                |

Fetches web pages and extracts metadata (title, description, text excerpt).

**Parameters:**

```json
{
  "url": { "type": "string", "description": "Target URL to inspect" },
  "format": { "type": "string", "description": "png or jpeg" },
  "quality": { "type": "number", "description": "0-100" }
}
```

**Returns:**

```json
{
  "url": "https://example.com",
  "status": 200,
  "title": "Example Domain",
  "description": "...",
  "excerpt": "...",
  "fetchedAt": "2026-02-17T12:00:00Z"
}
```

#### `search` - Google Search

| Attribute    | Value          |
| ------------ | -------------- |
| **Function** | `__built_in__` |
| **Default**  | Installed      |
| **Category** | Intelligence   |

Native Google Search Grounding via Gemini provider.

**Configuration:**

```typescript
{
  builtIn: true,
  providerConfig: { gemini: { googleSearch: {} } }
}
```

### Automation & Code

#### `python` - Python Runtime

| Attribute    | Value            |
| ------------ | ---------------- |
| **Function** | `python_execute` |
| **Default**  | Installed        |
| **Category** | Automation       |

Executes Python code in a subprocess.

**Parameters:**

```json
{
  "code": { "type": "string", "description": "Python code to execute" }
}
```

**Limits:**

- Timeout: 20 seconds
- Max output: 1MB

**Returns:**

```json
{
  "stdout": "...",
  "stderr": "...",
  "exitCode": 0
}
```

#### `shell` - Shell Access

| Attribute    | Value           |
| ------------ | --------------- |
| **Function** | `shell_execute` |
| **Default**  | Installed       |
| **Category** | Automation      |

Executes shell commands with security restrictions.

**Parameters:**

```json
{
  "command": { "type": "string", "description": "Shell command to execute" }
}
```

**Security:**

- Blocked tokens: `rm -rf`, `shutdown`, `mkfs`, `powershell -enc`, etc.
- Timeout: 15 seconds
- Max output: 1MB

#### `github` - GitHub Manager

| Attribute    | Value          |
| ------------ | -------------- |
| **Function** | `github_query` |
| **Default**  | Not installed  |
| **Category** | Integration    |

GitHub API integration for repository operations.

**Parameters:**

```json
{
  "repo": { "type": "string", "description": "owner/repo format" },
  "action": { "type": "string", "enum": ["repo_info", "list_issues", "list_pulls", "search_code"] },
  "query": { "type": "string", "description": "Required for search_code" }
}
```

**Configuration:**

- Optional: `github-manager.github_token` (increases rate limits, enables private repos)

#### `subagents` - Delegation Manager

| Attribute    | Value       |
| ------------ | ----------- |
| **Function** | `subagents` |
| **Default**  | Installed   |
| **Category** | Automation  |

Spawns and steers delegated helper agents for complex workflows.

**Key Actions:**

- `list`
- `spawn`
- `kill`
- `steer`
- `info`
- `log`
- `help`

#### `multi-tool-use-parallel` - Parallel Tool Dispatcher

| Attribute    | Value                     |
| ------------ | ------------------------- |
| **Function** | `multi_tool_use.parallel` |
| **Default**  | Installed                 |
| **Category** | Automation                |

Runs multiple runtime tool calls in parallel via one dispatcher call.

**Parameters:**

```json
{
  "tool_uses": {
    "type": "array",
    "description": "List of tool calls with name + args"
  }
}
```

**Guards:**

- `tool_uses` must be a non-empty array
- nested `multi_tool_use.parallel` calls are blocked

### Data & Media

#### `vision` - Image Analysis

| Attribute    | Value            |
| ------------ | ---------------- |
| **Function** | `vision_analyze` |
| **Default**  | Installed        |
| **Category** | Media            |

Analyzes images using Google's Gemini API.

**Parameters:**

```json
{
  "imageUrl": { "type": "string", "description": "URL to image" },
  "imageBase64": { "type": "string", "description": "Base64-encoded image" },
  "mimeType": { "type": "string", "default": "image/png" },
  "focus": { "type": "string", "description": "Analysis focus prompt" }
}
```

**Configuration:**

- Required: `vision.gemini_api_key`

**Returns:**

```json
{
  "analysis": "Description of image content...",
  "mimeType": "image/jpeg"
}
```

#### `sql` - SQL Bridge

| Attribute    | Value         |
| ------------ | ------------- |
| **Function** | `db_query`    |
| **Default**  | Not installed |
| **Category** | Data          |

Read-only SQLite queries against workspace databases.

**Parameters:**

```json
{
  "query": { "type": "string", "description": "SQL SELECT statement" }
}
```

**Configuration:**

- Required: `sql-bridge.sqlite_db_path`

**Security:**

- Only `SELECT`, `WITH`, `PRAGMA`, `EXPLAIN` allowed
- Read-only database connection
- Max 200 result rows

### System

#### `filesystem` - File Gateway

| Attribute    | Value       |
| ------------ | ----------- |
| **Function** | `file_read` |
| **Default**  | Installed   |
| **Category** | System      |

Sandboxed file reading within workspace boundaries.

**Parameters:**

```json
{
  "path": { "type": "string", "description": "Relative path within workspace" }
}
```

**Allowed Paths:**

- Directories: `app/`, `components/`, `core/`, `docs/`, `lib/`, `messenger/`, `ops/`, `services/`, `skills/`, `src/`, `styles/`, `tests/`, `types/`
- Root files: `README.md`, `package.json`, `tsconfig.json`, etc.

**Limits:**

- Max file size: 256KB
- No directory traversal (path must stay within workspace)

---

## Handler System

### Handler Interface

All handlers implement a consistent async interface:

```typescript
type SkillHandler = (args: Record<string, unknown>) => Promise<unknown>;
```

### Handler Implementation Guide

#### 1. Basic Handler Structure

```typescript
// src/server/skills/handlers/myHandler.ts
export async function myHandler(args: Record<string, unknown>) {
  // 1. Validate and extract arguments
  const input = String(args.myParam || '').trim();
  if (!input) throw new Error('myHandler requires myParam.');

  // 2. Execute operation
  const result = await performOperation(input);

  // 3. Return structured result
  return {
    success: true,
    data: result,
    timestamp: new Date().toISOString(),
  };
}
```

#### 2. Adding to Registry

```typescript
// src/server/skills/executeSkill.ts
import { myHandler } from './handlers/myHandler';

const SKILL_HANDLERS: Record<string, SkillHandler> = {
  // ... existing handlers
  my_operation: myHandler,
};
```

#### 3. Creating a Skill Manifest

```typescript
// skills/my-skill/index.ts
import type { SkillManifest } from '@/shared/toolSchema';

const manifest: SkillManifest = {
  id: 'my-skill',
  name: 'My Skill',
  description: 'Description of what my skill does.',
  version: '1.0.0',
  category: 'Custom',
  functionName: 'my_operation',
  tool: {
    name: 'my_operation',
    description: 'Detailed description for the AI.',
    parameters: {
      type: 'object',
      properties: {
        myParam: {
          type: 'string',
          description: 'Description of parameter',
        },
      },
      required: ['myParam'],
    },
  },
};

export default manifest;
```

### Handler Patterns

#### File System Handler

```typescript
// Key pattern: Path sandboxing
function ensureWorkspacePath(userPath: string): string {
  const workspaceRoot = path.resolve('.');
  const resolved = path.resolve(workspaceRoot, userPath);
  if (!resolved.startsWith(workspaceRoot)) {
    throw new Error('Path escapes workspace root.');
  }
  return resolved;
}
```

#### Shell Handler

```typescript
// Key pattern: Command filtering
const blockedTokens = ['rm -rf', 'shutdown', 'mkfs', ...];
const hasBlockedToken = blockedTokens.some(t => command.includes(t));
if (hasBlockedToken) throw new Error('Command blocked by security policy.');
```

#### API Handler

```typescript
// Key pattern: Runtime config access
const token = getRuntimeConfigValue('github-manager.github_token');
const headers: Record<string, string> = {
  Accept: 'application/vnd.github+json',
};
if (token) headers.Authorization = `Bearer ${token}`;
```

---

## Runtime Configuration

### Configuration Resolution

```
┌─────────────────────────────────────────────────────────────┐
│              CONFIGURATION RESOLUTION FLOW                  │
└─────────────────────────────────────────────────────────────┘

  Request for config "vision.gemini_api_key"
              │
              ▼
    ┌─────────────────┐
    │  Check SQLite   │
    │  (user setting) │
    └────────┬────────┘
             │
      ┌──────┴──────┐
      │   Value?    │
      └──────┬──────┘
             │
    ┌────────┴────────┐
    │ Yes      │ No   │
    ▼          ▼       │
 Return    Check ENV   │
 Value     Variables   │
           (fallback)  │
              │        │
       ┌──────┴──────┐ │
       │   Value?    │ │
       └──────┬──────┘ │
              │        │
     ┌────────┴────────┐
     │ Yes      │ No   │
     ▼          ▼       │
  Return    Return     │
  Value     null       │
            (or error  │
             if req'd) │
```

### API Endpoints

| Method | Endpoint                     | Description                        |
| ------ | ---------------------------- | ---------------------------------- |
| GET    | `/api/skills/runtime-config` | List all config fields with status |
| PUT    | `/api/skills/runtime-config` | Set config value (id + value)      |
| DELETE | `/api/skills/runtime-config` | Clear config value                 |

### Response Format

```typescript
interface SkillRuntimeConfigStatus {
  id: string; // Field identifier
  skillId: string; // Associated skill
  label: string; // Display label
  description: string; // Help text
  kind: 'secret' | 'text'; // Value type
  required: boolean; // Is required
  envVars: string[]; // Fallback env vars
  configured: boolean; // Has effective value
  source: 'store' | 'env' | null; // Where value came from
  maskedValue: string | null; // Masked display value
  updatedAt: string | null; // Last update timestamp
}
```

---

## Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     SKILL EXECUTION FLOW                                │
└─────────────────────────────────────────────────────────────────────────┘

  User Request
       │
       ▼
┌──────────────┐
│  API Route   │  POST /api/skills/execute
│  app/api/    │  {
│  skills/     │    "name": "file_read",
│  execute/    │    "args": { "path": "README.md" }
│  route.ts    │  }
└──────┬───────┘
       │
       ▼
┌──────────────┐     ┌─────────────────┐
│   Auth Check │────▶│ resolveRequest  │
│              │     │ UserContext()   │
└──────┬───────┘     └─────────────────┘
       │
       ▼
┌──────────────┐
│ Arg Normal   │  normalizeSkillArgs()
│ -ization     │  (converts arrays/objects)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Dispatch   │  dispatchSkill(name, args)
│              │  ─────────────────────────
│  execute-    │  1. Lookup handler by name
│  Skill.ts    │  2. Validate handler exists
│              │  3. Execute handler
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Handler    │  fileReadHandler(args)
│              │  ─────────────────────
│  handlers/   │  1. Validate args.path
│  fileRead.ts │  2. Resolve workspace path
│              │  3. Read file content
│              │  4. Apply size limits
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Response   │  { ok: true, result: {...} }
│              │  or
│              │  { ok: false, error: "..." }
└──────────────┘
```

---

## Security Model

### Path Sandboxing

All filesystem operations are constrained to the workspace root:

```typescript
const WORKSPACE_ROOT = path.resolve('.');
const ALLOWED_TOP_LEVEL_DIRS = new Set(['app', 'components', 'core', 'docs' /* ... */]);

function ensureWorkspacePath(userPath: string): string {
  const resolved = path.resolve(WORKSPACE_ROOT, userPath);
  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    throw new Error('Path escapes workspace root.');
  }
  return resolved;
}
```

### Command Blocking

Shell execution blocks dangerous operations:

```typescript
const BLOCKED_TOKENS = [
  'rm -rf', // Recursive deletion
  'shutdown', // System shutdown
  'reboot', // System reboot
  'mkfs', // Filesystem formatting
  'powershell -enc', // Encoded commands
  'reg delete', // Registry modification
  'sc stop', // Service control
  'diskpart', // Disk partitioning
  'bcdedit', // Boot configuration
  'invoke-expression', // PowerShell IEX
  ':(){', // Fork bomb
  'dd if=', // Direct disk write
  'cipher /w', // Drive wiping
];
```

### SQL Restrictions

Database queries are strictly read-only:

```typescript
if (!/^(select|with|pragma|explain)\b/i.test(query)) {
  throw new Error('Only read-only SQL statements are allowed.');
}

// Database opened in readonly mode
const db = new BetterSqlite3(resolved, { readonly: true });
```

### Resource Limits

| Resource        | Limit | Rationale                           |
| --------------- | ----- | ----------------------------------- |
| Shell timeout   | 15s   | Prevent long-running processes      |
| Python timeout  | 20s   | Allow slightly more for computation |
| Output buffer   | 1MB   | Prevent memory exhaustion           |
| File read size  | 256KB | Limit large file transfers          |
| SQL result rows | 200   | Prevent result set explosion        |

### Authentication

All skill API endpoints require valid user context:

```typescript
const userContext = await resolveRequestUserContext();
if (!userContext) {
  return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
}
```

---

## ClawHub Integration

ClawHub extends the Skills System with a marketplace interface for discovering and managing external skills.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      CLAWHUB INTEGRATION                                │
└─────────────────────────────────────────────────────────────────────────┘

  ┌──────────────┐
  │   CLAWHUB    │
  │   CATALOG    │
  │  (external)  │
  └──────┬───────┘
         │ Search/Explore
         ▼
  ┌──────────────┐
  │  ClawHub API │  /api/clawhub/search
  │   Routes     │  /api/clawhub/explore
  └──────┬───────┘
         │
         ▼
  ┌──────────────┐      ┌──────────────┐
  │   Install    │─────▶│ Skill System │
  │   Skill      │      │   Install    │
  └──────────────┘      └──────┬───────┘
                               │
                               ▼
                        ┌──────────────┐
                        │  Installed   │
                        │   Skills     │
                        │   Registry   │
                        └──────────────┘
```

### ClawHub API Endpoints

| Method | Endpoint                 | Description                |
| ------ | ------------------------ | -------------------------- |
| GET    | `/api/clawhub/search`    | Search skill catalog       |
| GET    | `/api/clawhub/explore`   | Browse featured skills     |
| GET    | `/api/clawhub/installed` | List installed skills      |
| POST   | `/api/clawhub/install`   | Install from catalog       |
| POST   | `/api/clawhub/update`    | Update installed skills    |
| GET    | `/api/clawhub/prompt`    | Get ClawHub prompt block   |
| PATCH  | `/api/clawhub/[slug]`    | Toggle skill enabled state |
| DELETE | `/api/clawhub/[slug]`    | Uninstall skill            |

### Integration Points

1. **Skill Installation**: ClawHub uses the same `installFromSource()` function as direct API calls
2. **Status Sync**: Both systems read from the same `SkillRepository`
3. **Prompt Integration**: ClawHub provides prompt context about available skills

---

## API Reference

### Skills Management

#### List Skills

```http
GET /api/skills
```

**Response:**

```json
{
  "ok": true,
  "skills": [
    {
      "id": "filesystem",
      "name": "File Gateway",
      "description": "Sandboxed file access",
      "category": "System",
      "version": "0.9.8",
      "installed": true,
      "functionName": "file_read",
      "source": "built-in",
      "toolDefinition": { ... }
    }
  ]
}
```

#### Install Skill

```http
POST /api/skills
Content-Type: application/json

{
  "source": "github",
  "value": "owner/repository#branch"
}
```

**Sources:**

- `github`: GitHub repository URL
- `npm`: npm package name
- `manual`: Complete manifest object

#### Toggle Skill

```http
PATCH /api/skills/[id]
Content-Type: application/json

{
  "installed": true
}
```

#### Remove Skill

```http
DELETE /api/skills/[id]
```

**Note:** Returns 400 if attempting to remove built-in skills.

### Skill Execution

#### Execute Handler

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
  "ok": true,
  "result": {
    "path": "README.md",
    "content": "...",
    "truncated": false
  }
}
```

### Runtime Configuration

#### List Configuration

```http
GET /api/skills/runtime-config
```

**Response:**

```json
{
  "ok": true,
  "configs": [
    {
      "id": "vision.gemini_api_key",
      "skillId": "vision",
      "label": "Vision (Gemini) API Key",
      "kind": "secret",
      "required": true,
      "configured": true,
      "source": "store",
      "maskedValue": "***",
      "updatedAt": "2026-02-17T12:00:00Z"
    }
  ]
}
```

#### Set Configuration

```http
PUT /api/skills/runtime-config
Content-Type: application/json

{
  "id": "vision.gemini_api_key",
  "value": "your-api-key-here"
}
```

#### Clear Configuration

```http
DELETE /api/skills/runtime-config
Content-Type: application/json

{
  "id": "vision.gemini_api_key"
}
```

---

## Configuration

### Environment Variables

| Variable         | Description               | Default            |
| ---------------- | ------------------------- | ------------------ |
| `SKILLS_DB_PATH` | SQLite database file path | `.local/skills.db` |

### Skill-Specific Variables

These can be set as fallback when runtime config is not stored:

| Variable         | Skill          | Field                              |
| ---------------- | -------------- | ---------------------------------- |
| `GEMINI_API_KEY` | vision         | `vision.gemini_api_key`            |
| `API_KEY`        | vision         | `vision.gemini_api_key` (fallback) |
| `GITHUB_TOKEN`   | github-manager | `github-manager.github_token`      |
| `SQLITE_DB_PATH` | sql-bridge     | `sql-bridge.sqlite_db_path`        |

---

## Error Handling

### Error Types

| Error                                       | Cause                        | HTTP Status |
| ------------------------------------------- | ---------------------------- | ----------- |
| `Unauthorized`                              | Missing/invalid user context | 401         |
| `Unsupported skill: ${name}`                | Handler not found            | 400         |
| `Path escapes workspace root`               | Directory traversal attempt  | 500         |
| `Command blocked by security policy`        | Dangerous shell command      | 500         |
| `Only read-only SQL statements are allowed` | Write SQL attempted          | 500         |
| `Vision API key missing`                    | Required config not set      | 500         |
| `Skill "${id}" not found`                   | Invalid skill ID             | 404         |
| `Cannot remove built-in skills`             | Protected skill deletion     | 400         |

### Error Response Format

```json
{
  "ok": false,
  "error": "Detailed error message"
}
```

### Handler Error Handling

Handlers should catch errors and return structured responses:

```typescript
export async function myHandler(args: Record<string, unknown>) {
  try {
    const result = await operation();
    return { success: true, data: result };
  } catch (error) {
    // Log for debugging
    console.error('MyHandler error:', error);

    // Return user-friendly error
    throw new Error('Operation failed: ' + (error as Error).message);
  }
}
```

---

## Testing

### Unit Tests

```typescript
// tests/unit/skills/skills-registry.test.ts
describe('SkillRepository', () => {
  it('should seed built-in skills on first run', async () => {
    const repo = new SkillRepository(':memory:');
    repo.seedBuiltIns(BUILT_IN_SKILLS);

    const skills = repo.listSkills();
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.some((s) => s.id === 'filesystem')).toBe(true);
  });

  it('should toggle skill installed state', async () => {
    const repo = new SkillRepository(':memory:');
    repo.seedBuiltIns(BUILT_IN_SKILLS);

    repo.setInstalled('filesystem', false);
    const skill = repo.getSkill('filesystem');
    expect(skill?.installed).toBe(false);
  });
});
```

### Handler Tests

```typescript
// tests/unit/skills/fileRead.test.ts
describe('fileReadHandler', () => {
  it('should read allowed file', async () => {
    const result = await fileReadHandler({ path: 'package.json' });
    expect(result.content).toContain('name');
    expect(result.truncated).toBe(false);
  });

  it('should reject path traversal', async () => {
    await expect(fileReadHandler({ path: '../outside.txt' })).rejects.toThrow(
      'Path escapes workspace root',
    );
  });
});
```

### Integration Tests

```typescript
// tests/integration/skills/execution.test.ts
describe('Skill Execution API', () => {
  it('should execute python skill', async () => {
    const response = await fetch('/api/skills/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'python_execute',
        args: { code: 'print("hello")' },
      }),
    });

    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.result.stdout).toBe('hello\n');
  });
});
```

### Test Commands

```bash
# Run all skill tests
npm run test -- tests/unit/skills
npm run test -- tests/integration/skills

# Run specific test file
npm run test -- tests/skill-repository.test.ts

# Type checking
npm run typecheck

# Linting
npm run lint
```

---

## Related Documentation

- `docs/CLAWHUB_SYSTEM.md` - ClawHub marketplace integration
- `docs/API_REFERENCE.md` - General API documentation
- `docs/memory-architecture.md` - Memory system architecture
- `docs/WORKER_SYSTEM.md` - Background worker system
