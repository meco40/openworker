# Model Hub System

This document describes the complete Model Hub architecture, covering provider account management, pipeline dispatch with fallback strategies, model fetching, OAuth-based account linking, and secure credential storage.

## Overview

The Model Hub is a unified abstraction layer that enables seamless integration with multiple AI model providers. It provides **account persistence**, **intelligent pipeline dispatch** with automatic fallback, **unified model fetching**, and **secure OAuth authentication flows**.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          MODEL HUB SYSTEM                                   │
│              Unified AI Provider Management & Dispatch                      │
└─────────────────────────────────────────────────────────────────────────────┘

╔═══════════════════════════════════════════════════════════════════════════╗
║  CLIENT LAYER (API Routes)                                                ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  ║
║  │   GET/POST  │  │   DELETE    │  │    POST     │  │       GET       │  ║
║  │  /accounts  │  │/accounts/:id│  │/accounts/:id│  │ /accounts/:id/  │  ║
║  │             │  │             │  │    /test    │  │     models      │  ║
║  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └────────┬────────┘  ║
║         │                │                │                  │           ║
║  ┌──────┴──────┐  ┌──────┴──────┐  ┌──────┴──────┐  ┌────────┴────────┐  ║
║  │  List/Create│  │   Delete    │  │   Health    │  │  Fetch Models   │  ║
║  │   Accounts  │  │   Account   │  │    Check    │  │   for Account   │  ║
║  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────┘  ║
║                                                                           ║
║  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  ║
║  │    POST     │  │ GET/PUT/POST│  │     GET     │  │ GET  /oauth/*   │  ║
║  │  /gateway   │  │  /pipeline  │  │  /providers │  │  start/callback │  ║
║  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └────────┬────────┘  ║
║         │                │                │                  │           ║
║  ┌──────┴──────┐  ┌──────┴──────┐  ┌──────┴──────┐  ┌────────┴────────┐  ║
║  │   Unified   │  │  Pipeline   │  │   Provider  │  │  OAuth Flow     │  ║
║  │   Dispatch  │  │ Management  │  │   Catalog   │  │  (PKCE/S256)    │  ║
║  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────┘  ║
╚═══════════════════════════════════════════════════════════════════════════╝
                                    │
                                    ▼
╔═══════════════════════════════════════════════════════════════════════════╗
║  SERVICE LAYER (ModelHubService)                                          ║
╠═══════════════════════════════════════════════════════════════════════════╣
║                                                                           ║
║  ┌─────────────────────────────────────────────────────────────────────┐ ║
║  │                    ACCOUNT MANAGEMENT                               │ ║
║  │  • connectAccount()    → Create with encrypted credentials          │ ║
║  │  • listAccounts()      → List all configured accounts               │ ║
║  │  • getAccountById()    → Retrieve specific account                  │ ║
║  │  • deleteAccount()     → Remove account + pipeline entries          │ ║
║  │  • updateHealth()      → Store connectivity check results           │ ║
║  └─────────────────────────────────────────────────────────────────────┘ ║
║                                                                           ║
║  ┌─────────────────────────────────────────────────────────────────────┐ ║
║  │                    PIPELINE MANAGEMENT                              │ ║
║  │  • listPipeline()         → Get ordered model list for profile      │ ║
║  │  • addModelToPipeline()   → Add model with priority                 │ ║
║  │  • removeModelFromPipeline() → Remove model from pipeline           │ ║
║  │  • movePipelineModel()    → Reorder (up/down)                       │ ║
║  │  • replacePipeline()      → Bulk replace entire pipeline            │ ║
║  │  • updateModelStatus()    → active/rate-limited/offline             │ ║
║  └─────────────────────────────────────────────────────────────────────┘ ║
║                                                                           ║
║  ┌─────────────────────────────────────────────────────────────────────┐ ║
║  │              GATEWAY DISPATCH & FALLBACK                            │ ║
║  │                                                                     │ ║
║  │   ┌──────────────┐     ┌──────────────┐     ┌──────────────┐       │ ║
║  │   │ Direct Chat  │     │  With Model  │     │   Pipeline   │       │ ║
║  │   │  dispatch()  │────▶│   Override   │────▶│   Fallback   │       │ ║
║  │   │              │     │              │     │              │       │ ║
║  │   └──────────────┘     └──────────────┘     └──────────────┘       │ ║
║  │                                                        │            │ ║
║  │   ┌────────────────────────────────────────────────────┘            │ ║
║  │   │                                                                 │ ║
║  │   ▼                                                                 │ ║
║  │   ┌─────────────────────────────────────────────────────────────┐   │ ║
║  │   │              FALLBACK STRATEGY                              │   │ ║
║  │   │  1. Try modelOverride first (if specified)                  │   │ ║
║  │   │  2. If rate-limited → mark status, try next               │   │ ║
║  │   │  3. Try each active model in priority order               │   │ ║
║  │   │  4. Return aggregated error if all fail                   │   │ ║
║  │   └─────────────────────────────────────────────────────────────┘   │ ║
║  │                                                                     │ ║
║  │   dispatchWithFallback(profileId, request, { modelOverride? })      │ ║
║  │                                                                     │ ║
║  └─────────────────────────────────────────────────────────────────────┘ ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
                                    │
                                    ▼
╔═══════════════════════════════════════════════════════════════════════════╗
║  ADAPTER LAYER (Provider-Specific Implementations)                        ║
╠═══════════════════════════════════════════════════════════════════════════╣
║                                                                           ║
║  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐   ║
║  │  ProviderAdapter │  │  fetchModels()  │  │  testConnectivity()     │   ║
║  │    Interface     │  │                 │  │                         │   ║
║  │                  │  │  List available │  │  Verify credentials     │   ║
║  │  id: string      │  │  models from API│  │  with test request      │   ║
║  │                  │  │                 │  │                         │   ║
║  │  dispatchGateway │  │  → FetchedModel[]│  │  → ConnectivityResult   │   ║
║  │  (context, req)  │  │                 │  │                         │   ║
║  │                  │  │                 │  │                         │   ║
║  │  → GatewayResponse│  │                 │  │                         │   ║
║  └─────────────────┘  └─────────────────┘  └─────────────────────────┘   ║
║                                                                           ║
║  ┌─────────────────────────────────────────────────────────────────────┐ ║
║  │                     PROVIDER ADAPTERS (14 Total)                    │ ║
║  ├──────────────┬──────────────┬──────────────┬──────────────────────┤ ║
║  │   gemini     │   openai     │ openai-codex │     anthropic        │ ║
║  │   (Native)   │   (Native)   │   (OAuth)    │     (Native)         │ ║
║  ├──────────────┼──────────────┼──────────────┼──────────────────────┤ ║
║  │  openrouter  │    ollama    │   lmstudio   │        xai           │ ║
║  │(API Key/OAuth│   (Local)    │   (Local)    │      (Native)        │ ║
║  ├──────────────┼──────────────┼──────────────┼──────────────────────┤ ║
║  │   mistral    │   cohere     │     zai      │       kimi           │ ║
║  │   (Native)   │   (Native)   │(OpenAI-Comp) │   (OpenAI-Comp)      │ ║
║  ├──────────────┼──────────────┼──────────────┼──────────────────────┤ ║
║  │  bytedance   │github-copilot│              │                      │ ║
║  │(OpenAI-Comp) │  (OAuth)     │              │                      │ ║
║  └──────────────┴──────────────┴──────────────┴──────────────────────┘ ║
║                                                                           ║
║  ┌─────────────────────────────────────────────────────────────────────┐ ║
║  │              FALLBACK: OpenAI-Compatible Dispatch                   │ ║
║  │                                                                     │ ║
║  │  For providers without specific adapters:                           │ ║
║  │  • Uses /chat/completions endpoint                                  │ ║
║  │  • Standard message format                                          │ ║
║  │  • Bearer token authentication                                      │ ║
║  │  • Attachment handling (images → data URLs)                         │ ║
║  └─────────────────────────────────────────────────────────────────────┘ ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
                                    │
                                    ▼
╔═══════════════════════════════════════════════════════════════════════════╗
║  PERSISTENCE LAYER (SQLite)                                               ║
╠═══════════════════════════════════════════════════════════════════════════╣
║                                                                           ║
║  ┌─────────────────────────────────────────────────────────────────────┐ ║
║  │                 model_hub_accounts TABLE                            │ ║
║  │  • id, provider_id, label, auth_method                              │ ║
║  │  • encrypted_secret (AES-256-GCM)                                   │ ║
║  │  • encrypted_refresh_token (for OAuth)                              │ ║
║  │  • secret_masked (e.g., ********abcd)                               │ ║
║  │  • last_check_at, last_check_ok, last_check_message                 │ ║
║  └─────────────────────────────────────────────────────────────────────┘ ║
║                                                                           ║
║  ┌─────────────────────────────────────────────────────────────────────┐ ║
║  │                 model_hub_pipeline TABLE                            │ ║
║  │  • id, profile_id, account_id, provider_id, model_name              │ ║
║  │  • reasoning_effort (off/minimal/low/medium/high/xhigh)             │ ║
║  │  • priority (order in pipeline), status (active/rate-limited/offline)│ ║
║  │  • created_at, updated_at                                           │ ║
║  │  • Index: idx_pipeline_profile (profile_id, priority)               │ ║
║  └─────────────────────────────────────────────────────────────────────┘ ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
```

---

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [Architecture Components](#architecture-components)
3. [Provider Catalog](#provider-catalog)
4. [Account Management](#account-management)
5. [Pipeline Dispatch & Fallback](#pipeline-dispatch--fallback)
6. [OAuth Integration](#oauth-integration)
7. [Connectivity Testing](#connectivity-testing)
8. [Security & Encryption](#security--encryption)
9. [Adapter Pattern](#adapter-pattern)
10. [API Reference](#api-reference)
11. [Configuration](#configuration)
12. [Error Handling](#error-handling)
13. [Testing](#testing)

---

## Core Concepts

### Provider

A provider represents an AI model service (OpenAI, Anthropic, Gemini, etc.). Each provider has:

- **Authentication methods**: API key, OAuth, or none (for local providers)
- **Endpoint type**: Native API or OpenAI-compatible
- **Capabilities**: Chat, tools, vision, audio, embeddings, code pairing
- **Default models**: Pre-configured model identifiers

### Account

An account is a persisted credential set for a specific provider:

```typescript
interface ProviderAccountView {
  id: string; // UUID
  providerId: string; // e.g., 'openai', 'anthropic'
  label: string; // User-defined name
  authMethod: 'none' | 'api_key' | 'oauth';
  secretMasked: string; // e.g., "********abcd"
  hasRefreshToken: boolean; // For OAuth providers
  createdAt: string;
  updatedAt: string;
  lastCheckAt: string | null; // Last connectivity test
  lastCheckOk: boolean | null; // Health status
  lastCheckMessage?: string | null;
}
```

### Pipeline

A pipeline is an ordered list of models for a specific profile. The system tries each model in priority order until one succeeds:

```typescript
interface PipelineModelEntry {
  id: string;
  profileId: string; // e.g., 'p1' (default)
  accountId: string; // Reference to account
  providerId: string;
  modelName: string; // e.g., 'gpt-4.1'
  reasoningEffort?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  priority: number; // Lower = higher priority
  status: 'active' | 'rate-limited' | 'offline';
  createdAt: string;
  updatedAt: string;
}
```

### Reasoning Effort Mapping

Pipeline reasoning effort is mapped to provider-specific values:

| Pipeline Value | OpenAI Request Value | Description                   |
| -------------- | -------------------- | ----------------------------- |
| `off`          | `undefined`          | No reasoning effort specified |
| `minimal`      | `low`                | Minimal reasoning             |
| `low`          | `low`                | Low reasoning                 |
| `medium`       | `medium`             | Medium reasoning              |
| `high`         | `high`               | High reasoning                |
| `xhigh`        | `high`               | Maximum reasoning             |

---

## Architecture Components

### File Structure

```
src/server/model-hub/
├── index.ts                    # Public API exports
├── types.ts                    # Core type definitions
├── providerCatalog.ts          # Provider definitions (14 providers)
├── repository.ts               # Repository interfaces
├── service.ts                  # ModelHubService implementation
├── runtime.ts                  # Singleton management
├── gateway.ts                  # Unified dispatch logic
├── modelFetcher.ts             # Model listing abstraction
├── connectivity.ts             # Health check system
├── crypto.ts                   # AES-256-GCM encryption
├── oauth.ts                    # PKCE state management
├── codexAuth.ts               # OpenAI Codex token refresh
├── codexLocalCallbackBridge.ts # Local OAuth callback server
├── urlOrigin.ts               # URL/origin utilities
└── repositories/
    └── sqliteModelHubRepository.ts  # SQLite persistence

src/server/model-hub/Models/
├── index.ts                    # Adapter exports
├── types.ts                    # Adapter interfaces
├── registry.ts                 # Adapter registry (14 adapters)
├── shared/
│   ├── http.ts                # HTTP utilities with timeout
│   └── openaiCompatible.ts    # OpenAI-compatible dispatch
└── [provider]/
    └── index.ts               # Provider-specific adapter

app/api/model-hub/
├── accounts/route.ts                    # List/Create accounts
├── accounts/[accountId]/route.ts        # Delete account
├── accounts/[accountId]/models/route.ts # Fetch models
├── accounts/[accountId]/test/route.ts   # Test connectivity
├── accounts/test-all/route.ts           # Test all accounts
├── gateway/route.ts                     # Unified dispatch
├── pipeline/route.ts                    # Pipeline CRUD
├── providers/route.ts                   # Provider catalog
├── oauth/start/route.ts                 # OAuth initiation
└── oauth/callback/route.ts              # OAuth callback
```

### Component Responsibilities

| Component            | Responsibility                                            |
| -------------------- | --------------------------------------------------------- |
| `ModelHubService`    | Main business logic for accounts, pipeline, dispatch      |
| `ModelHubRepository` | Persistence abstraction (SQLite implementation)           |
| `ProviderAdapter`    | Provider-specific implementations for fetch/test/dispatch |
| `gateway.ts`         | Unified request dispatch with token usage tracking        |
| `crypto.ts`          | Secret encryption/decryption with AES-256-GCM             |
| `oauth.ts`           | PKCE code verifier/challenge, state signing               |

---

## Provider Catalog

The system supports 14 AI providers with varying authentication methods and capabilities:

### Provider Matrix

| Provider               | Auth           | Endpoint            | Capabilities                           | Default Models                                       |
| ---------------------- | -------------- | ------------------- | -------------------------------------- | ---------------------------------------------------- |
| **Google Gemini**      | API Key        | `gemini-native`     | chat, tools, vision, audio, embeddings | `gemini-2.5-flash`, `gemini-2.5-pro`                 |
| **OpenAI**             | API Key        | `openai-native`     | chat, tools, vision, audio, embeddings | `gpt-4.1`, `gpt-4.1-mini`, `o4-mini`                 |
| **OpenAI Codex**       | OAuth          | `openai-native`     | chat, tools, vision, audio             | `gpt-5.3-codex`, `gpt-5.2-codex`, `gpt-5.2`          |
| **Anthropic**          | API Key        | `anthropic-native`  | chat, tools, vision                    | `claude-sonnet-4-5`, `claude-3-7-sonnet-latest`      |
| **OpenRouter**         | API Key, OAuth | `openai-compatible` | chat, tools, vision                    | `openai/gpt-4.1-mini`, `anthropic/claude-3.7-sonnet` |
| **Ollama**             | None, API Key  | `openai-compatible` | chat, tools, vision, embeddings        | `llama3.2`, `qwen2.5-coder`                          |
| **LM Studio**          | None, API Key  | `openai-compatible` | chat, tools, vision                    | `qwen2.5-coder-7b-instruct`                          |
| **xAI**                | API Key        | `xai-native`        | chat, tools                            | `grok-4`, `grok-3`                                   |
| **Mistral**            | API Key        | `mistral-native`    | chat, tools, embeddings                | `mistral-large-latest`, `ministral-8b-latest`        |
| **Cohere**             | API Key        | `cohere-native`     | chat, tools, embeddings                | `command-a-03-2025`, `command-r-plus`                |
| **Z.AI**               | API Key        | `openai-compatible` | chat, tools, vision                    | `glm-4.5`, `glm-4.5-air`                             |
| **Kimi Code**          | API Key        | `openai-compatible` | chat, tools                            | `kimi-for-coding`                                    |
| **ByteDance ModelArk** | API Key        | `openai-compatible` | chat, tools                            | `doubao-1-5-lite-32k`, `doubao-1-5-pro-32k`          |
| **GitHub Copilot**     | OAuth, API Key | `github-native`     | chat, code_pairing                     | (dynamic)                                            |

### Endpoint Types

| Type                | Description                         | Providers                                            |
| ------------------- | ----------------------------------- | ---------------------------------------------------- |
| `gemini-native`     | Google GenAI SDK                    | Gemini                                               |
| `openai-native`     | OpenAI SDK / REST                   | OpenAI, OpenAI Codex                                 |
| `anthropic-native`  | Anthropic Messages API              | Anthropic                                            |
| `xai-native`        | xAI REST API                        | xAI                                                  |
| `mistral-native`    | Mistral AI API                      | Mistral                                              |
| `cohere-native`     | Cohere v2 API                       | Cohere                                               |
| `copilot-native`    | GitHub Copilot API                  | GitHub Copilot                                       |
| `github-native`     | GitHub REST API                     | GitHub Copilot                                       |
| `openai-compatible` | OpenAI-compatible /chat/completions | OpenRouter, Ollama, LM Studio, Z.AI, Kimi, ByteDance |

### Capability Definitions

| Capability     | Description                      |
| -------------- | -------------------------------- |
| `chat`         | Standard text chat completion    |
| `tools`        | Function calling / tool use      |
| `vision`       | Image input support              |
| `audio`        | Audio input/output support       |
| `embeddings`   | Text embedding generation        |
| `code_pairing` | Code-specific features (Copilot) |

---

## Account Management

### Creating an Account

```typescript
import { getModelHubService, getModelHubEncryptionKey } from '@/server/model-hub';

const service = getModelHubService();
const encryptionKey = getModelHubEncryptionKey();

const account = service.connectAccount({
  providerId: 'openai',
  label: 'Production OpenAI',
  authMethod: 'api_key',
  secret: 'sk-...',
  encryptionKey,
});
```

### Account with OAuth

```typescript
// OAuth accounts include refresh tokens
const account = service.connectAccount({
  providerId: 'openai-codex',
  label: 'My Codex Account',
  authMethod: 'oauth',
  secret: accessToken,
  refreshToken: refreshToken, // Optional, for token refresh
  encryptionKey,
});
```

### Listing Accounts

```typescript
const accounts = service.listAccounts();
// Returns: ProviderAccountView[]
```

### Deleting an Account

```typescript
const deleted = service.deleteAccount(accountId);
// Also removes associated pipeline entries
```

### Health Status Updates

```typescript
service.updateHealth(accountId, true, 'Connected successfully');
service.updateHealth(accountId, false, 'Invalid API key');
```

---

## Pipeline Dispatch & Fallback

### Direct Dispatch

Send a request to a specific account and model:

```typescript
const result = await service.dispatchChat(accountId, encryptionKey, {
  model: 'gpt-4.1',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello!' },
  ],
  max_tokens: 4096,
  temperature: 0.7,
});

if (result.ok) {
  console.log(result.text);
  console.log(result.usage); // Token usage info
} else {
  console.error(result.error);
}
```

### Pipeline Dispatch with Fallback

The system tries models in priority order until one succeeds:

```typescript
const result = await service.dispatchWithFallback(
  'p1',
  encryptionKey,
  {
    messages: [{ role: 'user', content: 'Explain quantum computing.' }],
    max_tokens: 2048,
  },
  {
    modelOverride: 'gpt-4.1', // Try this first
  },
);
```

### Fallback Strategy Flow

```
1. If modelOverride specified:
   a. Find override model in pipeline
   b. Try dispatch with override model
   c. If 429/rate-limit → mark as rate-limited, continue
   d. If other error → record error, continue
   e. If success → return result

2. For each active model in priority order:
   a. Check abort signal
   b. Get account credentials
   c. Try dispatch
   d. If 429/rate-limit → mark status, continue
   e. If success → return result

3. If all fail → return aggregated error
```

### Pipeline Model Status

| Status         | Meaning            | Behavior                      |
| -------------- | ------------------ | ----------------------------- |
| `active`       | Model is available | Included in fallback rotation |
| `rate-limited` | Hit rate limit     | Skipped until manually reset  |
| `offline`      | Known unavailable  | Skipped in fallback rotation  |

### Managing Pipeline

```typescript
// Add model to pipeline
const entry = service.addModelToPipeline({
  profileId: 'p1',
  accountId: 'acc-123',
  providerId: 'openai',
  modelName: 'gpt-4.1',
  reasoningEffort: 'medium',
  priority: 1,
});

// Remove model
service.removeModelFromPipeline(modelId);

// Update status
service.updateModelStatus(modelId, 'rate-limited');

// Reorder
service.movePipelineModel('p1', modelId, 'up'); // Increase priority
service.movePipelineModel('p1', modelId, 'down'); // Decrease priority

// Replace entire pipeline
service.replacePipeline('p1', [
  { profileId: 'p1', accountId: 'acc-1', providerId: 'openai', modelName: 'gpt-4.1', priority: 1 },
  {
    profileId: 'p1',
    accountId: 'acc-2',
    providerId: 'anthropic',
    modelName: 'claude-sonnet-4-5',
    priority: 2,
  },
]);
```

---

## OAuth Integration

The Model Hub supports OAuth 2.0 with PKCE (Proof Key for Code Exchange) for secure token exchange without client secrets.

### Supported OAuth Providers

| Provider       | PKCE | Refresh Tokens | Special Handling             |
| -------------- | ---- | -------------- | ---------------------------- |
| OpenRouter     | S256 | No             | Direct API key exchange      |
| GitHub Copilot | No   | Yes            | GitHub OAuth flow            |
| OpenAI Codex   | S256 | Yes            | Custom local callback bridge |

### OAuth Flow

```
┌─────────┐                                     ┌─────────────┐
│  Client │ ──(1) GET /oauth/start────────────▶ │   Server    │
│         │    ?providerId=xxx&label=xxx        │             │
└─────────┘                                     └──────┬──────┘
                                                       │
                                                       ▼
                                              ┌────────────────┐
                                              │  Create PKCE   │
                                              │  code_verifier │
                                              │  code_challenge│
                                              │  Signed state  │
                                              └───────┬────────┘
                                                      │
                       ┌──────────────────────────────┘
                       ▼
              ┌─────────────────┐
              │  Redirect to    │
              │  Provider Auth  │
              │  Endpoint       │
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │  User Authorizes │
              │  (Provider UI)   │
              └────────┬────────┘
                       │
                       ▼
┌─────────┐   ┌─────────────────┐
│  Client │ ◀──(2) Callback────│
│         │    ?code=xxx&state= │
└────┬────┘    └───────────────┘
     │
     │ (3) Server exchanges code
     │     for access token
     ▼
┌────────────────────────────────────────┐
│ POST provider token endpoint           │
│ • code                                 │
│ • code_verifier (PKCE)                 │
│ • client_id                            │
│ • redirect_uri                         │
└────────────────────────────────────────┘
     │
     ▼
┌────────────────────────────────────────┐
│ Create account with:                   │
│ • access_token → encrypted_secret      │
│ • refresh_token → encrypted_refresh_token│
│ • authMethod = 'oauth'                 │
└────────────────────────────────────────┘
```

### PKCE Implementation

```typescript
import { createPkcePair, createOAuthState, parseOAuthState } from '@/server/model-hub/oauth';

// Initiation
const { codeVerifier, codeChallenge } = createPkcePair();
const state = createOAuthState(
  {
    providerId: 'openrouter',
    label: 'My Account',
    createdAt: Date.now(),
    nonce: createOAuthNonce(),
    codeVerifier, // Stored in signed state
  },
  signingKey,
);

// Callback validation
const payload = parseOAuthState(stateParam, signingKey);
// Verifies signature, checks expiration (10 min), extracts codeVerifier
```

### Token Refresh (OpenAI Codex)

OAuth tokens can expire. The system automatically refreshes OpenAI Codex tokens when needed:

```typescript
// In getUsableAccountById()
if (account.providerId === 'openai-codex' && account.authMethod === 'oauth') {
  if (isJwtExpiringSoon(accessToken)) {
    const refreshed = await refreshOpenAICodexToken(refreshToken);
    // Update stored credentials
    repository.updateAccountCredentials({
      id: account.id,
      encryptedSecret: encryptSecret(refreshed.accessToken, encryptionKey),
      encryptedRefreshToken: encryptSecret(refreshed.refreshToken, encryptionKey),
      secretMasked: maskSecret(refreshed.accessToken),
    });
  }
}
```

---

## Connectivity Testing

### Per-Account Testing

```typescript
import { testProviderAccountConnectivity } from '@/server/model-hub';

const result = await testProviderAccountConnectivity(account, encryptionKey, {
  model: 'gpt-4.1', // Optional: specific model to test
});

// result: { ok: boolean, message: string }
```

### Test Strategy by Provider

| Provider Type     | Test Method                                               |
| ----------------- | --------------------------------------------------------- |
| Native adapters   | Provider-specific test (e.g., generateContent for Gemini) |
| OpenAI-compatible | GET /models endpoint with authentication                  |
| Custom adapters   | Adapter-defined testConnectivity() method                 |

### Health Check Storage

Results are stored in the account record:

```typescript
interface ProviderAccountView {
  lastCheckAt: string | null; // ISO timestamp
  lastCheckOk: boolean | null; // Pass/fail
  lastCheckMessage?: string | null; // Error details
}
```

---

## Security & Encryption

### Encryption Algorithm

All secrets are encrypted using **AES-256-GCM**:

```typescript
interface EncryptedSecretPayload {
  alg: 'aes-256-gcm';
  keyId: string; // For key rotation support
  iv: string; // Base64-encoded initialization vector (12 bytes)
  ciphertext: string; // Base64-encoded encrypted data
  tag: string; // Base64-encoded authentication tag (16 bytes)
}
```

### Key Requirements

```typescript
function normalizeKey(input: string): Buffer {
  // Accepts either:
  // 1. 64 hex characters (32 bytes)
  // 2. 32 UTF-8 bytes

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  const bytes = Buffer.from(trimmed, 'utf8');
  if (bytes.length !== 32) {
    throw new Error('Encryption key must be 32 UTF-8 bytes or 64 hex chars.');
  }
  return bytes;
}
```

### Secret Masking

For display purposes, secrets are masked:

```typescript
function maskSecret(secret: string): string {
  const tail = secret.slice(-4);
  const stars = '*'.repeat(Math.max(8, secret.length - 4));
  return `${stars}${tail}`; // e.g., "********abcd"
}
```

### Development Fallback

In non-production environments, a development key is used if no environment variable is set:

```typescript
const DEV_FALLBACK_KEY = '0123456789abcdef0123456789abcdef';

export function getModelHubEncryptionKey(): string {
  const key = process.env.MODEL_HUB_ENCRYPTION_KEY?.trim();
  if (key && key.length > 0) return key;

  if (process.env.NODE_ENV !== 'production') {
    return DEV_FALLBACK_KEY; // 32 bytes
  }

  throw new Error('Missing MODEL_HUB_ENCRYPTION_KEY');
}
```

### OAuth State Security

OAuth state parameters are signed with HMAC-SHA256 to prevent CSRF attacks:

```typescript
function signState(serializedPayload: string, signingKey: string): string {
  return toBase64Url(crypto.createHmac('sha256', signingKey).update(serializedPayload).digest());
}

// State format: {base64url(payload)}.{base64url(signature)}
// Expires after 10 minutes
```

---

## Adapter Pattern

### ProviderAdapter Interface

```typescript
interface ProviderAdapter {
  id: string;

  // Optional: Fetch available models
  fetchModels?: (context: ProviderExecutionContext) => Promise<FetchedModel[]>;

  // Optional: Test account connectivity
  testConnectivity?: (
    context: ProviderExecutionContext,
    options?: { model?: string },
  ) => Promise<ConnectivityResult>;

  // Optional: Custom dispatch implementation
  dispatchGateway?: (
    context: ProviderExecutionContext,
    request: GatewayRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<GatewayResponse>;
}

interface ProviderExecutionContext {
  provider: ProviderCatalogEntry;
  account: ProviderAccountRecord;
  secret: string; // Decrypted secret
}
```

### Adapter Registry

```typescript
// registry.ts
const providerAdapters: Record<string, ProviderAdapter> = {
  gemini: geminiProviderAdapter,
  openai: openAIProviderAdapter,
  'openai-codex': openAICodexProviderAdapter,
  anthropic: anthropicProviderAdapter,
  openrouter: openRouterProviderAdapter,
  ollama: ollamaProviderAdapter,
  lmstudio: lmStudioProviderAdapter,
  xai: xAIProviderAdapter,
  mistral: mistralProviderAdapter,
  cohere: cohereProviderAdapter,
  kimi: kimiProviderAdapter,
  zai: zaiProviderAdapter,
  bytedance: bytedanceProviderAdapter,
  'github-copilot': githubProviderAdapter,
};

export function getProviderAdapter(providerId: string): ProviderAdapter | null {
  return providerAdapters[providerId] ?? null;
}
```

### OpenAI-Compatible Fallback

Providers without specific adapters use the OpenAI-compatible fallback:

```typescript
// In gateway.ts
const adapter = getProviderAdapter(provider.id);

if (adapter?.dispatchGateway) {
  // Use provider-specific implementation
  result = await adapter.dispatchGateway(context, request, options);
} else if (provider.apiBaseUrl) {
  // Fallback to OpenAI-compatible dispatch
  result = await dispatchOpenAICompatibleChat(
    provider.apiBaseUrl,
    secret,
    provider.id,
    request,
    options,
  );
}
```

### Adapter Implementation Example (Gemini)

```typescript
const geminiProviderAdapter: ProviderAdapter = {
  id: 'gemini',

  async fetchModels({ secret }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${secret}`;
    const response = await fetch(url);
    const data = await response.json();
    return data.models
      .filter((m) => m.name.startsWith('models/gemini'))
      .map((m) => ({
        id: m.name.replace('models/', ''),
        name: m.displayName || m.name,
        provider: 'gemini',
        context_window: m.inputTokenLimit,
      }));
  },

  async testConnectivity({ provider, secret }, options) {
    const ai = new GoogleGenAI({ apiKey: secret });
    const result = await ai.models.generateContent({
      model: options.model || provider.defaultModels[0],
      contents: 'Ping',
    });
    return {
      ok: Boolean(result?.text),
      message: result?.text ? 'Connected' : 'No response',
    };
  },

  async dispatchGateway({ secret }, request, options) {
    const ai = new GoogleGenAI({ apiKey: secret });

    // Convert messages to Gemini format
    const contents = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    // Handle abort signal
    const generatePromise = ai.models.generateContent({
      model: request.model,
      contents,
      config: {
        maxOutputTokens: request.max_tokens,
        temperature: request.temperature,
        systemInstruction: request.systemInstruction,
      },
    });

    // Race with abort signal
    const result = options?.signal
      ? await Promise.race([generatePromise, abortPromise])
      : await generatePromise;

    return {
      ok: true,
      text: result.text,
      model: request.model,
      provider: 'gemini',
      usage: {
        prompt_tokens: result.usageMetadata?.promptTokenCount ?? 0,
        completion_tokens: result.usageMetadata?.candidatesTokenCount ?? 0,
        total_tokens: result.usageMetadata?.totalTokenCount ?? 0,
      },
    };
  },
};
```

---

## API Reference

### REST Endpoints

#### Accounts

| Method   | Endpoint                              | Description               |
| -------- | ------------------------------------- | ------------------------- |
| `GET`    | `/api/model-hub/accounts`             | List all accounts         |
| `POST`   | `/api/model-hub/accounts`             | Create new account        |
| `DELETE` | `/api/model-hub/accounts/[id]`        | Delete account            |
| `GET`    | `/api/model-hub/accounts/[id]/models` | Fetch models for account  |
| `POST`   | `/api/model-hub/accounts/[id]/test`   | Test account connectivity |
| `POST`   | `/api/model-hub/accounts/test-all`    | Test all accounts         |

#### Gateway

| Method | Endpoint                 | Description                           |
| ------ | ------------------------ | ------------------------------------- |
| `POST` | `/api/model-hub/gateway` | Unified dispatch (direct or pipeline) |

**Request Body (Direct):**

```json
{
  "accountId": "acc-123",
  "model": "gpt-4.1",
  "messages": [{ "role": "user", "content": "Hello" }],
  "max_tokens": 4096,
  "temperature": 0.7,
  "reasoning_effort": "medium"
}
```

**Request Body (Pipeline):**

```json
{
  "profileId": "p1",
  "messages": [{ "role": "user", "content": "Hello" }],
  "max_tokens": 4096
}
```

**Request Body (Embeddings):**

```json
{
  "operation": "embedContent",
  "payload": { "model": "models/gemini-embedding-exp", "content": "text to embed" }
}
```

#### Pipeline

| Method | Endpoint                               | Description               |
| ------ | -------------------------------------- | ------------------------- |
| `GET`  | `/api/model-hub/pipeline?profileId=p1` | Get pipeline for profile  |
| `PUT`  | `/api/model-hub/pipeline`              | Replace entire pipeline   |
| `POST` | `/api/model-hub/pipeline`              | Add/remove/update/reorder |

**POST Actions:**

- `action: 'add'` - Add model to pipeline
- `action: 'remove'` - Remove model from pipeline
- `action: 'status'` - Update model status
- `action: 'reorder'` - Move model up/down

#### Providers

| Method | Endpoint                   | Description          |
| ------ | -------------------------- | -------------------- |
| `GET`  | `/api/model-hub/providers` | Get provider catalog |

#### OAuth

| Method | Endpoint                                              | Description                              |
| ------ | ----------------------------------------------------- | ---------------------------------------- |
| `GET`  | `/api/model-hub/oauth/start?providerId=xxx&label=xxx` | Start OAuth flow                         |
| `GET`  | `/api/model-hub/oauth/callback`                       | OAuth callback (provider redirects here) |

### TypeScript Interfaces

#### GatewayRequest

```typescript
interface GatewayRequest {
  model: string;
  messages: GatewayMessage[];
  max_tokens?: number;
  temperature?: number;
  reasoning_effort?: 'low' | 'medium' | 'high';
  stream?: boolean;
  systemInstruction?: string;
  tools?: unknown[];
  responseMimeType?: string;
  auditContext?: GatewayAuditContext;
}

interface GatewayMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  attachments?: GatewayMessageAttachment[];
}

interface GatewayMessageAttachment {
  name: string;
  mimeType: string;
  size: number;
  storagePath: string;
  sha256?: string;
}
```

#### GatewayResponse

```typescript
interface GatewayResponse {
  ok: boolean;
  text: string;
  model: string;
  provider: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  functionCalls?: Array<{ name: string; args?: unknown }>;
  error?: string;
}
```

---

## Configuration

### Environment Variables

#### Required

| Variable                   | Description                      | Example                            |
| -------------------------- | -------------------------------- | ---------------------------------- |
| `MODEL_HUB_ENCRYPTION_KEY` | 32-byte or 64-hex encryption key | `0123456789abcdef0123456789abcdef` |

#### Provider API Keys (Optional)

Individual API keys can be configured via environment variables, though the Model Hub primarily uses stored account secrets:

| Variable             | Provider       |
| -------------------- | -------------- |
| `OPENAI_API_KEY`     | OpenAI         |
| `ANTHROPIC_API_KEY`  | Anthropic      |
| `GEMINI_API_KEY`     | Gemini         |
| `OPENROUTER_API_KEY` | OpenRouter     |
| `XAI_API_KEY`        | xAI            |
| `MISTRAL_API_KEY`    | Mistral        |
| `COHERE_API_KEY`     | Cohere         |
| `GITHUB_TOKEN`       | GitHub Copilot |

#### OAuth Configuration

| Variable                     | Provider     | Purpose                     |
| ---------------------------- | ------------ | --------------------------- |
| `GITHUB_OAUTH_CLIENT_ID`     | GitHub       | OAuth client ID             |
| `GITHUB_OAUTH_CLIENT_SECRET` | GitHub       | OAuth client secret         |
| `OPENAI_OAUTH_CLIENT_ID`     | OpenAI Codex | Custom client ID (optional) |
| `OPENAI_OAUTH_CLIENT_SECRET` | OpenAI Codex | Client secret               |
| `OPENAI_OAUTH_REDIRECT_URI`  | OpenAI Codex | Custom redirect URI         |
| `OPENAI_OAUTH_SCOPE`         | OpenAI Codex | OAuth scope                 |
| `OPENAI_OAUTH_AUDIENCE`      | OpenAI Codex | Token audience              |

#### Database

| Variable            | Description          | Default               |
| ------------------- | -------------------- | --------------------- |
| `MODEL_HUB_DB_PATH` | SQLite database path | `.local/model-hub.db` |

---

## Error Handling

### Error Categories

| Error Type           | Cause                        | Handling                                   |
| -------------------- | ---------------------------- | ------------------------------------------ |
| `AccountNotFound`    | Invalid account ID           | Returns 404 or includes in fallback errors |
| `InvalidCredentials` | API key rejected             | Mark account as failed, try fallback       |
| `RateLimited`        | 429 response                 | Mark model as rate-limited, try next       |
| `NetworkError`       | Connection failure           | Include in fallback errors                 |
| `Timeout`            | Request exceeded timeout     | Abort and try next                         |
| `ProviderError`      | Unexpected provider response | Log and try fallback                       |

### Fallback Error Aggregation

When all models fail, errors are aggregated:

```typescript
return {
  ok: false,
  text: '',
  model: '',
  provider: '',
  error: `All models failed: ${errors.join(' | ')}`,
  // e.g., "gpt-4.1@openai: Rate limited | claude-sonnet-4-5@anthropic: Timeout"
};
```

### Abort Signal Handling

All dispatch operations support AbortController for cancellation:

```typescript
const controller = new AbortController();
const result = await service.dispatchWithFallback('p1', encryptionKey, request, {
  signal: controller.signal,
});

// Cancel after 30 seconds
setTimeout(() => controller.abort(), 30000);
```

---

## Testing

### Unit Tests

```bash
npm run test -- tests/unit/model-hub
```

### Integration Tests

```bash
npm run test -- tests/integration/model-hub
```

### Type Checking

```bash
npm run typecheck
```

### Linting

```bash
npm run lint
```

### Manual Testing

Test connectivity for all accounts:

```bash
curl -X POST http://localhost:3000/api/model-hub/accounts/test-all
```

Test specific account:

```bash
curl -X POST http://localhost:3000/api/model-hub/accounts/acc-123/test \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4.1"}'
```

Gateway dispatch test:

```bash
curl -X POST http://localhost:3000/api/model-hub/gateway \
  -H "Content-Type: application/json" \
  -d '{
    "profileId": "p1",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100
  }'
```

---

## See Also

- `docs/architecture/model-hub-provider-matrix.md` - Detailed provider capability matrix
- `docs/API_REFERENCE.md` - General API documentation
- `docs/CORE_HANDBOOK.md` - Core system documentation
