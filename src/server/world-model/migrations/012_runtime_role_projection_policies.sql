-- Runtime-role hardening for the durable ingestion/projection audit tables.
-- The migration is additive and safe to rerun on databases that already have
-- the World-Model runtime roles and policies.

DO $$ BEGIN
  ALTER TABLE world_model_assertions
    ADD CONSTRAINT wm_assertions_supersedes_fk FOREIGN KEY (supersedes_assertion_id)
      REFERENCES world_model_assertions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'world_model_ingestion_checkpoints',
    'world_model_projection_pending',
    'world_model_delivery_receipts',
    'world_model_rebuild_checkpoints'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS wm_scope_policy ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY wm_scope_policy ON %I USING ('
      || 'NOT world_model_is_scoped_session() OR ('
      || 'current_setting(''world_model.user_id'', true) = user_id AND '
      || 'current_setting(''world_model.persona_id'', true) = persona_id AND '
      || 'current_setting(''world_model.workspace_id'', true) = workspace_id)) '
      || 'WITH CHECK (NOT world_model_is_scoped_session() OR ('
      || 'current_setting(''world_model.user_id'', true) = user_id AND '
      || 'current_setting(''world_model.persona_id'', true) = persona_id AND '
      || 'current_setting(''world_model.workspace_id'', true) = workspace_id))',
      table_name
    );
  END LOOP;
END $$;

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

GRANT SELECT, INSERT, UPDATE, DELETE ON
  world_model_ingestion_checkpoints,
  world_model_projection_pending,
  world_model_delivery_receipts,
  world_model_rebuild_checkpoints,
  world_model_graphiti_shadow
TO world_model_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  world_model_projection_pending,
  world_model_delivery_receipts,
  world_model_rebuild_checkpoints,
  world_model_graphiti_shadow
TO world_model_worker;
