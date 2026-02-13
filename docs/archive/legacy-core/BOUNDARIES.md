# Architecture Boundaries

## Layer Rules

1. UI components must not contain infrastructure logic (`fetch`, SQL, shell execution).
2. API routes only map request/response and delegate business logic.
3. Every business operation must be implemented as a dedicated service/use-case.
4. `shared` can be imported by `modules`, but `shared` must not import from `modules`.
5. New files must use strict typing and avoid `any`-based APIs.

## Dependency Direction

- `src/app` -> `src/modules`, `src/server`, `src/shared`
- `src/modules` -> `src/shared`
- `src/server` -> `src/shared`
- `src/shared` -> no app/module/server imports
