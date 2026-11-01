-- Assertions also belong to a workspace. Keep facts from separate workspace
-- scopes from colliding while preserving NULL-equal object identifiers.
ALTER TABLE world_model_assertions
  DROP CONSTRAINT IF EXISTS world_model_assertions_user_id_persona_id_subject_id_predicate_object_id_object_value_key;

DO $$ BEGIN
  ALTER TABLE world_model_assertions
    ADD CONSTRAINT world_model_assertions_scoped_fact_key
    UNIQUE NULLS NOT DISTINCT (
      user_id, persona_id, workspace_id, subject_id, predicate, object_id, object_value
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
