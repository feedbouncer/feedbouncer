-- VALIDATE CONSTRAINT marks the constraint validated in the catalog, which is a schema
-- change even though it rewrites no data. Undo it by dropping and re-adding as NOT VALID.
ALTER TABLE audit_event DROP CONSTRAINT audit_event_actor_type_check,
  ADD CONSTRAINT audit_event_actor_type_check CHECK (actor_type IN ('user', 'system', 'rule', 'classifier', 'policy', 'api_key')) NOT VALID;
ALTER TABLE moderation_action DROP CONSTRAINT moderation_action_api_key_actor_check,
  DROP CONSTRAINT moderation_action_actor_type_check,
  DROP CONSTRAINT moderation_action_organization_id_actor_api_key_id_fkey,
  ADD CONSTRAINT moderation_action_actor_type_check CHECK (actor_type IN ('user', 'rule', 'classifier', 'system', 'policy', 'api_key')) NOT VALID,
  ADD CONSTRAINT moderation_action_api_key_actor_check CHECK (actor_type = 'api_key' OR actor_api_key_id IS NULL) NOT VALID,
  ADD CONSTRAINT moderation_action_organization_id_actor_api_key_id_fkey
    FOREIGN KEY (organization_id, actor_api_key_id) REFERENCES api_key (organization_id, id)
    ON DELETE SET NULL (actor_api_key_id) NOT VALID;
