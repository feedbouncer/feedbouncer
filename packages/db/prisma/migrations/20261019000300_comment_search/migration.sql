-- Forward migration. Keep everything between BEGIN; and COMMIT;: Prisma runs this
-- file statement by statement, so the explicit transaction is what makes it atomic.
-- Never use CREATE INDEX CONCURRENTLY here. State ON DELETE on every REFERENCES.
-- Conventions: packages/db/README.md
BEGIN;
SET LOCAL lock_timeout = '10s';

-- Trigram indexes serve the case-insensitive substring search on comment text and author name.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX comment_body_trgm_idx ON comment USING gin (body gin_trgm_ops);
CREATE INDEX author_display_name_trgm_idx ON author USING gin (display_name gin_trgm_ops);

COMMIT;
