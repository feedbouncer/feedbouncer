-- Alerts: delivery channels (Slack webhook, email), per-brand spike settings and routes,
-- the alert events and their per-channel deliveries, and the evaluator's state.
BEGIN;

SET LOCAL lock_timeout = '10s';

CREATE TABLE alert_channel (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  kind text NOT NULL,
  label text NOT NULL,
  status text NOT NULL,
  key_id text,
  encrypted_webhook_url bytea,
  webhook_hint text,
  email text,
  confirm_key_sha256 bytea,
  confirm_expires_at timestamptz(3),
  confirmed_at timestamptz(3),
  unsubscribe_key_sha256 bytea,
  encrypted_unsubscribe_token bytea,
  disconnected_code text,
  consecutive_failures int NOT NULL DEFAULT 0,
  last_failure_at timestamptz(3),
  last_failure_code text,
  last_success_at timestamptz(3),
  next_send_at timestamptz(3) NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT alert_channel_pkey PRIMARY KEY (id),
  CONSTRAINT alert_channel_organization_id_id_key UNIQUE (organization_id, id),
  CONSTRAINT alert_channel_kind_check CHECK (kind IN ('slack', 'email')),
  CONSTRAINT alert_channel_label_check CHECK (label = btrim(label) AND char_length(label) BETWEEN 1 AND 80),
  CONSTRAINT alert_channel_status_check CHECK (
    status IN ('pending_confirmation', 'active', 'disconnected', 'unsubscribed')
  ),
  CONSTRAINT alert_channel_consecutive_failures_check CHECK (consecutive_failures >= 0),
  CONSTRAINT alert_channel_last_failure_code_check CHECK (last_failure_code ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT alert_channel_slack_check CHECK (
    kind <> 'slack' OR (
      key_id IS NOT NULL AND encrypted_webhook_url IS NOT NULL AND webhook_hint IS NOT NULL
      AND email IS NULL AND unsubscribe_key_sha256 IS NULL AND encrypted_unsubscribe_token IS NULL
      AND status IN ('active', 'disconnected')
    )
  ),
  CONSTRAINT alert_channel_email_check CHECK (
    kind <> 'email' OR (
      key_id IS NOT NULL AND email IS NOT NULL AND unsubscribe_key_sha256 IS NOT NULL
      AND encrypted_unsubscribe_token IS NOT NULL AND char_length(email) <= 254
      AND email = lower(email) AND encrypted_webhook_url IS NULL AND status <> 'disconnected'
    )
  ),
  CONSTRAINT alert_channel_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES organization (id) ON DELETE CASCADE,
  CONSTRAINT alert_channel_created_by_user_id_fkey FOREIGN KEY (created_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX alert_channel_organization_id_email_key ON alert_channel (organization_id, email)
  WHERE kind = 'email';
CREATE UNIQUE INDEX alert_channel_confirm_key_sha256_key ON alert_channel (confirm_key_sha256)
  WHERE confirm_key_sha256 IS NOT NULL;
CREATE UNIQUE INDEX alert_channel_unsubscribe_key_sha256_key ON alert_channel (unsubscribe_key_sha256)
  WHERE unsubscribe_key_sha256 IS NOT NULL;
CREATE INDEX alert_channel_created_by_user_id_idx ON alert_channel (created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;
CREATE TRIGGER alert_channel_set_updated_at_trg BEFORE UPDATE ON alert_channel
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

CREATE TABLE alert_brand_settings (
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  sensitivity text NOT NULL DEFAULT 'medium',
  min_negative_count int NOT NULL DEFAULT 10,
  cooldown_minutes int NOT NULL DEFAULT 360,
  content_mode text NOT NULL DEFAULT 'excerpts',
  updated_by_user_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT alert_brand_settings_pkey PRIMARY KEY (brand_id),
  CONSTRAINT alert_brand_settings_sensitivity_check CHECK (sensitivity IN ('low', 'medium', 'high')),
  CONSTRAINT alert_brand_settings_min_negative_count_check CHECK (min_negative_count BETWEEN 3 AND 1000),
  CONSTRAINT alert_brand_settings_cooldown_minutes_check CHECK (cooldown_minutes BETWEEN 30 AND 1440),
  CONSTRAINT alert_brand_settings_content_mode_check CHECK (content_mode IN ('excerpts', 'counts_only')),
  CONSTRAINT alert_brand_settings_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT alert_brand_settings_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE INDEX alert_brand_settings_organization_id_idx ON alert_brand_settings (organization_id);
CREATE INDEX alert_brand_settings_updated_by_user_id_idx ON alert_brand_settings (updated_by_user_id)
  WHERE updated_by_user_id IS NOT NULL;
CREATE TRIGGER alert_brand_settings_set_updated_at_trg BEFORE UPDATE ON alert_brand_settings
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

CREATE TABLE alert_route (
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  alert_type text NOT NULL,
  channel_id uuid NOT NULL,
  enabled boolean NOT NULL,
  enabled_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT alert_route_pkey PRIMARY KEY (brand_id, alert_type, channel_id),
  CONSTRAINT alert_route_alert_type_check CHECK (alert_type IN ('negative_spike', 'flagged_item')),
  CONSTRAINT alert_route_enabled_at_check CHECK (NOT enabled OR enabled_at IS NOT NULL),
  CONSTRAINT alert_route_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT alert_route_channel_id_fkey FOREIGN KEY (organization_id, channel_id)
    REFERENCES alert_channel (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX alert_route_organization_id_idx ON alert_route (organization_id);
CREATE INDEX alert_route_channel_id_idx ON alert_route (channel_id);
CREATE TRIGGER alert_route_set_updated_at_trg BEFORE UPDATE ON alert_route
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

CREATE TABLE alert_brand_state (
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  next_eval_at timestamptz(3) NOT NULL DEFAULT now(),
  first_live_at timestamptz(3),
  rollup_seeded_at timestamptz(3),
  episode_id uuid,
  cooldown_until timestamptz(3),
  trigger_count int,
  escalated boolean NOT NULL DEFAULT false,
  last_verdict text,
  last_evaluated_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT alert_brand_state_pkey PRIMARY KEY (brand_id),
  CONSTRAINT alert_brand_state_last_verdict_check CHECK (
    last_verdict IN ('learning', 'below_min', 'within_baseline', 'fired', 'escalated', 'cooldown')
  ),
  CONSTRAINT alert_brand_state_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX alert_brand_state_organization_id_idx ON alert_brand_state (organization_id);
CREATE INDEX alert_brand_state_next_eval_at_idx ON alert_brand_state (next_eval_at);
CREATE TRIGGER alert_brand_state_set_updated_at_trg BEFORE UPDATE ON alert_brand_state
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

CREATE TABLE alert_negative_hourly (
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  hour timestamptz(3) NOT NULL,
  negatives int NOT NULL,
  total int NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT alert_negative_hourly_pkey PRIMARY KEY (brand_id, hour),
  CONSTRAINT alert_negative_hourly_hour_check CHECK (hour = date_trunc('hour', hour)),
  CONSTRAINT alert_negative_hourly_negatives_check CHECK (negatives >= 0),
  CONSTRAINT alert_negative_hourly_total_check CHECK (total >= negatives),
  CONSTRAINT alert_negative_hourly_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX alert_negative_hourly_organization_id_idx ON alert_negative_hourly (organization_id);
CREATE TRIGGER alert_negative_hourly_set_updated_at_trg BEFORE UPDATE ON alert_negative_hourly
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

CREATE TABLE alert_event (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid,
  alert_type text NOT NULL,
  alert_key text NOT NULL,
  status text NOT NULL,
  window_start timestamptz(3),
  window_end timestamptz(3),
  payload jsonb NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT alert_event_pkey PRIMARY KEY (id),
  CONSTRAINT alert_event_organization_id_id_key UNIQUE (organization_id, id),
  CONSTRAINT alert_event_organization_id_alert_key_key UNIQUE (organization_id, alert_key),
  CONSTRAINT alert_event_alert_type_check CHECK (
    alert_type IN ('negative_spike', 'spike_escalation', 'flagged_digest', 'cap_reached')
  ),
  CONSTRAINT alert_event_alert_key_check CHECK (char_length(alert_key) BETWEEN 1 AND 200),
  CONSTRAINT alert_event_status_check CHECK (status IN ('queued', 'suppressed')),
  CONSTRAINT alert_event_payload_check CHECK (
    jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 16384
  ),
  CONSTRAINT alert_event_brand_scope_check CHECK ((alert_type = 'cap_reached') = (brand_id IS NULL)),
  CONSTRAINT alert_event_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES organization (id) ON DELETE CASCADE,
  CONSTRAINT alert_event_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX alert_event_organization_id_created_at_idx ON alert_event (organization_id, created_at DESC);
CREATE INDEX alert_event_brand_id_created_at_idx ON alert_event (brand_id, created_at DESC)
  WHERE brand_id IS NOT NULL;
CREATE TRIGGER alert_event_set_updated_at_trg BEFORE UPDATE ON alert_event
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

CREATE TABLE alert_delivery (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  alert_event_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  state text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz(3) NOT NULL DEFAULT now(),
  lease_until timestamptz(3),
  last_error_code text,
  sent_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT alert_delivery_pkey PRIMARY KEY (id),
  CONSTRAINT alert_delivery_alert_event_id_channel_id_key UNIQUE (alert_event_id, channel_id),
  CONSTRAINT alert_delivery_state_check CHECK (
    state IN ('pending', 'sending', 'retrying', 'sent', 'failed', 'cancelled', 'skipped')
  ),
  CONSTRAINT alert_delivery_attempts_check CHECK (attempts BETWEEN 0 AND 6),
  CONSTRAINT alert_delivery_last_error_code_check CHECK (last_error_code ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT alert_delivery_alert_event_id_fkey FOREIGN KEY (organization_id, alert_event_id)
    REFERENCES alert_event (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT alert_delivery_channel_id_fkey FOREIGN KEY (organization_id, channel_id)
    REFERENCES alert_channel (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX alert_delivery_organization_id_idx ON alert_delivery (organization_id);
CREATE INDEX alert_delivery_channel_id_idx ON alert_delivery (channel_id);
CREATE INDEX alert_delivery_due_idx ON alert_delivery (next_attempt_at)
  WHERE state IN ('pending', 'retrying');
CREATE INDEX alert_delivery_sending_idx ON alert_delivery (lease_until) WHERE state = 'sending';
CREATE TRIGGER alert_delivery_set_updated_at_trg BEFORE UPDATE ON alert_delivery
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

CREATE TABLE alert_flag_item (
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  review_item_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  flagged_at timestamptz(3) NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  alert_event_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT alert_flag_item_pkey PRIMARY KEY (review_item_id),
  CONSTRAINT alert_flag_item_state_check CHECK (state IN ('pending', 'included', 'skipped')),
  CONSTRAINT alert_flag_item_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT alert_flag_item_review_item_id_fkey FOREIGN KEY (brand_id, review_item_id)
    REFERENCES review_item (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT alert_flag_item_comment_id_fkey FOREIGN KEY (brand_id, comment_id)
    REFERENCES comment (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT alert_flag_item_alert_event_id_fkey FOREIGN KEY (organization_id, alert_event_id)
    REFERENCES alert_event (organization_id, id) ON DELETE SET NULL (alert_event_id)
);
CREATE INDEX alert_flag_item_organization_id_idx ON alert_flag_item (organization_id);
CREATE INDEX alert_flag_item_comment_id_idx ON alert_flag_item (comment_id);
CREATE INDEX alert_flag_item_alert_event_id_idx ON alert_flag_item (alert_event_id)
  WHERE alert_event_id IS NOT NULL;
CREATE INDEX alert_flag_item_brand_id_flagged_at_idx ON alert_flag_item (brand_id, flagged_at)
  WHERE state = 'pending';
CREATE TRIGGER alert_flag_item_set_updated_at_trg BEFORE UPDATE ON alert_flag_item
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- Serves the spike evaluator's live-comment scans per brand.
CREATE INDEX comment_organization_id_brand_id_posted_at_live_idx ON comment (organization_id, brand_id, posted_at)
  WHERE ingest_origin = 'live' AND NOT is_own_account;

COMMIT;
