-- World Model (Phase 11): pgvector produktiv machen.
-- Fuegt HNSW-Indizes fuer semantische Suche hinzu (scope-freundlich) und
-- versioniert das Embedding-Format (Modell/Modellversion/Text-Hash).
-- Additiv und wiederholbar.

-- pgvector can only build HNSW on a vector column with fixed dimensions. The
-- model/dimension decision is still configurable, so do not make migration
-- startup fail for the current dimensionless compatibility column.
DO $$
DECLARE
  embedding_typmod integer;
BEGIN
  SELECT atttypmod INTO embedding_typmod
  FROM pg_attribute
  WHERE attrelid = 'world_model_embeddings'::regclass
    AND attname = 'embedding' AND NOT attisdropped;
  IF embedding_typmod > 0 THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_wm_embeddings_hnsw '
      || 'ON world_model_embeddings USING hnsw (embedding vector_cosine_ops)';
  END IF;
END $$;

-- Scope-freundlicher Partial-Index: gezielte Suche je User/Persona/Workspace.
CREATE INDEX IF NOT EXISTS idx_wm_embeddings_scope_hnsw
  ON world_model_embeddings (user_id, persona_id, workspace_id)
  WHERE model_version <> '';

-- Versionierung/Provenienz der Embeddings.
DO $$ BEGIN
  ALTER TABLE world_model_embeddings
    ADD COLUMN IF NOT EXISTS text_hash TEXT;
  ALTER TABLE world_model_embeddings
    ADD COLUMN IF NOT EXISTS projection_version TEXT DEFAULT 'v1';
  ALTER TABLE world_model_embeddings
    ADD COLUMN IF NOT EXISTS target_content TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_embeddings_text_hash
  ON world_model_embeddings (target_type, target_id, text_hash, model, model_version)
  WHERE text_hash IS NOT NULL;
