-- World Model: canonical ingestion checkpoints, projection retry state,
-- delivery receipts and explicit event replacement provenance.
-- Additive follow-up migration; never edit already-applied migrations.

CREATE TABLE IF NOT EXISTS world_model_ingestion_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  source_window_id TEXT NOT NULL,
  committed_observation_id UUID REFERENCES world_model_observations(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, persona_id, workspace_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_wm_ingestion_checkpoints_scope
  ON world_model_ingestion_checkpoints (user_id, persona_id, workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS world_model_projection_pending (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  projection_type TEXT NOT NULL,
  source_observation_id UUID REFERENCES world_model_observations(id) ON DELETE CASCADE,
  source_window_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  error_message TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, persona_id, workspace_id, projection_type, source_window_id)
);

CREATE INDEX IF NOT EXISTS idx_wm_projection_pending_due
  ON world_model_projection_pending (status, next_attempt_at, created_at)
  WHERE status IN ('pending','failed');

CREATE TABLE IF NOT EXISTS world_model_delivery_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_event_id UUID NOT NULL REFERENCES world_model_outbox_events(id) ON DELETE CASCADE,
  open_loop_id UUID REFERENCES world_model_open_loops(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL,
  target TEXT NOT NULL,
  provider_id TEXT,
  provider_message_id TEXT,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (outbox_event_id)
);

CREATE INDEX IF NOT EXISTS idx_wm_delivery_receipts_scope
  ON world_model_delivery_receipts (user_id, persona_id, workspace_id, delivered_at DESC);

CREATE TABLE IF NOT EXISTS world_model_rebuild_checkpoints (
  projection_type TEXT NOT NULL,
  user_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL,
  last_id UUID,
  processed_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (projection_type, user_id, persona_id, workspace_id, phase)
);

ALTER TABLE world_model_events
  ADD COLUMN IF NOT EXISTS replaces_event_id UUID REFERENCES world_model_events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wm_events_replaces
  ON world_model_events (replaces_event_id)
  WHERE replaces_event_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  world_model_ingestion_checkpoints,
  world_model_projection_pending,
  world_model_delivery_receipts
TO world_model_app, world_model_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON world_model_rebuild_checkpoints
TO world_model_app, world_model_worker;
