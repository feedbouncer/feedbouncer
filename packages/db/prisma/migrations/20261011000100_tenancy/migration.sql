-- Core tenancy: organization -> brand -> connection; users and memberships.
-- Deletion behavior is documented in packages/db/README.md ("Deletion behavior").
BEGIN;

SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'FeedBouncer requires a UTF8 database (server_encoding is %)', current_setting('server_encoding');
  END IF;
END
$$;

CREATE FUNCTION fb_set_updated_at() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END
$$;

-- Append-only guard. pg_trigger_depth() = 1 means a client issued the statement
-- directly; >= 2 means a foreign-key action (CASCADE / SET NULL) issued it while
-- a parent row was deleted, which is allowed. TRUNCATE is always refused.
-- The function pins search_path and qualifies pg_trigger_depth() so a user-created
-- function of the same name in another schema cannot shadow it.
CREATE FUNCTION fb_forbid_direct_mutation() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' OR pg_catalog.pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TABLE organization (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT organization_pkey PRIMARY KEY (id),
  CONSTRAINT organization_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 200)
);
CREATE TRIGGER organization_set_updated_at_trg BEFORE UPDATE ON organization
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- "user" is reserved in Postgres.
CREATE TABLE app_user (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT app_user_pkey PRIMARY KEY (id),
  CONSTRAINT app_user_email_check CHECK (
    char_length(email) BETWEEN 3 AND 320 AND email = btrim(email) AND position('@' IN email) > 1),
  CONSTRAINT app_user_display_name_check CHECK (display_name IS NULL OR char_length(display_name) <= 200)
);
CREATE UNIQUE INDEX app_user_email_lower_key ON app_user (lower(email));
CREATE TRIGGER app_user_set_updated_at_trg BEFORE UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

CREATE TABLE membership (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT membership_pkey PRIMARY KEY (id),
  CONSTRAINT membership_organization_id_user_id_key UNIQUE (organization_id, user_id),
  CONSTRAINT membership_role_check CHECK (role IN ('owner', 'admin', 'member')),
  CONSTRAINT membership_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES organization (id) ON DELETE CASCADE,
  CONSTRAINT membership_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES app_user (id) ON DELETE CASCADE
);
CREATE INDEX membership_user_id_idx ON membership (user_id);
CREATE TRIGGER membership_set_updated_at_trg BEFORE UPDATE ON membership
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

CREATE TABLE brand (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT brand_pkey PRIMARY KEY (id),
  CONSTRAINT brand_organization_id_id_key UNIQUE (organization_id, id),
  CONSTRAINT brand_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT brand_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES organization (id) ON DELETE CASCADE
);
CREATE TRIGGER brand_set_updated_at_trg BEFORE UPDATE ON brand
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- No credential columns here: the Secrets ticket adds envelope-encrypted
-- encrypted_* bytea columns (guarded by conventions.integration.test.ts).
CREATE TABLE connection (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  platform text NOT NULL,
  external_account_id text NOT NULL,
  display_name text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT connection_pkey PRIMARY KEY (id),
  CONSTRAINT connection_organization_id_brand_id_id_key UNIQUE (organization_id, brand_id, id),
  CONSTRAINT connection_brand_id_platform_external_account_id_key UNIQUE (brand_id, platform, external_account_id),
  CONSTRAINT connection_platform_check CHECK (
    platform IN ('facebook', 'instagram', 'tiktok', 'youtube', 'threads', 'linkedin', 'x', 'bluesky')),
  CONSTRAINT connection_status_check CHECK (status IN ('active', 'paused', 'revoked', 'error')),
  CONSTRAINT connection_external_account_id_check CHECK (char_length(external_account_id) BETWEEN 1 AND 255),
  CONSTRAINT connection_display_name_check CHECK (display_name IS NULL OR char_length(display_name) <= 500),
  CONSTRAINT connection_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE
);
CREATE TRIGGER connection_set_updated_at_trg BEFORE UPDATE ON connection
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- processed_job (system table) gets the standard timestamps. Existing rows keep
-- their data; first_processed_at backfills both columns.
ALTER TABLE processed_job
  ADD COLUMN created_at timestamptz(3) NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz(3) NOT NULL DEFAULT now();
UPDATE processed_job SET created_at = first_processed_at, updated_at = first_processed_at;
CREATE TRIGGER processed_job_set_updated_at_trg BEFORE UPDATE ON processed_job
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

COMMIT;
