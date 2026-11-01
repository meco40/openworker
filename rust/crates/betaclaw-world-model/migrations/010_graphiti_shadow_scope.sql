-- World Model: scope the Graphiti shadow ledger like the other projections.
-- Additive follow-up; do not edit the already-applied 002/006 migrations.

ALTER TABLE world_model_graphiti_shadow
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_wm_graphiti_shadow_scoped
  ON world_model_graphiti_shadow (user_id, persona_id, workspace_id, ingested_at DESC);

DROP POLICY IF EXISTS wm_scope_policy ON world_model_graphiti_shadow;
CREATE POLICY wm_scope_policy ON world_model_graphiti_shadow
  USING (NOT world_model_is_scoped_session() OR (
    user_id = current_setting('world_model.user_id', true)
    AND persona_id = current_setting('world_model.persona_id', true)
    AND workspace_id = current_setting('world_model.workspace_id', true)
  ))
  WITH CHECK (NOT world_model_is_scoped_session() OR (
    user_id = current_setting('world_model.user_id', true)
    AND persona_id = current_setting('world_model.persona_id', true)
    AND workspace_id = current_setting('world_model.workspace_id', true)
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON world_model_graphiti_shadow
  TO world_model_app, world_model_worker;
