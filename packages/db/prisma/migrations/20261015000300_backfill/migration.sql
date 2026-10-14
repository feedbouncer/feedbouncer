-- Forward migration. Keep everything between BEGIN; and COMMIT;: Prisma runs this
-- file statement by statement, so the explicit transaction is what makes it atomic.
-- Never use CREATE INDEX CONCURRENTLY here. State ON DELETE on every REFERENCES.
-- Conventions: packages/db/README.md
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE comment
  ADD COLUMN ingest_origin text NOT NULL DEFAULT 'live',
  ADD CONSTRAINT comment_ingest_origin_check CHECK (ingest_origin IN ('live', 'backfill'));

CREATE TABLE connection_backfill (
  connection_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  run_id uuid NOT NULL,
  status text NOT NULL,
  failure_reason text,
  window_start timestamptz(3) NOT NULL,
  window_end timestamptz(3) NOT NULL,
  synced_through timestamptz(3),
  segment integer NOT NULL DEFAULT 0,
  sources_exhausted boolean NOT NULL DEFAULT false,
  source_cursor text,
  source_queue text[] NOT NULL DEFAULT '{}',
  comment_cursor text,
  imported_count integer NOT NULL DEFAULT 0,
  sources_done integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  skipped_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  max_comments integer NOT NULL DEFAULT 2000,
  limited boolean NOT NULL DEFAULT false,
  requested_at timestamptz(3) NOT NULL DEFAULT now(),
  started_at timestamptz(3),
  completed_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT connection_backfill_pkey PRIMARY KEY (connection_id),
  CONSTRAINT connection_backfill_connection_fkey FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE,
  CONSTRAINT connection_backfill_status_check CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  CONSTRAINT connection_backfill_failure_reason_check CHECK (
    failure_reason IS NULL OR failure_reason ~ '^[a-z][a-z0-9_]{0,62}$'),
  CONSTRAINT connection_backfill_window_check CHECK (window_start <= window_end),
  CONSTRAINT connection_backfill_counts_check CHECK (
    imported_count >= 0 AND sources_done >= 0 AND skipped_count >= 0 AND segment >= 0 AND max_comments > 0),
  CONSTRAINT connection_backfill_source_cursor_check CHECK (char_length(source_cursor) <= 2048),
  CONSTRAINT connection_backfill_comment_cursor_check CHECK (char_length(comment_cursor) <= 2048),
  CONSTRAINT connection_backfill_source_queue_check CHECK (
    cardinality(source_queue) <= 500
    AND array_to_string(source_queue, ',') ~ '^([0-9]{1,32}(_[0-9]{1,32}){0,2}(,|$))*$'),
  CONSTRAINT connection_backfill_skipped_sources_check CHECK (
    jsonb_typeof(skipped_sources) = 'array' AND jsonb_array_length(skipped_sources) <= 50)
);

COMMIT;
