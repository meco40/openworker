# Model Hub Provider Modularization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split provider-specific Model Hub logic into modular provider folders under `src/server/model-hub/Models` without behavior regressions.

**Architecture:** Introduce a provider adapter registry where each provider owns its own model-fetching, connectivity, and gateway logic. Keep `modelFetcher.ts`, `connectivity.ts`, and `gateway.ts` as orchestration entry points delegating into adapter modules with existing fallback behavior.

**Tech Stack:** TypeScript, Node fetch API, Vitest, existing Model Hub service/repository layers.

---

### Task 1: Baseline Safety Checks

**Files:**

- Verify: `tests/unit/model-hub/connectivity.test.ts`
- Verify: `tests/integration/model-hub/*.test.ts`

**Step 1: Run focused baseline tests**

Run: `npm run test -- tests/unit/model-hub/connectivity.test.ts`
Expected: PASS

**Step 2: Capture baseline architecture snapshot**

Run: `rg -n "switch \(provider\.id\)|if \(provider\.id" src/server/model-hub/*.ts`
Expected: Centralized provider branching found in fetcher/connectivity/gateway.

### Task 2: Add Provider Adapter Foundation

**Files:**

- Create: `src/server/model-hub/Models/types.ts`
- Create: `src/server/model-hub/Models/shared/http.ts`
- Create: `src/server/model-hub/Models/shared/openaiCompatible.ts`

**Step 1: Define adapter interfaces and context contracts**

Add typed interfaces for optional operations: `fetchModels`, `testConnectivity`, `dispatchGateway`.

**Step 2: Add shared HTTP helpers**

Extract timeout fetch and error parsing helpers reused across providers.

**Step 3: Add OpenAI-compatible reusable adapters**

Implement reusable helpers for OpenAI-compatible model listing, connectivity checks, and chat dispatch.

### Task 3: Provider Module Split

**Files:**

- Create: `src/server/model-hub/Models/<provider>/index.ts` for all current providers
- Create: `src/server/model-hub/Models/registry.ts`
- Create: `src/server/model-hub/Models/index.ts`

**Step 1: Implement provider folders**

Add per-provider modules: `gemini`, `openai`, `anthropic`, `openrouter`, `xai`, `mistral`, `cohere`, `kimi`, `zai`, `bytedance`, `github-copilot`.

**Step 2: Centralize provider lookup via registry**

Expose helper to resolve adapter by provider id and keep fallback for unknown providers.

### Task 4: Refactor Existing Entry Points

**Files:**

- Modify: `src/server/model-hub/modelFetcher.ts`
- Modify: `src/server/model-hub/connectivity.ts`
- Modify: `src/server/model-hub/gateway.ts`

**Step 1: Delegate model fetching into registry adapters**

Keep decryption and default-model fallback logic in entrypoint.

**Step 2: Delegate connectivity checks into registry adapters**

Keep decryption, unknown provider handling, and default endpoint fallback.

**Step 3: Delegate gateway dispatch into registry adapters**

Keep decryption, unknown provider handling, and openai-compatible generic fallback logic.

### Task 5: Test Coverage for Modularization

**Files:**

- Create: `tests/unit/model-hub/provider-registry.test.ts`
- Modify: `tests/unit/model-hub/connectivity.test.ts`

**Step 1: Add registry completeness test**

Verify each provider in catalog has an adapter and key capabilities are wired.

**Step 2: Keep existing connectivity tests green**

Ensure previous endpoint assertions still pass with modular architecture.

### Task 6: Verification and Backup Comparison

**Files:**

- Compare: `backups/2026-02-10-model-hub-pre-refactor/src/server/model-hub/*`
- Compare: `src/server/model-hub/*`

**Step 1: Run model-hub test suite**

Run: `npm run test -- tests/unit/model-hub/connectivity.test.ts tests/unit/model-hub/provider-registry.test.ts tests/integration/model-hub/providers-route.test.ts tests/integration/model-hub/account-test-route.test.ts`
Expected: PASS

**Step 2: Compare pre/post structures for omissions**

Run: `git diff -- src/server/model-hub`
Expected: Provider behavior preserved, logic relocated into modules.

**Step 3: Final sanity checks**

Run: `npm run test -- tests/integration/model-hub`
Expected: PASS
