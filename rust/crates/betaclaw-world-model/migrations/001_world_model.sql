-- World Model (canonical system of record) - migration 001
-- Bitemporal truth: valid_from/to + known_from/to, explicit modality. Append-only.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

DO $$ BEGIN
  CREATE TYPE world_model_source_type AS ENUM (
    'chat_message','email','calendar_event','location_signal',
    'tool_execution','outbound_message','user_confirmation','automation','manual'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE world_model_modality AS ENUM (
    'reported','planned','expected','inferred','observed','confirmed','denied'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE world_model_assertion_status AS ENUM ('active','superseded','cancelled','retracted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE world_model_event_status AS ENUM (
  'proposed','planned','in_progress','completed','cancelled','no_show','unknown'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE world_model_task_status AS ENUM (
    'proposed','planned','in_progress','waiting','completed','cancelled','failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE world_model_open_loop_type AS ENUM (
    'clarification','confirmation','event_outcome','dependency','missing_context','promised_follow_up'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE world_model_open_loop_status AS ENUM (
    'open','scheduled','asked','answered','resolved','cancelled','expired'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE world_model_standing_intent_status AS ENUM ('armed','cooldown','done','cancelled','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE world_model_relation_direction AS ENUM ('outgoing','incoming');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE world_model_outbox_status AS ENUM ('pending','dispatched','failed','permanent_failure');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS world_model_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL, persona_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT '',
  source_type world_model_source_type NOT NULL, source_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb, source_authority TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (user_id, persona_id, workspace_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_wm_observations_scope
  ON world_model_observations (user_id, persona_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_wm_observations_received
  ON world_model_observations (received_at);

CREATE TABLE IF NOT EXISTS world_model_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL, persona_id TEXT NOT NULL, canonical_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('person','project','place','organization','concept','object','event')),
  owner TEXT NOT NULL CHECK (owner IN ('persona','user','shared')),
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, persona_id, canonical_name, owner)
);
CREATE INDEX IF NOT EXISTS idx_wm_entities_scope
  ON world_model_entities (user_id, persona_id, category);

CREATE TABLE IF NOT EXISTS world_model_entity_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL, persona_id TEXT NOT NULL,
  source_entity_id UUID NOT NULL REFERENCES world_model_entities(id) ON DELETE CASCADE,
  target_entity_id UUID NOT NULL REFERENCES world_model_entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  direction world_model_relation_direction NOT NULL DEFAULT 'outgoing',
  confidence REAL NOT NULL DEFAULT 0.8,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(), valid_to TIMESTAMPTZ,
  known_from TIMESTAMPTZ NOT NULL DEFAULT now(), known_to TIMESTAMPTZ,
  supersedes_relation_id UUID, source_observation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wm_relations_source ON world_model_entity_relations (source_entity_id);
CREATE INDEX IF NOT EXISTS idx_wm_relations_target ON world_model_entity_relations (target_entity_id);
CREATE INDEX IF NOT EXISTS idx_wm_relations_active
  ON world_model_entity_relations (user_id, persona_id) WHERE known_to IS NULL AND valid_to IS NULL;

CREATE TABLE IF NOT EXISTS world_model_assertions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL, persona_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT '',
  subject_id UUID NOT NULL REFERENCES world_model_entities(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL,
  object_id UUID REFERENCES world_model_entities(id) ON DELETE CASCADE,
  object_value TEXT,
  polarity SMALLINT NOT NULL DEFAULT 1 CHECK (polarity IN (-1,0,1)),
  modality world_model_modality NOT NULL DEFAULT 'reported',
  status world_model_assertion_status NOT NULL DEFAULT 'active',
  confidence REAL NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(), valid_to TIMESTAMPTZ,
  known_from TIMESTAMPTZ NOT NULL DEFAULT now(), known_to TIMESTAMPTZ,
  source_observation_id UUID REFERENCES world_model_observations(id) ON DELETE SET NULL,
  supersedes_assertion_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (user_id, persona_id, workspace_id, subject_id, predicate, object_id, object_value)
);
CREATE INDEX IF NOT EXISTS idx_wm_assertions_active
  ON world_model_assertions (user_id, persona_id) WHERE status = 'active' AND known_to IS NULL;

CREATE TABLE IF NOT EXISTS world_model_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL, persona_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL, event_type TEXT NOT NULL,
  subject_entity_id UUID REFERENCES world_model_entities(id) ON DELETE SET NULL,
  counterpart_entity_id UUID REFERENCES world_model_entities(id) ON DELETE SET NULL,
  scheduled_for TIMESTAMPTZ, ends_at TIMESTAMPTZ,
  status world_model_event_status NOT NULL DEFAULT 'planned', observed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wm_events_status
  ON world_model_events (user_id, persona_id, status, scheduled_for);

CREATE TABLE IF NOT EXISTS world_model_event_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES world_model_events(id) ON DELETE CASCADE,
  from_status world_model_event_status, to_status world_model_event_status NOT NULL,
  reason TEXT,
  source_observation_id UUID REFERENCES world_model_observations(id) ON DELETE SET NULL,
  confidence REAL NOT NULL DEFAULT 0.8,
  transitioned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wm_event_transitions_event
  ON world_model_event_transitions (event_id, transitioned_at);

CREATE TABLE IF NOT EXISTS world_model_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL, persona_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL, description TEXT,
  requester TEXT NOT NULL, assignee TEXT NOT NULL, due_at TIMESTAMPTZ,
  depends_on_task_id UUID, status world_model_task_status NOT NULL DEFAULT 'proposed',
  priority SMALLINT NOT NULL DEFAULT 0, result TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb, approval_status TEXT NOT NULL DEFAULT 'not_required',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wm_tasks_status
  ON world_model_tasks (user_id, persona_id, status, due_at);

CREATE TABLE IF NOT EXISTS world_model_task_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES world_model_tasks(id) ON DELETE CASCADE,
  from_status world_model_task_status, to_status world_model_task_status NOT NULL,
  note TEXT,
  source_observation_id UUID REFERENCES world_model_observations(id) ON DELETE SET NULL,
  transitioned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wm_task_transitions_task
  ON world_model_task_transitions (task_id, transitioned_at);

CREATE TABLE IF NOT EXISTS world_model_action_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES world_model_tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, persona_id TEXT NOT NULL, action_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started','succeeded','failed','aborted')),
  output JSONB NOT NULL DEFAULT '{}'::jsonb, error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wm_action_attempts_task ON world_model_action_attempts (task_id);

CREATE TABLE IF NOT EXISTS world_model_open_loops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL, persona_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT '',
  type world_model_open_loop_type NOT NULL, status world_model_open_loop_status NOT NULL DEFAULT 'open',
  subject_id UUID REFERENCES world_model_entities(id) ON DELETE SET NULL,
  question TEXT, missing_information TEXT,
  importance SMALLINT NOT NULL DEFAULT 1 CHECK (importance BETWEEN 1 AND 5),
  trigger_at TIMESTAMPTZ, do_not_ask_before TIMESTAMPTZ, last_checked_at TIMESTAMPTZ,
  deduplication_key TEXT NOT NULL, max_attempts INTEGER NOT NULL DEFAULT 3,
  attempts INTEGER NOT NULL DEFAULT 0, last_asked_at TIMESTAMPTZ,
  resolved_observation_id UUID REFERENCES world_model_observations(id) ON DELETE SET NULL,
  note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, persona_id, workspace_id, deduplication_key)
);
CREATE INDEX IF NOT EXISTS idx_wm_open_loops_due
  ON world_model_open_loops (user_id, persona_id, status, trigger_at)
  WHERE status IN ('open','scheduled');

CREATE TABLE IF NOT EXISTS world_model_standing_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL, persona_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL, trigger_terms JSONB NOT NULL DEFAULT '[]'::jsonb,
  event_type TEXT, subject_scope TEXT, channel_scope TEXT, sender_scope TEXT,
  status world_model_standing_intent_status NOT NULL DEFAULT 'armed',
  expires_at TIMESTAMPTZ, cooldown_until TIMESTAMPTZ, cooldown_ms INTEGER NOT NULL DEFAULT 0,
  fire_count INTEGER NOT NULL DEFAULT 0, max_fires INTEGER NOT NULL DEFAULT 0,
  last_fired_at TIMESTAMPTZ, deduplication_key TEXT NOT NULL, note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, persona_id, workspace_id, deduplication_key)
);
CREATE INDEX IF NOT EXISTS idx_wm_standing_intents_armed
  ON world_model_standing_intents (user_id, persona_id) WHERE status = 'armed';

CREATE TABLE IF NOT EXISTS world_model_outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status world_model_outbox_status NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, error_message TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by TEXT, locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), dispatched_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wm_outbox_pending
  ON world_model_outbox_events (next_attempt_at, created_at)
  WHERE status IN ('pending','failed');

CREATE TABLE IF NOT EXISTS world_model_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type TEXT NOT NULL, target_id TEXT NOT NULL,
  user_id TEXT NOT NULL, persona_id TEXT NOT NULL,
  model TEXT NOT NULL, model_version TEXT NOT NULL DEFAULT '',
  embedding vector NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (target_type, target_id, model, model_version)
);
CREATE INDEX IF NOT EXISTS idx_wm_embeddings_target ON world_model_embeddings (target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_wm_assertions_fts
  ON world_model_assertions USING GIN (to_tsvector('simple', coalesce(object_value, '')));
