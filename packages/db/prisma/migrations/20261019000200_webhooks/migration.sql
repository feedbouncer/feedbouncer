BEGIN;
SET LOCAL lock_timeout = '10s';

-- Outgoing webhook endpoints. The signing secrets are envelope-sealed (kind webhook_endpoint_secret).
CREATE TABLE webhook_endpoint (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  url text NOT NULL,
  description text,
  event_types text[] NOT NULL,
  status text NOT NULL DEFAULT 'active',
  disabled_reason text,
  disabled_at timestamptz(3),
  consecutive_failures integer NOT NULL DEFAULT 0,
  first_failure_at timestamptz(3),
  last_dispatched_at timestamptz(3),
  signing_key_id text NOT NULL,
  encrypted_signing_secret bytea NOT NULL,
  previous_signing_key_id text,
  encrypted_previous_signing_secret bytea,
  rotation_overlap_until timestamptz(3),
  created_by_api_key_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT webhook_endpoint_pkey PRIMARY KEY (id),
  CONSTRAINT webhook_endpoint_organization_id_id_key UNIQUE (organization_id, id),
  CONSTRAINT webhook_endpoint_url_check CHECK (char_length(url) <= 2048 AND url ~ '^https://'),
  CONSTRAINT webhook_endpoint_description_check CHECK (char_length(description) <= 500),
  CONSTRAINT webhook_endpoint_event_types_check CHECK (
    cardinality(event_types) > 0
    AND event_types <@ ARRAY['comment.received', 'comment.hidden', 'item.flagged']),
  CONSTRAINT webhook_endpoint_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT webhook_endpoint_disabled_reason_check CHECK (disabled_reason IN ('consecutive_failures', 'manual')),
  CONSTRAINT webhook_endpoint_consecutive_failures_check CHECK (consecutive_failures >= 0),
  CONSTRAINT webhook_endpoint_rotation_check CHECK (
    (previous_signing_key_id IS NULL) = (encrypted_previous_signing_secret IS NULL)
    AND (previous_signing_key_id IS NULL) = (rotation_overlap_until IS NULL)),
  CONSTRAINT webhook_endpoint_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES organization (id) ON DELETE CASCADE,
  CONSTRAINT webhook_endpoint_created_by_api_key_id_fkey FOREIGN KEY (created_by_api_key_id)
    REFERENCES api_key (id) ON DELETE SET NULL
);
CREATE INDEX webhook_endpoint_active_idx ON webhook_endpoint (organization_id) WHERE status = 'active';
CREATE INDEX webhook_endpoint_created_by_api_key_id_idx ON webhook_endpoint (created_by_api_key_id)
  WHERE created_by_api_key_id IS NOT NULL;
