BEGIN;
SET LOCAL lock_timeout = '10s';

-- True when every element is a YouTube channel id; NULL and empty elements are invalid.
CREATE FUNCTION fb_youtube_channel_ids_valid(ids text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT NOT EXISTS (SELECT 1 FROM unnest(ids) AS e WHERE e IS NULL OR e !~ '^UC[A-Za-z0-9_-]{22}$') $$;

-- Per-connection owner settings: daily quota budget, dry-run switch, protected authors.
CREATE TABLE youtube_connection_settings (
  connection_id       uuid NOT NULL,
  organization_id     uuid NOT NULL,
  brand_id            uuid NOT NULL,
  daily_budget_units  integer NOT NULL DEFAULT 2000,
  dry_run             boolean NOT NULL DEFAULT false,
  protected_author_ids text[] NOT NULL DEFAULT '{}',
  updated_by_user_id  uuid,
  created_at          timestamptz(3) NOT NULL DEFAULT now(),
  updated_at          timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT youtube_connection_settings_pkey PRIMARY KEY (connection_id),
  CONSTRAINT youtube_connection_settings_connection_fkey FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE,
  CONSTRAINT youtube_connection_settings_budget_check CHECK (daily_budget_units BETWEEN 0 AND 1000000),
  CONSTRAINT youtube_connection_settings_protected_count_check CHECK (cardinality(protected_author_ids) <= 200),
  CONSTRAINT youtube_connection_settings_protected_format_check
    CHECK (fb_youtube_channel_ids_valid(protected_author_ids))
);
CREATE INDEX youtube_connection_settings_scope_idx
  ON youtube_connection_settings (organization_id, brand_id, connection_id);
CREATE TRIGGER youtube_connection_settings_set_updated_at_trg BEFORE UPDATE ON youtube_connection_settings
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- Per-connection poll and dispatch cycle state.
CREATE TABLE youtube_connection_state (
  connection_id     uuid NOT NULL,
  organization_id   uuid NOT NULL,
  brand_id          uuid NOT NULL,
  next_read_at      timestamptz(3) NOT NULL DEFAULT now(),
  next_dispatch_at  timestamptz(3),
  lease_until       timestamptz(3),
  lease_token       uuid,
  high_water_at     timestamptz(3),
  resume_page_token text,
  last_read_units   integer NOT NULL DEFAULT 2,
  last_cycle_at     timestamptz(3),
  last_error_code   text,
  created_at        timestamptz(3) NOT NULL DEFAULT now(),
  updated_at        timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT youtube_connection_state_pkey PRIMARY KEY (connection_id),
  CONSTRAINT youtube_connection_state_connection_fkey FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE,
  CONSTRAINT youtube_connection_state_resume_page_token_check
    -- Postgres regex repetition is capped at 255, so the 512 limit is a separate length check.
    CHECK (resume_page_token IS NULL
      OR (char_length(resume_page_token) <= 512 AND resume_page_token ~ '^[A-Za-z0-9_-]+$')),
  CONSTRAINT youtube_connection_state_last_error_code_check
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$')
);
CREATE INDEX youtube_connection_state_scope_idx
  ON youtube_connection_state (organization_id, brand_id, connection_id);
CREATE INDEX youtube_connection_state_next_read_at_idx ON youtube_connection_state (next_read_at);
CREATE TRIGGER youtube_connection_state_set_updated_at_trg BEFORE UPDATE ON youtube_connection_state
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- Recently active comment threads, used by the reply sweep.
CREATE TABLE youtube_thread (
  connection_id      uuid NOT NULL,
  thread_external_id text NOT NULL,
  organization_id    uuid NOT NULL,
  brand_id           uuid NOT NULL,
  video_external_id  text NOT NULL,
  reply_count        integer NOT NULL,
  last_activity_at   timestamptz(3) NOT NULL,
  created_at         timestamptz(3) NOT NULL DEFAULT now(),
  updated_at         timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT youtube_thread_pkey PRIMARY KEY (connection_id, thread_external_id),
  CONSTRAINT youtube_thread_connection_fkey FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE
);
CREATE INDEX youtube_thread_activity_idx
  ON youtube_thread (connection_id, last_activity_at DESC);
CREATE INDEX youtube_thread_scope_idx
  ON youtube_thread (organization_id, brand_id, connection_id);
CREATE TRIGGER youtube_thread_set_updated_at_trg BEFORE UPDATE ON youtube_thread
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- Moderation actions waiting for quota.
CREATE TABLE youtube_action_queue (
  action_id       uuid NOT NULL,
  organization_id uuid NOT NULL,
  brand_id        uuid NOT NULL,
  connection_id   uuid NOT NULL,
  comment_id      uuid NOT NULL,
  tier            smallint NOT NULL,
  requested_at    timestamptz(3) NOT NULL,
  state           text NOT NULL DEFAULT 'queued',
  batch_id        uuid,
  created_at      timestamptz(3) NOT NULL DEFAULT now(),
  updated_at      timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT youtube_action_queue_pkey PRIMARY KEY (action_id),
  -- Action and comment must belong to the same brand as the queue row.
  CONSTRAINT youtube_action_queue_action_fkey FOREIGN KEY (brand_id, action_id)
    REFERENCES moderation_action (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT youtube_action_queue_comment_fkey FOREIGN KEY (brand_id, comment_id)
    REFERENCES comment (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT youtube_action_queue_connection_fkey FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE,
  CONSTRAINT youtube_action_queue_tier_check CHECK (tier BETWEEN 0 AND 3),
  CONSTRAINT youtube_action_queue_state_check CHECK (state IN ('queued','in_flight'))
);
CREATE INDEX youtube_action_queue_dispatch_idx
  ON youtube_action_queue (connection_id, state, tier, requested_at, action_id);
CREATE INDEX youtube_action_queue_scope_idx
  ON youtube_action_queue (organization_id, brand_id, connection_id);
CREATE INDEX youtube_action_queue_comment_id_idx ON youtube_action_queue (comment_id);
CREATE TRIGGER youtube_action_queue_set_updated_at_trg BEFORE UPDATE ON youtube_action_queue
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- Restart-safe write batches (one setModerationStatus call each).
CREATE TABLE youtube_write_batch (
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  brand_id             uuid NOT NULL,
  connection_id        uuid NOT NULL,
  pacific_day          date NOT NULL,
  moderation_status    text NOT NULL,
  ban_author           boolean NOT NULL,
  comment_external_ids text[] NOT NULL,
  action_ids           uuid[] NOT NULL,
  state                text NOT NULL,
  outcome_code         text,
  created_at           timestamptz(3) NOT NULL DEFAULT now(),
  updated_at           timestamptz(3) NOT NULL DEFAULT now(),
  sent_at              timestamptz(3),
  completed_at         timestamptz(3),
  CONSTRAINT youtube_write_batch_pkey PRIMARY KEY (id),
  CONSTRAINT youtube_write_batch_connection_fkey FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE,
  CONSTRAINT youtube_write_batch_moderation_status_check
    CHECK (moderation_status IN ('heldForReview','published','rejected')),
  CONSTRAINT youtube_write_batch_ban_author_check CHECK (NOT ban_author OR moderation_status = 'rejected'),
  CONSTRAINT youtube_write_batch_comment_external_ids_check
    CHECK (cardinality(comment_external_ids) BETWEEN 1 AND 50),
  CONSTRAINT youtube_write_batch_state_check CHECK (state IN ('planned','sent','confirmed','failed')),
  CONSTRAINT youtube_write_batch_outcome_code_check
    CHECK (outcome_code IS NULL OR outcome_code ~ '^[a-z0-9_]{1,64}$')
);
CREATE INDEX youtube_write_batch_connection_id_state_idx ON youtube_write_batch (connection_id, state);
CREATE INDEX youtube_write_batch_scope_idx
  ON youtube_write_batch (organization_id, brand_id, connection_id);
CREATE TRIGGER youtube_write_batch_set_updated_at_trg BEFORE UPDATE ON youtube_write_batch
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- Every unit of YouTube Data API quota spent (or simulated). Scope columns are nullable and the
-- connection FK is SET NULL so daily totals survive a disconnect and cover OAuth-time calls.
CREATE TABLE youtube_quota_ledger (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  call_key        text NOT NULL,
  pacific_day     date NOT NULL,
  organization_id uuid,
  brand_id        uuid,
  connection_id   uuid,
  method          text NOT NULL,
  purpose         text NOT NULL,
  units           integer NOT NULL,
  simulated       boolean NOT NULL DEFAULT false,
  outcome         text NOT NULL DEFAULT 'sent',
  error_code      text,
  created_at      timestamptz(3) NOT NULL DEFAULT now(),
  updated_at      timestamptz(3) NOT NULL DEFAULT now(),
  completed_at    timestamptz(3),
  CONSTRAINT youtube_quota_ledger_pkey PRIMARY KEY (id),
  CONSTRAINT youtube_quota_ledger_call_key_key UNIQUE (call_key),
  CONSTRAINT youtube_quota_ledger_connection_id_fkey FOREIGN KEY (connection_id)
    REFERENCES connection (id) ON DELETE SET NULL (connection_id),
  CONSTRAINT youtube_quota_ledger_method_check CHECK (method IN
    ('commentThreads.list','comments.list','channels.list','comments.setModerationStatus')),
  CONSTRAINT youtube_quota_ledger_purpose_check CHECK (purpose IN ('read','write','connect')),
  CONSTRAINT youtube_quota_ledger_units_check CHECK (units > 0),
  CONSTRAINT youtube_quota_ledger_outcome_check CHECK (outcome IN ('sent','ok','error','quota_exceeded')),
  CONSTRAINT youtube_quota_ledger_error_code_check
    CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$')
);
CREATE INDEX youtube_quota_ledger_pacific_day_idx ON youtube_quota_ledger (pacific_day);
CREATE INDEX youtube_quota_ledger_connection_id_pacific_day_idx
  ON youtube_quota_ledger (connection_id, pacific_day);
CREATE TRIGGER youtube_quota_ledger_set_updated_at_trg BEFORE UPDATE ON youtube_quota_ledger
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- Project-wide pause after Google reports quotaExceeded; not tenant data.
CREATE TABLE youtube_quota_pause (
  pacific_day date NOT NULL,
  reason      text NOT NULL,
  paused_at   timestamptz(3) NOT NULL DEFAULT now(),
  resume_at   timestamptz(3) NOT NULL,
  CONSTRAINT youtube_quota_pause_pkey PRIMARY KEY (pacific_day),
  CONSTRAINT youtube_quota_pause_reason_check CHECK (reason IN ('quota_exceeded'))
);

-- Once-per-day owner notices.
CREATE TABLE youtube_notice (
  connection_id   uuid NOT NULL,
  kind            text NOT NULL,
  pacific_day     date NOT NULL,
  organization_id uuid NOT NULL,
  brand_id        uuid NOT NULL,
  count           integer NOT NULL DEFAULT 0,
  sent_at         timestamptz(3),
  created_at      timestamptz(3) NOT NULL DEFAULT now(),
  updated_at      timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT youtube_notice_pkey PRIMARY KEY (connection_id, kind, pacific_day),
  CONSTRAINT youtube_notice_connection_fkey FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE,
  CONSTRAINT youtube_notice_kind_check CHECK (kind IN ('quota_paused','backlog_overflow'))
);
CREATE INDEX youtube_notice_scope_idx
  ON youtube_notice (organization_id, brand_id, connection_id);
CREATE TRIGGER youtube_notice_set_updated_at_trg BEFORE UPDATE ON youtube_notice
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- Comment ids kept for YouTube bookkeeping must not outlive the comment: when comments are deleted
-- (subject erasure, retention purge, or a cascade from a source), their thread rows and their ids in
-- write batches go too. A batch left with no id is deleted. Deleting a connection cascades to these
-- tables by itself.
CREATE FUNCTION fb_youtube_forget_comments() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  DELETE FROM youtube_thread t USING old_rows o
   WHERE t.connection_id = o.connection_id AND t.thread_external_id = o.external_id
     AND o.parent_external_id IS NULL;
  DELETE FROM youtube_write_batch b
   WHERE b.connection_id IN (SELECT connection_id FROM old_rows)
     AND b.comment_external_ids && (SELECT array_agg(o.external_id) FROM old_rows o WHERE o.connection_id = b.connection_id)
     AND NOT EXISTS (
       SELECT 1 FROM unnest(b.comment_external_ids) AS e
        WHERE e <> ALL (SELECT o.external_id FROM old_rows o WHERE o.connection_id = b.connection_id));
  UPDATE youtube_write_batch b
     SET comment_external_ids = ARRAY(
       SELECT e FROM unnest(b.comment_external_ids) WITH ORDINALITY AS u(e, n)
        WHERE e <> ALL (SELECT o.external_id FROM old_rows o WHERE o.connection_id = b.connection_id)
        ORDER BY n)
   WHERE b.connection_id IN (SELECT connection_id FROM old_rows)
     AND b.comment_external_ids && (SELECT array_agg(o.external_id) FROM old_rows o WHERE o.connection_id = b.connection_id);
  RETURN NULL;
END
$$;
CREATE TRIGGER comment_youtube_forget_trg AFTER DELETE ON comment
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION fb_youtube_forget_comments();

COMMIT;
