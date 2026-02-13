# Target Architecture

## Objective

Move from mixed UI/domain/infrastructure code to a modular architecture with clear boundaries.

## Layer Layout

```txt
app/                      # Next.js app router entry points and route wiring
src/modules/*             # Feature modules (UI + feature services/hooks/types)
src/server/*              # Server-only use-cases and provider handlers
src/shared/*              # Shared utilities, config, and global types
tests/{unit,integration,contract}
```

## Rules

1. UI components do not execute infrastructure concerns directly.
2. API routes only parse input and map output.
3. Business logic is extracted into service/use-case functions.
4. `src/shared` can be consumed by all layers, but does not depend on feature modules.
5. New files avoid `any`-first APIs and must compile under strict TypeScript.

## Current Refactor Outcomes

- `App.tsx` state bootstrapping was extracted into `src/modules/app-shell`.
- Chat orchestration helpers moved to `src/modules/chat/services`.
- Worker task orchestration helpers moved to `src/modules/worker/services` and hook controller.
- `/api/skills/execute` delegates to `src/server/skills/executeSkill`.
- `/api/channels/pair` delegates to `src/server/channels/pairing`.
- Placeholder feature views route through `src/modules/{telemetry,tasks,config,exposure}`.
