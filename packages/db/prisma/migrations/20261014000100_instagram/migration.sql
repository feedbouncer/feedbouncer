BEGIN;
SET LOCAL lock_timeout = '10s';

-- Meta allows one app subscription per Instagram account, so at most one live
-- FeedBouncer connection may own an Instagram account across all tenants.
-- Disconnected (revoked) rows keep their history and do not count.
CREATE UNIQUE INDEX connection_instagram_live_external_account_id_key
  ON connection (external_account_id)
  WHERE platform = 'instagram' AND status <> 'revoked';

COMMIT;
