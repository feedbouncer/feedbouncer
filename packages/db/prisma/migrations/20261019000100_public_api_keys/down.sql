-- No rows are deleted here: if api_key moderation_action or audit_event rows exist,
-- re-adding the old checks fails and the rollback aborts.
ALTER TABLE audit_event DROP CONSTRAINT audit_event_actor_type_check,
  ADD CONSTRAINT audit_event_actor_type_check CHECK (actor_type IN ('user', 'system', 'rule', 'classifier', 'policy'));
ALTER TABLE moderation_action DROP CONSTRAINT moderation_action_api_key_actor_check,
  DROP CONSTRAINT moderation_action_actor_type_check,
  ADD CONSTRAINT moderation_action_actor_type_check CHECK (actor_type IN ('user', 'rule', 'classifier', 'system', 'policy'));
DROP INDEX moderation_action_actor_api_key_id_idx;
ALTER TABLE moderation_action DROP CONSTRAINT moderation_action_organization_id_actor_api_key_id_fkey;
ALTER TABLE moderation_action DROP COLUMN actor_api_key_id;
DROP INDEX comment_org_posted_idx;
DROP TABLE api_idempotency_record;
DROP TABLE api_key;
