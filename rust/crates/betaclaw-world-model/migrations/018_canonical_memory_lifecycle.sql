-- Normalize the canonical memory lifecycle and support recall's active-only query.
-- `active` was an early compatibility value; runtime semantics use `confirmed`.

UPDATE world_model_memory_items
SET lifecycle_status = CASE
      WHEN deleted_at IS NOT NULL THEN 'deleted'
      WHEN lifecycle_status = 'active' THEN 'confirmed'
      ELSE lifecycle_status
    END,
    metadata = CASE
      WHEN deleted_at IS NOT NULL
        THEN jsonb_set(metadata, '{lifecycleStatus}', '"deleted"'::jsonb, true)
      WHEN lifecycle_status = 'active'
        THEN jsonb_set(metadata, '{lifecycleStatus}', '"confirmed"'::jsonb, true)
      ELSE metadata
    END
WHERE deleted_at IS NOT NULL OR lifecycle_status = 'active';

ALTER TABLE world_model_memory_items
  DROP CONSTRAINT IF EXISTS wm_memory_items_lifecycle_status_check;

ALTER TABLE world_model_memory_items
  ADD CONSTRAINT wm_memory_items_lifecycle_status_check
  CHECK (lifecycle_status IN (
    'new', 'confirmed', 'stale', 'superseded', 'rejected', 'deleted'
  ));

CREATE INDEX IF NOT EXISTS idx_wm_memory_items_scope_recall_active
  ON world_model_memory_items (user_id, persona_id, workspace_id, updated_at DESC)
  WHERE deleted_at IS NULL AND lifecycle_status IN ('new', 'confirmed');