CREATE TRIGGER webhook_endpoint_set_updated_at_trg BEFORE UPDATE ON webhook_endpoint
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- One row per event. No payload is stored: the body is rendered from the referenced rows at send time.
CREATE TABLE webhook_event (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid,
  type text NOT NULL,
  dedupe_key text NOT NULL,
  comment_id uuid,
  review_item_id uuid,
  moderation_action_id uuid,
  test_endpoint_id uuid,
  occurred_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT webhook_event_pkey PRIMARY KEY (id),
  CONSTRAINT webhook_event_organization_id_id_key UNIQUE (organization_id, id),
  CONSTRAINT webhook_event_organization_id_dedupe_key_key UNIQUE (organization_id, dedupe_key),
  CONSTRAINT webhook_event_type_check CHECK (
    type IN ('comment.received', 'comment.hidden', 'item.flagged', 'webhook.test')),
  CONSTRAINT webhook_event_dedupe_key_check CHECK (char_length(dedupe_key) <= 200),
  CONSTRAINT webhook_event_subject_check CHECK (
    (brand_id IS NULL) = (type = 'webhook.test') AND CASE type
      WHEN 'comment.received' THEN comment_id IS NOT NULL AND review_item_id IS NULL
        AND moderation_action_id IS NULL AND test_endpoint_id IS NULL
      WHEN 'comment.hidden' THEN comment_id IS NOT NULL AND review_item_id IS NULL
        AND moderation_action_id IS NOT NULL AND test_endpoint_id IS NULL
      WHEN 'item.flagged' THEN comment_id IS NULL AND review_item_id IS NOT NULL
        AND moderation_action_id IS NULL AND test_endpoint_id IS NULL
      ELSE comment_id IS NULL AND review_item_id IS NULL
        AND moderation_action_id IS NULL AND test_endpoint_id IS NOT NULL
    END),
  CONSTRAINT webhook_event_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES organization (id) ON DELETE CASCADE,
  CONSTRAINT webhook_event_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT webhook_event_comment_id_fkey FOREIGN KEY (brand_id, comment_id)
    REFERENCES comment (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT webhook_event_review_item_id_fkey FOREIGN KEY (brand_id, review_item_id)
    REFERENCES review_item (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT webhook_event_moderation_action_id_fkey FOREIGN KEY (brand_id, moderation_action_id)
    REFERENCES moderation_action (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT webhook_event_test_endpoint_id_fkey FOREIGN KEY (organization_id, test_endpoint_id)
    REFERENCES webhook_endpoint (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX webhook_event_created_at_idx ON webhook_event (created_at);
CREATE INDEX webhook_event_brand_id_idx ON webhook_event (brand_id) WHERE brand_id IS NOT NULL;
CREATE INDEX webhook_event_comment_id_idx ON webhook_event (comment_id) WHERE comment_id IS NOT NULL;
CREATE INDEX webhook_event_review_item_id_idx ON webhook_event (review_item_id) WHERE review_item_id IS NOT NULL;
CREATE INDEX webhook_event_moderation_action_id_idx ON webhook_event (moderation_action_id)
  WHERE moderation_action_id IS NOT NULL;
CREATE INDEX webhook_event_test_endpoint_id_idx ON webhook_event (test_endpoint_id)
  WHERE test_endpoint_id IS NOT NULL;
CREATE TRIGGER webhook_event_set_updated_at_trg BEFORE UPDATE ON webhook_event
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- One row per send obligation; attempts is the number of HTTP attempts already made.
CREATE TABLE webhook_delivery (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  endpoint_id uuid NOT NULL,
  event_id uuid NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz(3) NOT NULL DEFAULT now(),
  lease_until timestamptz(3),
  last_attempt_at timestamptz(3),
  last_response_status integer,
  last_error_code text,
  last_duration_ms integer,
  succeeded_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT webhook_delivery_pkey PRIMARY KEY (id),
  CONSTRAINT webhook_delivery_kind_check CHECK (kind IN ('event', 'test', 'redelivery')),
  CONSTRAINT webhook_delivery_status_check CHECK (
    status IN ('pending', 'sending', 'retrying', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT webhook_delivery_attempts_check CHECK (attempts BETWEEN 0 AND 7),
  CONSTRAINT webhook_delivery_last_response_status_check CHECK (last_response_status BETWEEN 100 AND 599),
  CONSTRAINT webhook_delivery_last_error_code_check CHECK (last_error_code IN (
    'timeout', 'dns_error', 'tls_error', 'connection_error', 'blocked_destination', 'redirect',
    'http_status', 'endpoint_disabled', 'subject_gone', 'outcome_unknown')),
  CONSTRAINT webhook_delivery_last_duration_ms_check CHECK (last_duration_ms >= 0),
  CONSTRAINT webhook_delivery_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES organization (id) ON DELETE CASCADE,
  CONSTRAINT webhook_delivery_endpoint_id_fkey FOREIGN KEY (organization_id, endpoint_id)
    REFERENCES webhook_endpoint (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT webhook_delivery_event_id_fkey FOREIGN KEY (organization_id, event_id)
    REFERENCES webhook_event (organization_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX webhook_delivery_event_key ON webhook_delivery (endpoint_id, event_id) WHERE kind = 'event';
CREATE INDEX webhook_delivery_due_idx ON webhook_delivery (endpoint_id, next_attempt_at)
  WHERE status IN ('pending', 'retrying');
CREATE INDEX webhook_delivery_sending_idx ON webhook_delivery (lease_until) WHERE status = 'sending';
CREATE INDEX webhook_delivery_endpoint_sending_idx ON webhook_delivery (endpoint_id) WHERE status = 'sending';
CREATE INDEX webhook_delivery_org_sending_idx ON webhook_delivery (organization_id) WHERE status = 'sending';
CREATE INDEX webhook_delivery_list_idx ON webhook_delivery (endpoint_id, created_at DESC, id DESC);
CREATE INDEX webhook_delivery_event_id_idx ON webhook_delivery (event_id);
CREATE TRIGGER webhook_delivery_set_updated_at_trg BEFORE UPDATE ON webhook_delivery
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- Outbox writer. Does nothing unless an active endpoint subscribes to the type, so organizations
-- without webhooks pay one index probe. Tables are schema-qualified because search_path is pinned.
CREATE FUNCTION fb_enqueue_webhook_event(
  p_org uuid, p_brand uuid, p_type text, p_dedupe text,
  p_comment uuid, p_review_item uuid, p_action uuid, p_occurred timestamptz
) RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_event uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.webhook_endpoint
     WHERE organization_id = p_org AND status = 'active' AND event_types @> ARRAY[p_type]
  ) THEN
    RETURN;
  END IF;
  INSERT INTO public.webhook_event
    (organization_id, brand_id, type, dedupe_key, comment_id, review_item_id, moderation_action_id, occurred_at)
  VALUES (p_org, p_brand, p_type, p_dedupe, p_comment, p_review_item, p_action, p_occurred)
  ON CONFLICT (organization_id, dedupe_key) DO NOTHING
  RETURNING id INTO v_event;
  IF v_event IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.webhook_delivery (organization_id, endpoint_id, event_id, kind)
  SELECT p_org, id, v_event, 'event'
    FROM public.webhook_endpoint
   WHERE organization_id = p_org AND status = 'active' AND event_types @> ARRAY[p_type];
END
$$;

CREATE FUNCTION fb_emit_comment_received() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM public.fb_enqueue_webhook_event(
    NEW.organization_id, NEW.brand_id, 'comment.received', 'comment.received:' || NEW.id,
    NEW.id, NULL, NULL, NEW.ingested_at);
  RETURN NULL;
END
$$;
CREATE TRIGGER comment_webhook_received_trg AFTER INSERT ON comment
  FOR EACH ROW WHEN (NEW.ingest_origin = 'live' AND NOT NEW.is_own_account)
  EXECUTE FUNCTION fb_emit_comment_received();

CREATE FUNCTION fb_emit_comment_hidden() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM public.fb_enqueue_webhook_event(
    NEW.organization_id, NEW.brand_id, 'comment.hidden', 'comment.hidden:' || NEW.id,
    NEW.comment_id, NULL, NEW.id, coalesce(NEW.completed_at, pg_catalog.now()));
  RETURN NULL;
END
$$;
CREATE TRIGGER moderation_action_webhook_hidden_trg AFTER UPDATE OF status ON moderation_action
  FOR EACH ROW WHEN (NEW.kind = 'hide' AND NEW.status = 'applied' AND OLD.status IS DISTINCT FROM 'applied')
  EXECUTE FUNCTION fb_emit_comment_hidden();

CREATE FUNCTION fb_emit_item_flagged() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM public.fb_enqueue_webhook_event(
    NEW.organization_id, NEW.brand_id, 'item.flagged', 'item.flagged:' || NEW.id,
    NULL, NEW.id, NULL, NEW.created_at);
  RETURN NULL;
END
$$;
CREATE TRIGGER review_item_webhook_flagged_trg AFTER INSERT ON review_item
  FOR EACH ROW EXECUTE FUNCTION fb_emit_item_flagged();

COMMIT;
