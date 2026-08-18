-- Bring databases that already applied migrations 001/002 to the current
-- scoped-idempotency and leased-outbox contract.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE world_model_observations
  DROP CONSTRAINT IF EXISTS world_model_observations_source_type_source_id_key;

DO $$ BEGIN
  ALTER TABLE world_model_observations
    ADD CONSTRAINT world_model_observations_scoped_source_key
    UNIQUE (user_id, persona_id, workspace_id, source_type, source_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE world_model_open_loops
  DROP CONSTRAINT IF EXISTS world_model_open_loops_user_id_persona_id_deduplication_key_key;
DO $$ BEGIN
  ALTER TABLE world_model_open_loops
    ADD CONSTRAINT world_model_open_loops_scoped_deduplication_key
    UNIQUE (user_id, persona_id, workspace_id, deduplication_key);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE world_model_standing_intents
  DROP CONSTRAINT IF EXISTS world_model_standing_intents_user_id_persona_id_deduplication_key_key;
DO $$ BEGIN
  ALTER TABLE world_model_standing_intents
    ADD CONSTRAINT world_model_standing_intents_scoped_deduplication_key
    UNIQUE (user_id, persona_id, workspace_id, deduplication_key);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE world_model_outbox_events
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS locked_by TEXT,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

DROP INDEX IF EXISTS idx_wm_outbox_pending;
CREATE INDEX idx_wm_outbox_pending
  ON world_model_outbox_events (next_attempt_at, created_at)
  WHERE status IN ('pending','failed');

ALTER TABLE world_model_graphiti_shadow
  ADD COLUMN IF NOT EXISTS source_outbox_event_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_graphiti_shadow_outbox_event
  ON world_model_graphiti_shadow (source_outbox_event_id)
  WHERE source_outbox_event_id IS NOT NULL;
