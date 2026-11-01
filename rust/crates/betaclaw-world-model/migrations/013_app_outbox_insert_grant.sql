-- Runtime-role fix (Phase 15 evidence finding): the app role performs the
-- canonical writes and therefore publishes outbox intents inside the same
-- transaction (transactional outbox). The idempotent upsert in
-- enqueueOutboxEvent (INSERT ... ON CONFLICT DO UPDATE ... RETURNING) needs
-- SELECT/INSERT/UPDATE on the outbox table; without it the canonical write
-- path fails for the dedicated app role. DELETE stays withheld: outbox rows
-- are only retired by operational tooling, never by the app. Row isolation
-- continues to be enforced by the wm_scope_policy RLS policy.
-- The worker role holds the same privileges from migration 006.

GRANT SELECT, INSERT, UPDATE ON world_model_outbox_events TO world_model_app;
