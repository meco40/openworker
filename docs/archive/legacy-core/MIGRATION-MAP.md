# Migration Map

## Scope

This map tracks where key responsibilities moved during the architecture refactor.

## UI and State

- `app/page.tsx` -> now renders `src/modules/app-shell/AppShell`.
- `App.tsx` shell defaults -> `src/modules/app-shell/useAppShellState.ts`.
- Chat message creation -> `src/modules/chat/services/routeMessage.ts`.
- Agent placeholder creation -> `src/modules/chat/services/handleAgentResponse.ts`.
- Worker plan normalization/execution prompt building -> `src/modules/worker/services/executeTaskPlan.ts`.

## API and Server Use-Cases

- `app/api/skills/execute/route.ts` business logic -> `src/server/skills/handlers/*` and `src/server/skills/executeSkill.ts`.
- `app/api/channels/pair/route.ts` provider logic -> `src/server/channels/pairing/{telegram,discord,bridge}.ts`.

## Feature Slice Entrypoints

- `components/LogsView.tsx` -> `src/modules/telemetry/components/LogsView.tsx`.
- `components/TaskManagerView.tsx` -> `src/modules/tasks/components/TaskManagerView.tsx`.
- `components/ConfigEditor.tsx` -> `src/modules/config/components/ConfigEditor.tsx`.
- `components/ExposureManager.tsx` -> `src/modules/exposure/components/ExposureManager.tsx`.

## Quality Gates Introduced

- `typecheck` script in `package.json`.
- `strict: true` in `tsconfig.json`.
- Contract and smoke tests:
  - `tests/integration/app-smoke.test.ts`
  - `tests/unit/shared/ids.test.ts`
  - `tests/unit/app-shell/state.test.ts`
  - `tests/unit/chat/route-message.test.ts`
  - `tests/unit/worker/execute-plan.test.ts`
  - `tests/integration/skills/execute-router.test.ts`
  - `tests/integration/channels/pairing-router.test.ts`
  - `tests/unit/types/strictness-smoke.test.ts`
  - `tests/unit/modules/rendering-smoke.test.ts`
  - `tests/contract/public-api.contract.test.ts`
