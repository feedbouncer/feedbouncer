-- Validate the public API key constraints. VALIDATE CONSTRAINT takes a lock that allows
-- concurrent writes, which is why it is not part of the migration that adds them.
BEGIN;

ALTER TABLE moderation_action VALIDATE CONSTRAINT moderation_action_organization_id_actor_api_key_id_fkey;
ALTER TABLE moderation_action VALIDATE CONSTRAINT moderation_action_actor_type_check;
ALTER TABLE moderation_action VALIDATE CONSTRAINT moderation_action_api_key_actor_check;
ALTER TABLE audit_event VALIDATE CONSTRAINT audit_event_actor_type_check;

COMMIT;
