-- Reverse every statement in migration.sql, in reverse order. No IF EXISTS:
-- an unexpected state must fail loudly. Runs inside migrate:down's transaction.

DROP TABLE connection_backfill;
ALTER TABLE comment DROP CONSTRAINT comment_ingest_origin_check;
ALTER TABLE comment DROP COLUMN ingest_origin;
