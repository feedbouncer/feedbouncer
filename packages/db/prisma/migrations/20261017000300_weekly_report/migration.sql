-- Weekly email report: the workspace timezone that decides where a week starts, per-member
-- report subscriptions, the computed weekly reports and their per-member email deliveries.
BEGIN;

SET LOCAL lock_timeout = '10s';

-- Workspaces start from the oldest explicitly chosen brand timezone; the rest stay on UTC.
ALTER TABLE organization
  ADD COLUMN timezone text NOT NULL DEFAULT 'UTC',
  ADD COLUMN timezone_set_at timestamptz(3),
  ADD CONSTRAINT organization_timezone_check CHECK (
    char_length(timezone) BETWEEN 1 AND 64
    AND timezone ~ '^(UTC|[A-Za-z]+([/_+-][A-Za-z0-9]+)+)$');

UPDATE organization o
   SET timezone = b.timezone, timezone_set_at = now()
  FROM (SELECT DISTINCT ON (organization_id) organization_id, timezone
          FROM brand
         WHERE timezone_set_at IS NOT NULL AND archived_at IS NULL
         ORDER BY organization_id, created_at, id) b
 WHERE b.organization_id = o.id;

CREATE TABLE report_subscription (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'subscribed',
  unsubscribed_at timestamptz(3),
  key_id text NOT NULL,
  unsubscribe_key_sha256 bytea NOT NULL,
  encrypted_unsubscribe_token bytea NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT report_subscription_pkey PRIMARY KEY (id),
  CONSTRAINT report_subscription_organization_id_user_id_key UNIQUE (organization_id, user_id),
  CONSTRAINT report_subscription_status_check CHECK (status IN ('subscribed', 'unsubscribed')),
  CONSTRAINT report_subscription_unsubscribed_at_check CHECK (
    (status = 'unsubscribed') = (unsubscribed_at IS NOT NULL)
  ),
  CONSTRAINT report_subscription_organization_id_user_id_fkey FOREIGN KEY (organization_id, user_id)
    REFERENCES membership (organization_id, user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX report_subscription_unsubscribe_key_sha256_key
  ON report_subscription (unsubscribe_key_sha256);
CREATE INDEX report_subscription_user_id_idx ON report_subscription (user_id);
CREATE TRIGGER report_subscription_set_updated_at_trg BEFORE UPDATE ON report_subscription
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

CREATE TABLE weekly_report (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  week_start date NOT NULL,
  timezone text NOT NULL,
  period_start timestamptz(3) NOT NULL,
  period_end timestamptz(3) NOT NULL,
  status text NOT NULL,
  payload jsonb,
  computed_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT weekly_report_pkey PRIMARY KEY (id),
  CONSTRAINT weekly_report_organization_id_week_start_key UNIQUE (organization_id, week_start),
  CONSTRAINT weekly_report_organization_id_id_key UNIQUE (organization_id, id),
  CONSTRAINT weekly_report_week_start_check CHECK (extract(isodow FROM week_start) = 1),
  CONSTRAINT weekly_report_period_check CHECK (period_end > period_start),
  CONSTRAINT weekly_report_status_check CHECK (status IN ('queued', 'skipped_quiet', 'missed')),
  CONSTRAINT weekly_report_payload_check CHECK (
    payload IS NULL OR (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 65536)
  ),
  CONSTRAINT weekly_report_queued_payload_check CHECK ((status = 'queued') = (payload IS NOT NULL)),
  CONSTRAINT weekly_report_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES organization (id) ON DELETE CASCADE
);
CREATE TRIGGER weekly_report_set_updated_at_trg BEFORE UPDATE ON weekly_report
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

CREATE TABLE weekly_report_delivery (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  report_id uuid NOT NULL,
  user_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz(3) NOT NULL DEFAULT now(),
  lease_until timestamptz(3),
  last_error_code text,
  sent_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT weekly_report_delivery_pkey PRIMARY KEY (id),
  CONSTRAINT weekly_report_delivery_report_id_user_id_key UNIQUE (report_id, user_id),
  CONSTRAINT weekly_report_delivery_state_check CHECK (
    state IN ('pending', 'sending', 'retrying', 'sent', 'failed', 'cancelled')
  ),
  CONSTRAINT weekly_report_delivery_attempts_check CHECK (attempts BETWEEN 0 AND 6),
  CONSTRAINT weekly_report_delivery_last_error_code_check CHECK (last_error_code ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT weekly_report_delivery_organization_id_report_id_fkey FOREIGN KEY (organization_id, report_id)
    REFERENCES weekly_report (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT weekly_report_delivery_organization_id_user_id_fkey FOREIGN KEY (organization_id, user_id)
    REFERENCES membership (organization_id, user_id) ON DELETE CASCADE
);
CREATE INDEX weekly_report_delivery_organization_id_report_id_idx
  ON weekly_report_delivery (organization_id, report_id);
CREATE INDEX weekly_report_delivery_user_id_idx ON weekly_report_delivery (user_id);
CREATE INDEX weekly_report_delivery_due_idx ON weekly_report_delivery (next_attempt_at)
  WHERE state IN ('pending', 'retrying');
CREATE INDEX weekly_report_delivery_sending_idx ON weekly_report_delivery (lease_until)
  WHERE state = 'sending';
CREATE TRIGGER weekly_report_delivery_set_updated_at_trg BEFORE UPDATE ON weekly_report_delivery
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

COMMIT;
