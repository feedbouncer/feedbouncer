import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Secret } from '@feedbouncer/service-runtime';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from './testing/harness.js';

const YOUTUBE = {
  clientId: '123-abc.apps.googleusercontent.com',
  clientSecret: new Secret('youtube-secret-0123456789'),
  projectDailyQuota: 10_000,
  projectHeadroomUnits: 1000,
  schedulerTickSec: 60,
  backlogCap: 5000,
};

let api: TestApi;
let org: OrgFixture;

beforeAll(async () => {
  api = await startTestApi({ youtube: YOUTUBE });
  org = await orgWithRoles(api, 'yt');
});
afterAll(() => api.close());

describe('buildConnectorDeps with youtube enabled', () => {
  it('registers the connector and can enqueue the cycle job', async () => {
    expect(api.deps.connectors?.registry.platforms()).toEqual(['youtube']);
    const { scope } = await api.seedConnection(org, {
      platform: 'youtube',
      externalAccountId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
    });
    const r = await api.deps.producer!.enqueue({
      scope,
      platform: 'youtube',
      type: 'youtube_cycle',
      payload: { connectionId: scope.connectionId },
    });
    expect(r.status).toBe('enqueued');
  });

  it('dispatches a youtube action to the backlog instead of throwing', async () => {
    const { scope } = await api.seedConnection(org, {
      platform: 'youtube',
      externalAccountId: 'UCbbbbbbbbbbbbbbbbbbbbbb',
    });
    const ids = [scope.organizationId, scope.brandId, scope.connectionId];
    const source = await api.pool.query<{ id: string }>(
      `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
       VALUES ($1, $2, $3, 'video', 'vid1') RETURNING id`,
      ids,
    );
    const comment = await api.pool.query<{ id: string }>(
      `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body,
                            platform_state, posted_at)
       VALUES ($1, $2, $3, $4, 'Ugx1', 'hi', 'visible', now()) RETURNING id`,
      [...ids, source.rows[0]!.id],
    );
    const result = await api.deps.comments!.actions.request({
      scope: { organizationId: scope.organizationId, brandId: scope.brandId },
      commentId: comment.rows[0]!.id,
      kind: 'hide',
      // A person's request is not held back by review mode, which only gates automation.
      actor: { type: 'user', userId: org.owner.userId },
      requestKey: `rk-${randomUUID()}`,
    });
    expect(result).toMatchObject({ status: 'accepted' });
    const queued = await api.pool.query(
      `SELECT 1 FROM youtube_action_queue WHERE connection_id = $1 AND organization_id = $2`,
      [scope.connectionId, scope.organizationId],
    );
    expect(queued.rowCount).toBe(1);
  });
});
