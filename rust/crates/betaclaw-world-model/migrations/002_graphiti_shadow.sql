-- Graphiti Shadow Mode (Phase 5). Nicht-verbindliche, aus der Outbox gespeiste
-- temporale Graphen-Projektion. Gilt nur zum Messen; entscheidet nichts.
CREATE TABLE IF NOT EXISTS world_model_graphiti_shadow (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_outbox_event_id UUID NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  source_entity TEXT NOT NULL,
  target_entity TEXT,
  relation_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  evidence_observation_id UUID REFERENCES world_model_observations(id) ON DELETE SET NULL,
  source_aggregate TEXT NOT NULL,
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  shadow_episode JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_wm_graphiti_shadow_scope
  ON world_model_graphiti_shadow (user_id, persona_id, ingested_at DESC);
