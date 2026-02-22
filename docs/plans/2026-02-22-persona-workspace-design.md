# Persona Workspace Design

Date: 2026-02-22
Status: Approved (Design)

## Goal

Introduce a professional, persona-scoped filesystem layout under `.local/personas/<name-slug>/...` so that each persona has an isolated workspace for uploads and future artifacts.

## Agreed Decisions

1. Base path is `.local/personas/<name-slug>/...`.
2. Slug is based on persona name, for example `Nata Girl` -> `nata_girl`.
3. Slug must be globally unique. Creating a second persona with the same slug is rejected.
4. On persona rename, workspace folder is renamed to the new slug.
5. Default workspace structure is created for each persona.
6. Existing uploads are auto-migrated from `.local/uploads/chat/...` on first startup.

## Default Workspace Structure

For each persona:

- `.local/personas/<slug>/uploads/`
- `.local/personas/<slug>/uploads/images/`
- `.local/personas/<slug>/uploads/docs/`
- `.local/personas/<slug>/knowledge/`
- `.local/personas/<slug>/memory/`
- `.local/personas/<slug>/logs/`
- `.local/personas/<slug>/exports/`
- `.local/personas/<slug>/tmp/`
- `.local/personas/<slug>/config/`

## Architecture

### New Workspace Utility

Create a dedicated module (for example `src/server/personas/personaWorkspace.ts`) with:

- `slugifyPersonaName(name: string): string`
- `assertUniquePersonaSlug(slug: string): void`
- `ensurePersonaWorkspace(slug: string): void`
- safe path-resolver helpers limited to `.local/personas`
- rename helper for slug changes

### Persona Lifecycle Integration

- Persona create:
  - compute slug
  - validate uniqueness
  - create workspace folder tree
- Persona update (name change):
  - compute new slug
  - validate uniqueness
  - rename folder atomically if slug changed
  - update persisted workspace path metadata if required

### Attachment Routing

Update attachment persistence routing so chat uploads for a persona are stored under:

- image attachments -> `uploads/images/`
- document and text attachments -> `uploads/docs/`

Non-persona chat handling is defined as fallback routing to legacy storage:

- keep compatibility bucket at `.local/uploads/chat/...` for non-persona flows
- route persona-scoped uploads to `.local/personas/<slug>/uploads/...`

## Migration Plan

### Trigger

Run once at startup via bootstrap hook.
Use a marker file `.local/personas/.migration-v1.done` to guarantee idempotency.

### Source and Target

- Source: `.local/uploads/chat/...`
- Target: `.local/personas/<slug>/uploads/...`

### Steps

1. Ensure workspace folders exist for all personas.
2. Scan legacy attachments.
3. Resolve persona assignment via conversation and persona linkage.
4. Move file to persona target subfolder (`images` or `docs`).
5. Update message metadata `storagePath` references.
6. Write migration completion marker, for example `.local/personas/.migration-v1.done`.

### Migration Properties

- idempotent (safe to re-run)
- bounded sequential processing with skip-and-log behavior; no full in-memory preload
- robust skip-and-log behavior for missing or orphaned files

## Error Handling and Safety

- strict path traversal protection (writes only under `.local/personas`)
- rename and move operations must fail fast with clear API errors
- update metadata only after successful file move
- preserve recoverability with detailed logs and optional dry-run mode

## Testing Strategy

### Unit Tests

- slug generation
- uniqueness checks
- workspace folder scaffold creation
- path normalization and root guards

### Integration Tests

- persona create initializes workspace
- persona rename renames workspace folder
- attachment upload lands in correct persona subfolder
- migration moves files and updates metadata paths

### Failure and Regression Tests

- duplicate slug rejection
- filesystem permission and I/O failures
- already-migrated runs do not duplicate work
- existing chat and attachment flows remain green

## Rollout Plan

1. Implement with feature-safe defaults.
2. Run migration in development and staging with reporting.
3. Deploy and run one-time auto-migration in production.
4. Keep legacy path readable during transition window.
5. Mark `.local/uploads/chat` as deprecated after verification.

## Production Readiness Additions

- enforce global unique slug at DB level (unique index) plus API-level 409 conflicts
- reject empty rename targets for persona names
- preserve backward compatibility for existing metadata and non-persona channels
- keep migration fail-safe: runtime logs warning and continues serving traffic

## Out of Scope

- full archival lifecycle policy for persona workspaces
- UI file manager for persona folders
- cross-persona shared asset libraries
