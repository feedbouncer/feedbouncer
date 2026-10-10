-- Content: sources (posts/ads/videos/threads), authors (platform identities per
-- connection) and comments. Idempotent ingestion relies on the *_external_id_key
-- uniques with INSERT ... ON CONFLICT DO NOTHING.
BEGIN;

SET LOCAL lock_timeout = '10s';

CREATE TABLE source (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  kind text NOT NULL,
  external_id text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT source_pkey PRIMARY KEY (id),
  CONSTRAINT source_connection_id_external_id_key UNIQUE (connection_id, external_id),
  CONSTRAINT source_organization_id_brand_id_connection_id_id_key UNIQUE (organization_id, brand_id, connection_id, id),
  CONSTRAINT source_kind_check CHECK (kind IN ('organic_post', 'ad_post', 'video', 'thread')),
  CONSTRAINT source_external_id_check CHECK (char_length(external_id) BETWEEN 1 AND 255),
  CONSTRAINT source_metadata_check CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT source_organization_id_brand_id_connection_id_fkey FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE
);
CREATE TRIGGER source_set_updated_at_trg BEFORE UPDATE ON source
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- Deletion behavior is documented in packages/db/README.md ("Deletion behavior").
-- Erasure: either DELETE (comment.author_id becomes NULL) or anonymize in place
-- (display_name NULL, external_id replaced, anonymized_at set).
CREATE TABLE author (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  external_id text NOT NULL,
  display_name text,
  anonymized_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT author_pkey PRIMARY KEY (id),
  CONSTRAINT author_connection_id_external_id_key UNIQUE (connection_id, external_id),
  CONSTRAINT author_connection_id_id_key UNIQUE (connection_id, id),
  CONSTRAINT author_external_id_check CHECK (char_length(external_id) BETWEEN 1 AND 255),
  CONSTRAINT author_display_name_check CHECK (display_name IS NULL OR char_length(display_name) <= 500),
  CONSTRAINT author_anonymized_check CHECK (anonymized_at IS NULL OR display_name IS NULL),
  CONSTRAINT author_organization_id_brand_id_connection_id_fkey FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE
);
CREATE TRIGGER author_set_updated_at_trg BEFORE UPDATE ON author
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- body is unbounded text (no truncation). posted_at = platform time,
-- ingested_at = when FeedBouncer stored it. parent_external_id is kept even when
-- the parent row is missing or deleted, so replies can be linked later.
CREATE TABLE comment (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  source_id uuid NOT NULL,
  external_id text NOT NULL,
  author_id uuid,
  parent_comment_id uuid,
  parent_external_id text,
  body text NOT NULL,
  platform_state text NOT NULL DEFAULT 'visible',
  posted_at timestamptz(3) NOT NULL,
  ingested_at timestamptz(3) NOT NULL DEFAULT now(),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT comment_pkey PRIMARY KEY (id),
  CONSTRAINT comment_source_id_external_id_key UNIQUE (source_id, external_id),
  CONSTRAINT comment_source_id_id_key UNIQUE (source_id, id),
  CONSTRAINT comment_brand_id_id_key UNIQUE (brand_id, id),
  CONSTRAINT comment_external_id_check CHECK (char_length(external_id) BETWEEN 1 AND 255),
  CONSTRAINT comment_parent_external_id_check CHECK (
    parent_external_id IS NULL OR (char_length(parent_external_id) BETWEEN 1 AND 255 AND parent_external_id <> external_id)),
  CONSTRAINT comment_parent_not_self_check CHECK (parent_comment_id IS NULL OR parent_comment_id <> id),
  CONSTRAINT comment_platform_state_check CHECK (platform_state IN ('visible', 'hidden', 'deleted')),
  CONSTRAINT comment_organization_id_brand_id_connection_id_source_id_fkey
    FOREIGN KEY (organization_id, brand_id, connection_id, source_id)
    REFERENCES source (organization_id, brand_id, connection_id, id) ON DELETE CASCADE,
  CONSTRAINT comment_connection_id_author_id_fkey FOREIGN KEY (connection_id, author_id)
    REFERENCES author (connection_id, id) ON DELETE SET NULL (author_id),
  CONSTRAINT comment_source_id_parent_comment_id_fkey FOREIGN KEY (source_id, parent_comment_id)
    REFERENCES comment (source_id, id) ON DELETE SET NULL (parent_comment_id)
);
CREATE INDEX comment_author_id_idx ON comment (author_id) WHERE author_id IS NOT NULL;
CREATE INDEX comment_parent_comment_id_idx ON comment (parent_comment_id) WHERE parent_comment_id IS NOT NULL;
CREATE INDEX comment_source_id_parent_external_id_idx ON comment (source_id, parent_external_id)
  WHERE parent_external_id IS NOT NULL AND parent_comment_id IS NULL;
CREATE INDEX comment_organization_id_source_id_ingested_at_idx ON comment (organization_id, source_id, ingested_at DESC, id DESC);
CREATE INDEX comment_organization_id_ingested_at_idx ON comment (organization_id, ingested_at DESC, id DESC);
CREATE TRIGGER comment_set_updated_at_trg BEFORE UPDATE ON comment
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

COMMIT;
