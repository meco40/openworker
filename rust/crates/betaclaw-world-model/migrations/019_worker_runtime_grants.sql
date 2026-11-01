-- Background projection and proactive handlers use the same scoped domain tables.
-- RLS remains enabled: neither runtime role can read another tenant's scope.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  world_model_observations, world_model_entities, world_model_entity_relations,
  world_model_assertions, world_model_events, world_model_event_transitions,
  world_model_tasks, world_model_task_transitions, world_model_action_attempts,
  world_model_open_loops, world_model_standing_intents, world_model_embeddings,
  world_model_ingestion_checkpoints
TO world_model_worker;
