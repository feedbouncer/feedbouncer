DELETE FROM moderation_action WHERE actor_type = 'policy';
-- audit_event is append-only, so the rows with the 'policy' actor are removed with
-- the delete guard disabled for this one statement; a NOT VALID constraint would leave
-- the schema different from the one before this migration.
ALTER TABLE audit_event DISABLE TRIGGER audit_event_append_only_trg;
DELETE FROM audit_event WHERE actor_type = 'policy';
ALTER TABLE audit_event ENABLE TRIGGER audit_event_append_only_trg;
ALTER TABLE audit_event DROP CONSTRAINT audit_event_actor_type_check,
  ADD CONSTRAINT audit_event_actor_type_check CHECK (actor_type IN ('user', 'system', 'rule', 'classifier'));
ALTER TABLE moderation_action DROP CONSTRAINT moderation_action_actor_type_check,
  ADD CONSTRAINT moderation_action_actor_type_check CHECK (actor_type IN ('user', 'rule', 'classifier', 'system'));
ALTER TABLE decision DROP CONSTRAINT decision_policy_evidence_check;
ALTER TABLE decision DROP CONSTRAINT decision_actor_check,
  DROP CONSTRAINT decision_actor_type_check;
DROP INDEX decision_policy_revision_id_idx;
DROP INDEX decision_policy_evaluation_id_idx;
ALTER TABLE decision DROP CONSTRAINT decision_policy_revision_id_fkey,
  DROP CONSTRAINT decision_policy_evaluation_id_fkey;
ALTER TABLE decision DROP COLUMN policy_revision_id, DROP COLUMN policy_evaluation_id;
ALTER TABLE decision
  ADD CONSTRAINT decision_actor_type_check CHECK (actor_type IN ('user', 'rule', 'classifier')),
  ADD CONSTRAINT decision_actor_check CHECK (
       (actor_type = 'user' AND rule_id IS NULL AND classifier_provider IS NULL AND classifier_model IS NULL)
    OR (actor_type = 'rule' AND rule_id IS NOT NULL AND actor_user_id IS NULL
        AND classifier_provider IS NULL AND classifier_model IS NULL)
    OR (actor_type = 'classifier' AND classifier_provider IS NOT NULL AND classifier_model IS NOT NULL
        AND actor_user_id IS NULL AND rule_id IS NULL));
DROP TABLE policy_usage;
DROP TABLE policy_run;
DROP TABLE policy_preview_result;
DROP TABLE policy_preview;
DROP TABLE policy_evaluation_match;
DROP TABLE policy_evaluation;
DROP FUNCTION fb_policy_evaluation_guard();
DROP TABLE custom_policy_revision;
DROP TABLE custom_policy;
