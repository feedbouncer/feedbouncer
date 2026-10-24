import type { CommentRow } from '@feedbouncer/comments';
import { createFacebookConnector } from '@feedbouncer/connector-facebook';
import type { ConnectorCapabilities } from '@feedbouncer/connectors';
import { describe, expect, it } from 'vitest';
import { StepPlanner } from './planner.js';
import type { BrandConnectionInfo } from './support.js';

const fbCaps = createFacebookConnector({} as never).capabilities;
/** TikTok organic: hide, unhide and public replies; no delete. */
const tiktokCaps: ConnectorCapabilities = {
  ...fbCaps,
  actions: ['hide', 'unhide'],
  responses: ['public_reply'],
  actionScopes: {
    hide: ['comment.list.manage'],
    unhide: ['comment.list.manage'],
    public_reply: ['comment.list.manage'],
  },
};
const tiktok = (grantedScopes: readonly string[]): BrandConnectionInfo => ({
  connectionId: 'c-tt',
  platform: 'tiktok',
  grantedScopes,
  caps: tiktokCaps,
});
const comment = { id: 'c1', isOwnAccount: false, platformState: 'visible' } as CommentRow;
const scope = { organizationId: 'o', brandId: 'b', connectionId: 'c-tt' };

const planner = (conn: BrandConnectionInfo) =>
  new StepPlanner({
    runs: {
      hasUserReversal: async () => false,
      hasAutomatedThreadReply: async () => false,
      hasActiveBan: async () => false,
    },
    comments: { load: async () => comment },
    actions: { list: async () => [] },
    connection: async () => conn,
    brandName: async () => 'Shop',
    clock: { now: () => 0 },
  });

describe('StepPlanner.precheck', () => {
  it('a delete step on a platform without delete flags the comment for review with action_not_supported:tiktok:delete and performs no other action', async () => {
    const conn = tiktok(['comment.list', 'comment.list.manage']);
    const p = planner(conn);
    expect(await p.precheck(scope, 'delete', comment, conn, [])).toEqual({
      status: 'not_supported',
      reason: 'unsupported',
    });
    const sim = await p.simulate(scope, comment.id, [
      { type: 'delete', confirmIrreversible: true },
    ]);
    expect(sim.map((s) => [s.type, s.status])).toEqual([['delete', 'not_supported']]);
  });

  it('a hide step without comment.list.manage flags for review with missing_permission:comment.list.manage', async () => {
    const conn = tiktok(['comment.list']);
    expect(await planner(conn).precheck(scope, 'hide', comment, conn, [])).toEqual({
      status: 'failed',
      reason: 'missing_permission',
      missingScopes: ['comment.list.manage'],
    });
  });
});
