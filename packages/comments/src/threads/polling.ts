// Poll state of Threads connections: one source_poll row per post and one
// threads_pending_reply row per reply a webhook announced that no pass has read
// yet. Every statement is filtered by organization_id + brand_id + connection_id.
import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { upsertListedSource } from '../store.js';

const ids = (s: ConnectionScope) => [s.organizationId, s.brandId, s.connectionId];

export interface ThreadsWake {
  /** The root post the reply belongs to. */
  readonly sourceExternalId: string;
  readonly replyExternalId: string;
  readonly receivedAt: Date;
}

export class PgThreadsPolling {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * A webhook said a post has a new reply. Upserts the post (kind 'thread') and its
   * source_poll row with next_poll_at = LEAST(next_poll_at, receivedAt), and the pending
   * reply, in one transaction. A post already found to belong to another account gets no
   * pending row: nothing will ever read it.
   */
  async recordWake(scope: ConnectionScope, w: ThreadsWake): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      const sourceId = await upsertListedSource(tx, scope, w.sourceExternalId, 'thread');
      const poll = await tx.query<{ owner_verified: boolean | null }>(
        `INSERT INTO source_poll (source_id, organization_id, brand_id, connection_id, next_poll_at)
         VALUES ($4, $1, $2, $3, $5)
         ON CONFLICT (source_id) DO UPDATE
           SET next_poll_at = LEAST(source_poll.next_poll_at, EXCLUDED.next_poll_at)
           WHERE source_poll.organization_id = $1 AND source_poll.brand_id = $2
             AND source_poll.connection_id = $3
         RETURNING owner_verified`,
        [...ids(scope), sourceId, w.receivedAt],
      );
      if (!poll.rows[0]) throw new Error('threads polling: source is not in the given scope');
      if (poll.rows[0].owner_verified === false) return;
      await tx.query(
        `INSERT INTO threads_pending_reply
           (organization_id, brand_id, connection_id, external_id, source_external_id, received_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (connection_id, external_id) DO NOTHING`,
        [...ids(scope), w.replyExternalId, w.sourceExternalId, w.receivedAt],
      );
    });
  }
}
