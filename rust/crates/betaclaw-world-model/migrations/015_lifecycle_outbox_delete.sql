-- Persona deletion is a scoped privacy operation, not an operational
-- outbox-retention job. The app role may delete only rows visible through its
-- existing World-Model RLS scope policy; the worker role remains unable to
-- delete outbox rows.
GRANT DELETE ON world_model_outbox_events TO world_model_app;
