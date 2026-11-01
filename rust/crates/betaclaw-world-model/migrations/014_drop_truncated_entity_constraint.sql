-- Migration 014: Drop legacy 4-column unique constraints on world_model_entities if present.
-- Superseded by idx_wm_entities_scoped_name_owner (user_id, persona_id, workspace_id, canonical_name, owner).

ALTER TABLE world_model_entities
  DROP CONSTRAINT IF EXISTS world_model_entities_user_id_persona_id_canonical_name_owne_key;

ALTER TABLE world_model_entities
  DROP CONSTRAINT IF EXISTS world_model_entities_user_id_persona_id_canonical_name_owner_key;
