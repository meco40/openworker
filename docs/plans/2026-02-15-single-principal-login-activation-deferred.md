# Deferred Plan: Single-Principal Login Activation

## Status

Deferred. Not part of current implementation.

## Current Runtime Contract

- Single-principal architecture only.
- `user_id` security scoping remains mandatory.
- `REQUIRE_AUTH` behavior remains available and unchanged.
- Login activation is intentionally postponed.

## Future Activation Checklist

1. Enable login enforcement in staged environments first.
2. Enforce principal-only session identity:
   - only one allowed principal id
   - reject any non-principal authenticated id
3. Keep 401 behavior on missing/invalid session when auth is required.
4. Verify REST and WS identity behavior remains aligned.

## Data Migration Plan (Future)

1. Snapshot all rows currently scoped to `legacy-local-user`.
2. Backfill/transform to final principal id in a reversible migration script.
3. Verify counts by table before/after migration.
4. Keep rollback SQL/script ready before production execution.

## Rollback Strategy

1. Disable mandatory auth enforcement.
2. Restore principal fallback runtime behavior.
3. Revert id migration using pre-migration snapshot.
