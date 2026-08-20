-- Canonical memory integrity follow-up.
-- Keep lifecycle values constrained at the database boundary so adapters
-- cannot silently create states that the runtime cannot interpret.

DO $$
BEGIN
  ALTER TABLE world_model_memory_items
    ADD CONSTRAINT wm_memory_items_lifecycle_status_check
    CHECK (lifecycle_status IN (
      'new', 'confirmed', 'stale', 'active', 'superseded', 'rejected', 'deleted'
    ));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_wm_memory_items_source_observation
  ON world_model_memory_items (source_observation_id)
  WHERE source_observation_id IS NOT NULL;
