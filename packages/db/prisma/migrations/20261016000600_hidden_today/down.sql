DROP INDEX moderation_action_applied_hide_idx;
ALTER TABLE brand
  DROP CONSTRAINT brand_timezone_check,
  DROP COLUMN timezone_set_at,
  DROP COLUMN timezone;
