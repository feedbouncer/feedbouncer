-- Reverse every statement in migration.sql, in reverse order. No IF EXISTS:
-- an unexpected state must fail loudly. Runs inside migrate:down's transaction.
SET LOCAL lock_timeout = '10s';

-- Revoke before narrowing, so a rollback never widens a key's permissions unnoticed.
UPDATE api_key SET revoked_at = coalesce(revoked_at, now()) WHERE scope = 'moderate';
UPDATE api_key SET scope = 'read' WHERE scope = 'moderate';
ALTER TABLE api_key DROP CONSTRAINT api_key_scope_check,
  ADD CONSTRAINT api_key_scope_check CHECK (scope IN ('read', 'write'));
