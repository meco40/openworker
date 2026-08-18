-- World Model (Phase 1): Additive scope/history/identity hardening.
-- Adds workspace scoping where missing, stable idempotency keys on aggregates,
-- provenance columns and audit fields. Additive only; safe to re-run.

-- Entities: add workspace scoping.
DO $$ BEGIN
  ALTER TABLE world_model_entities
    ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE world_model_entities
    ADD COLUMN IF NOT EXISTS created_by TEXT;
  ALTER TABLE world_model_entities
    ADD COLUMN IF NOT EXISTS source_authority TEXT DEFAULT 'system';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

ALTER TABLE world_model_entities
  DROP CONSTRAINT IF EXISTS world_model_entities_user_id_persona_id_canonical_name_owner_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_entities_scoped_name_owner
  ON world_model_entities (user_id, persona_id, workspace_id, canonical_name, owner);

ALTER TABLE world_model_entity_relations
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';

-- Relation FK hardening for supersedes/source.
DO $$ BEGIN
  ALTER TABLE world_model_entity_relations
    ADD CONSTRAINT wm_relations_supersedes_fk FOREIGN KEY (supersedes_relation_id)
      REFERENCES world_model_entity_relations(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE world_model_entity_relations
    ADD CONSTRAINT wm_relations_source_observation_fk FOREIGN KEY (source_observation_id)
      REFERENCES world_model_observations(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Action attempts: add workspace scoping + correlation id.
DO $$ BEGIN
  ALTER TABLE world_model_action_attempts
    ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE world_model_action_attempts
    ADD COLUMN IF NOT EXISTS correlation_id TEXT;
  ALTER TABLE world_model_action_attempts
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_action_attempts_scoped_idempotency
  ON world_model_action_attempts (user_id, persona_id, workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Embeddings: add workspace scoping.
DO $$ BEGIN
  ALTER TABLE world_model_embeddings
    ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

ALTER TABLE world_model_embeddings
  DROP CONSTRAINT IF EXISTS world_model_embeddings_target_type_target_id_model_model_version_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_embeddings_scoped_target_model
  ON world_model_embeddings (
    user_id, persona_id, workspace_id, target_type, target_id, model, model_version
  );

-- Outbox events: stable source idempotency (optional) + correlation id.
DO $$ BEGIN
  ALTER TABLE world_model_outbox_events
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
  ALTER TABLE world_model_outbox_events
    ADD COLUMN IF NOT EXISTS correlation_id TEXT;
  ALTER TABLE world_model_outbox_events
    ADD COLUMN IF NOT EXISTS user_id TEXT;
  ALTER TABLE world_model_outbox_events
    ADD COLUMN IF NOT EXISTS persona_id TEXT;
  ALTER TABLE world_model_outbox_events
    ADD COLUMN IF NOT EXISTS workspace_id TEXT DEFAULT '';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_outbox_idempotency
  ON world_model_outbox_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Events: idempotency/external identity + audit.
DO $$ BEGIN
  ALTER TABLE world_model_events
    ADD COLUMN IF NOT EXISTS external_id TEXT;
  ALTER TABLE world_model_events
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
  ALTER TABLE world_model_events
    ADD COLUMN IF NOT EXISTS created_by TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DROP INDEX IF EXISTS idx_wm_events_idempotency;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_events_idempotency
  ON world_model_events (user_id, persona_id, workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Tasks: stable external identity and evidence links for canonical action state.
ALTER TABLE world_model_tasks
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'world_model',
  ADD COLUMN IF NOT EXISTS external_task_id TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS request_observation_id UUID REFERENCES world_model_observations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS completion_evidence_id UUID REFERENCES world_model_observations(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_tasks_scoped_idempotency
  ON world_model_tasks (user_id, persona_id, workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Historical assertions may recur after the previous truth was closed. Only
-- one identical active truth is unique at a time.
ALTER TABLE world_model_assertions
  DROP CONSTRAINT IF EXISTS world_model_assertions_scoped_fact_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_assertions_active_identity
  ON world_model_assertions (
    user_id, persona_id, workspace_id, subject_id, predicate,
    COALESCE(object_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(object_value, '')
  )
  WHERE status = 'active' AND known_to IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_assertions_source_identity
  ON world_model_assertions (
    source_observation_id, subject_id, predicate,
    COALESCE(object_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(object_value, '')
  )
  WHERE source_observation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_relations_source_identity
  ON world_model_entity_relations (
    source_observation_id, source_entity_id, target_entity_id, relation_type
  )
  WHERE source_observation_id IS NOT NULL;
