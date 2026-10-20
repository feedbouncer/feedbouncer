-- Forward migration. Keep everything between BEGIN; and COMMIT;: Prisma runs this
-- file statement by statement, so the explicit transaction is what makes it atomic.
-- Never use CREATE INDEX CONCURRENTLY here. State ON DELETE on every REFERENCES.
-- Conventions: packages/db/README.md
BEGIN;
SET LOCAL lock_timeout = '10s';

-- A key that may only call the moderation check endpoint.
ALTER TABLE api_key DROP CONSTRAINT api_key_scope_check,
  ADD CONSTRAINT api_key_scope_check CHECK (scope IN ('moderate', 'read', 'write'));

COMMIT;
