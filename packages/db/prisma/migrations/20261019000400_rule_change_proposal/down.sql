-- Reverse every statement in migration.sql, in reverse order. No IF EXISTS:
-- an unexpected state must fail loudly. Runs inside migrate:down's transaction.
DROP TABLE rule_change_proposal;
