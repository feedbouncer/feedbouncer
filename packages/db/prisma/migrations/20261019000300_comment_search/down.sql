-- Reverse every statement in migration.sql, in reverse order. No IF EXISTS:
-- an unexpected state must fail loudly. Runs inside migrate:down's transaction.

DROP INDEX author_display_name_trgm_idx;
DROP INDEX comment_body_trgm_idx;
DROP EXTENSION pg_trgm;
