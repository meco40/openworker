-- World Model: canonical long-term memory items.
--
-- This table replaces Mem0 as the application-owned memory system of record.
-- It deliberately keeps the legacy provider id for an auditable, idempotent
-- migration and retains soft-deleted rows so privacy operations remain
-- reconstructable without making deleted memories retrievable.

CREATE TABLE IF NOT EXISTS world_model_memory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  memory_type TEXT NOT NULL CHECK (memory_type IN (
    'fact','preference','avoidance','lesson','personality_trait','workflow_pattern'
  )),
  content TEXT NOT NULL CHECK (length(trim(content)) > 0),
  importance SMALLINT NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  confidence REAL NOT NULL DEFAULT 0.3 CHECK (confidence BETWEEN 0.1 AND 1.0),
  lifecycle_status TEXT NOT NULL DEFAULT 'new',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT,
  legacy_provider TEXT,
  legacy_provider_id TEXT,
  source_observation_id UUID REFERENCES world_model_observations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_memory_items_idempotency
  ON world_model_memory_items (user_id, persona_id, workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_memory_items_legacy_identity
  ON world_model_memory_items (user_id, persona_id, workspace_id, legacy_provider, legacy_provider_id)
  WHERE legacy_provider IS NOT NULL AND legacy_provider_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wm_memory_items_scope_active
  ON world_model_memory_items (user_id, persona_id, workspace_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_wm_memory_items_type_active
  ON world_model_memory_items (user_id, persona_id, workspace_id, memory_type)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_wm_memory_items_fts
  ON world_model_memory_items USING GIN (to_tsvector('simple', content));

CREATE TABLE IF NOT EXISTS world_model_memory_item_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES world_model_memory_items(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL CHECK (action IN ('create','update','delete')),
  version INTEGER NOT NULL CHECK (version >= 1),
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wm_memory_history_memory
  ON world_model_memory_item_history (memory_id, version, created_at);

CREATE INDEX IF NOT EXISTS idx_wm_memory_history_scope
  ON world_model_memory_item_history (user_id, persona_id, workspace_id, created_at DESC);

ALTER TABLE world_model_memory_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wm_scope_policy ON world_model_memory_items;
CREATE POLICY wm_scope_policy ON world_model_memory_items
  USING (NOT world_model_is_scoped_session() OR (
    current_setting('world_model.user_id', true) = user_id AND
    current_setting('world_model.persona_id', true) = persona_id AND
    current_setting('world_model.workspace_id', true) = workspace_id
  ))
  WITH CHECK (NOT world_model_is_scoped_session() OR (
    current_setting('world_model.user_id', true) = user_id AND
    current_setting('world_model.persona_id', true) = persona_id AND
    current_setting('world_model.workspace_id', true) = workspace_id
  ));

ALTER TABLE world_model_memory_item_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wm_scope_policy ON world_model_memory_item_history;
CREATE POLICY wm_scope_policy ON world_model_memory_item_history
  USING (NOT world_model_is_scoped_session() OR (
    current_setting('world_model.user_id', true) = user_id AND
    current_setting('world_model.persona_id', true) = persona_id AND
    current_setting('world_model.workspace_id', true) = workspace_id
  ))
  WITH CHECK (NOT world_model_is_scoped_session() OR (
    current_setting('world_model.user_id', true) = user_id AND
    current_setting('world_model.persona_id', true) = persona_id AND
    current_setting('world_model.workspace_id', true) = workspace_id
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON
  world_model_memory_items, world_model_memory_item_history
  TO world_model_app, world_model_worker;

-- Counts across personas are intentionally exposed only as an aggregate. This
-- keeps health/control-plane counters useful without granting an app session
-- unscoped access to memory content under RLS.
CREATE OR REPLACE FUNCTION world_model_count_memory_items(
  p_user_id TEXT,
  p_persona_id TEXT DEFAULT NULL,
  p_workspace_id TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)
  FROM world_model_memory_items
  WHERE user_id = p_user_id
    AND (p_persona_id IS NULL OR persona_id = p_persona_id)
    AND (p_workspace_id IS NULL OR workspace_id = p_workspace_id)
    AND deleted_at IS NULL;
$$;

REVOKE ALL ON FUNCTION world_model_count_memory_items(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION world_model_count_memory_items(TEXT, TEXT, TEXT)
  TO world_model_app, world_model_worker;
