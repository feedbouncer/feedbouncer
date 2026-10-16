-- Hidden today: each brand gets a timezone so "today" means local midnight, and the
-- applied hides get a partial index for the per-brand list, newest first.
BEGIN;

SET LOCAL lock_timeout = '10s';

-- Existing brands stay on UTC; timezone_set_at stays NULL until someone picks a zone.
ALTER TABLE brand
  ADD COLUMN timezone text NOT NULL DEFAULT 'UTC',
  ADD COLUMN timezone_set_at timestamptz(3),
  ADD CONSTRAINT brand_timezone_check CHECK (
    char_length(timezone) BETWEEN 1 AND 64
    AND timezone ~ '^(UTC|[A-Za-z]+([/_+-][A-Za-z0-9]+)+)$');

CREATE INDEX moderation_action_applied_hide_idx
  ON moderation_action (organization_id, brand_id, completed_at DESC, id DESC)
  WHERE kind = 'hide' AND status = 'applied';

COMMIT;
