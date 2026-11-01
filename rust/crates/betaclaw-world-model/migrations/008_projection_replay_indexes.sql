-- Review hardening: preserve replay idempotency for databases that applied
-- migration 005 before the source-identity indexes were added.
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
