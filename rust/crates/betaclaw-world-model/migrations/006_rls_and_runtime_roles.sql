-- World Model (Phase 1): Row-Level Security + runtime roles.
-- Dedicated runtime roles are scope-restricted. The database owner remains a
-- migration/operations role and therefore bypasses RLS until deployment uses
-- the dedicated app/worker credentials.

DO $$ BEGIN
  CREATE ROLE world_model_app NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE world_model_worker NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION world_model_set_scope(
  p_user_id TEXT, p_persona_id TEXT, p_workspace_id TEXT DEFAULT ''
) RETURNS void AS $$
BEGIN
  PERFORM set_config('world_model.user_id', p_user_id, true);
  PERFORM set_config('world_model.persona_id', p_persona_id, true);
  PERFORM set_config('world_model.workspace_id', p_workspace_id, true);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION world_model_is_scoped_session() RETURNS boolean AS $$
BEGIN
  RETURN current_user IN ('world_model_app', 'world_model_worker');
END;
$$ LANGUAGE plpgsql STABLE;

-- Directly scoped aggregate tables.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'world_model_observations',
    'world_model_entities',
    'world_model_entity_relations',
    'world_model_assertions',
    'world_model_events',
    'world_model_tasks',
    'world_model_action_attempts',
    'world_model_open_loops',
    'world_model_standing_intents',
    'world_model_embeddings'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS wm_scope_policy ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY wm_scope_policy ON %I USING ('
      || 'NOT world_model_is_scoped_session() OR ('
      || 'current_setting(''world_model.user_id'', true) = user_id AND '
      || 'current_setting(''world_model.persona_id'', true) = persona_id AND '
      || 'current_setting(''world_model.workspace_id'', true) = workspace_id)) '
      || 'WITH CHECK ('
      || 'NOT world_model_is_scoped_session() OR ('
      || 'current_setting(''world_model.user_id'', true) = user_id AND '
      || 'current_setting(''world_model.persona_id'', true) = persona_id AND '
      || 'current_setting(''world_model.workspace_id'', true) = workspace_id))',
      table_name
    );
  END LOOP;
END $$;

-- Transition rows inherit their scope from their parent aggregate.
ALTER TABLE world_model_event_transitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wm_scope_policy ON world_model_event_transitions;
CREATE POLICY wm_scope_policy ON world_model_event_transitions
  USING (NOT world_model_is_scoped_session() OR EXISTS (
    SELECT 1 FROM world_model_events event
    WHERE event.id = event_id
      AND event.user_id = current_setting('world_model.user_id', true)
      AND event.persona_id = current_setting('world_model.persona_id', true)
      AND event.workspace_id = current_setting('world_model.workspace_id', true)
  ))
  WITH CHECK (NOT world_model_is_scoped_session() OR EXISTS (
    SELECT 1 FROM world_model_events event
    WHERE event.id = event_id
      AND event.user_id = current_setting('world_model.user_id', true)
      AND event.persona_id = current_setting('world_model.persona_id', true)
      AND event.workspace_id = current_setting('world_model.workspace_id', true)
  ));

ALTER TABLE world_model_task_transitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wm_scope_policy ON world_model_task_transitions;
CREATE POLICY wm_scope_policy ON world_model_task_transitions
  USING (NOT world_model_is_scoped_session() OR EXISTS (
    SELECT 1 FROM world_model_tasks task
    WHERE task.id = task_id
      AND task.user_id = current_setting('world_model.user_id', true)
      AND task.persona_id = current_setting('world_model.persona_id', true)
      AND task.workspace_id = current_setting('world_model.workspace_id', true)
  ))
  WITH CHECK (NOT world_model_is_scoped_session() OR EXISTS (
    SELECT 1 FROM world_model_tasks task
    WHERE task.id = task_id
      AND task.user_id = current_setting('world_model.user_id', true)
      AND task.persona_id = current_setting('world_model.persona_id', true)
      AND task.workspace_id = current_setting('world_model.workspace_id', true)
  ));

-- Outbox scope is nullable for legacy rows. Dedicated roles may only see
-- explicitly scoped rows matching their request context.
ALTER TABLE world_model_outbox_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wm_scope_policy ON world_model_outbox_events;
CREATE POLICY wm_scope_policy ON world_model_outbox_events
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

ALTER TABLE world_model_graphiti_shadow ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wm_scope_policy ON world_model_graphiti_shadow;
CREATE POLICY wm_scope_policy ON world_model_graphiti_shadow
  USING (NOT world_model_is_scoped_session() OR (
    user_id = current_setting('world_model.user_id', true)
    AND persona_id = current_setting('world_model.persona_id', true)
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON
  world_model_observations, world_model_entities, world_model_entity_relations,
  world_model_assertions, world_model_events, world_model_event_transitions,
  world_model_tasks, world_model_task_transitions, world_model_action_attempts,
  world_model_open_loops, world_model_standing_intents, world_model_embeddings
  TO world_model_app;
GRANT SELECT, INSERT, UPDATE ON world_model_outbox_events TO world_model_worker;
