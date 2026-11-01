-- World Model (Phase 7/9): Additive lease and retry fields for open loops.
-- Enables `FOR UPDATE SKIP LOCKED` claims, backoff scheduling and delivery
-- receipts without dropping existing loops.

DO $$ BEGIN
  ALTER TABLE world_model_open_loops
    ADD COLUMN IF NOT EXISTS locked_by TEXT;
  ALTER TABLE world_model_open_loops
    ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
  ALTER TABLE world_model_open_loops
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_wm_open_loops_due_lease
  ON world_model_open_loops (user_id, persona_id, status, trigger_at, next_attempt_at)
  WHERE status IN ('open','scheduled');
