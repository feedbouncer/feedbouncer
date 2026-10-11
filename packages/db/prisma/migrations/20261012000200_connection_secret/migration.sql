-- Encrypted platform credentials (envelope encryption, see packages/secrets
-- and docs/operations/secrets.md) and the reconnect-required connection state.
-- Only ciphertext is ever stored: encryption happens in the application.
BEGIN;

SET LOCAL lock_timeout = '10s';

ALTER TABLE connection DROP CONSTRAINT connection_status_check;
ALTER TABLE connection ADD CONSTRAINT connection_status_check
  CHECK (status IN ('active', 'paused', 'revoked', 'error', 'reconnect_required'));
ALTER TABLE connection ADD COLUMN status_reason text;
ALTER TABLE connection ADD CONSTRAINT connection_status_reason_check
  CHECK (status_reason IS NULL OR (char_length(status_reason) <= 63 AND status_reason ~ '^[a-z][a-z_]*$'));

CREATE TABLE connection_secret (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  kind text NOT NULL,
  key_id text NOT NULL,
  encrypted_value bytea NOT NULL,
  expires_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT connection_secret_pkey PRIMARY KEY (id),
  CONSTRAINT connection_secret_connection_id_kind_key UNIQUE (connection_id, kind),
  CONSTRAINT connection_secret_kind_check CHECK (kind IN ('access_token', 'refresh_token', 'webhook_secret')),
  CONSTRAINT connection_secret_key_id_check CHECK (key_id ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  -- Envelope v1 layout (packages/secrets/src/envelope.ts):
  --   [0]            version, 1
  --   [1]            key id length N, 1..32
  --   [2 .. 2+N)    key id, must equal key_id
  --   [2+N .. 4+N)  wrapped key length W, big-endian, 1..65535
  --   then W wrapped key bytes, 12 IV bytes, 16 tag bytes, and 1..16384
  --   ciphertext bytes (the bytes after the tag).
  -- CASE keeps evaluation ordered so get_byte never reads past the end; the
  -- smallest valid blob is 94 bytes, which also covers every get_byte below.
  -- Plaintext cannot satisfy this.
  CONSTRAINT connection_secret_envelope_check CHECK (
    CASE
      WHEN octet_length(encrypted_value) < 94 THEN false
      WHEN get_byte(encrypted_value, 0) <> 1 THEN false
      WHEN get_byte(encrypted_value, 1) NOT BETWEEN 1 AND 32 THEN false
      WHEN get_byte(encrypted_value, 2 + get_byte(encrypted_value, 1)) * 256
           + get_byte(encrypted_value, 3 + get_byte(encrypted_value, 1)) = 0 THEN false
      WHEN octet_length(encrypted_value) - (4 + get_byte(encrypted_value, 1)
           + get_byte(encrypted_value, 2 + get_byte(encrypted_value, 1)) * 256
           + get_byte(encrypted_value, 3 + get_byte(encrypted_value, 1)) + 12 + 16) NOT BETWEEN 1 AND 16384 THEN false
      ELSE substring(encrypted_value FROM 3 FOR get_byte(encrypted_value, 1)) = convert_to(key_id, 'UTF8')
    END),
  CONSTRAINT connection_secret_organization_id_brand_id_connection_id_fkey
    FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE
);
CREATE INDEX connection_secret_organization_id_brand_id_connection_id_idx
  ON connection_secret (organization_id, brand_id, connection_id);
CREATE INDEX connection_secret_key_id_idx ON connection_secret (key_id);
CREATE TRIGGER connection_secret_set_updated_at_trg BEFORE UPDATE ON connection_secret
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

COMMIT;
