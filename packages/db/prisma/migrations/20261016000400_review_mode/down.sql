-- Data-destructive: drops all suggestions and approval runs, and the review-mode window and snapshots.
DELETE FROM action_run WHERE suggestion_id IS NOT NULL;
ALTER TABLE action_run
  DROP CONSTRAINT action_run_suggestion_comment_fkey,
  DROP CONSTRAINT action_run_approver_check,
  DROP CONSTRAINT action_run_origin_check,
  DROP COLUMN approved_by_user_id,
  DROP COLUMN suggestion_id,
  ALTER COLUMN rule_evaluation_id SET NOT NULL,
  ALTER COLUMN rule_id SET NOT NULL;
DROP TABLE action_suggestion_source;
DROP TABLE action_suggestion;
DROP FUNCTION action_suggestion_check_comment_connection();
ALTER TABLE policy_evaluation DROP COLUMN review_mode;
ALTER TABLE comment_classification DROP COLUMN review_mode;
ALTER TABLE rule_evaluation DROP CONSTRAINT rule_evaluation_also_matched_rule_ids_check, DROP COLUMN also_matched_rule_ids, DROP COLUMN review_mode;
ALTER TABLE connection
  DROP CONSTRAINT connection_review_mode_ended_check,
  DROP CONSTRAINT connection_review_mode_started_check,
  DROP CONSTRAINT connection_review_mode_window_check,
  DROP CONSTRAINT connection_review_mode_check,
  DROP COLUMN review_mode_ended_by_user_id,
  DROP COLUMN review_mode_ended_at,
  DROP COLUMN review_mode_ends_at,
  DROP COLUMN review_mode_started_at,
  DROP COLUMN review_mode;
