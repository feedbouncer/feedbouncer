import { describe, expect, it, vi } from 'vitest';
import type { PgConnectorStack } from '@feedbouncer/connectors';
import type { JobProducer } from '@feedbouncer/jobs';
import type { AppDeps } from '../deps.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { ConnectionsService } from './connections.service.js';

const org: OrgContext = {
  organizationId: '22222222-2222-4222-8222-222222222222',
  actorUserId: '11111111-1111-4111-8111-111111111111',
  role: 'owner',
};
const brandId = '33333333-3333-4333-8333-333333333333';
const connectionId = '44444444-4444-4444-8444-444444444444';

/** The row as it stands after `directory.disconnect` returned `disconnected`. */
function setup(disconnected: boolean, row: { status: string; status_reason: string | null }) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM brand')) return { rowCount: 1, rows: [{}] };
    if (sql.includes('FROM connection')) return { rowCount: 1, rows: [row] };
    if (sql.includes('FROM audit_event')) return { rowCount: 1, rows: [{ sequence: '7' }] };
    throw new Error(`unexpected query: ${sql}`);
  });
  const stack = {
    directory: {
      load: async () => ({ platform: 'facebook', status: row.status }),
      disconnect: async () => disconnected,
    },
  } as unknown as PgConnectorStack;
  const enqueue = vi.fn(async () => undefined);
  const deps = { pool: { query }, log: { error: vi.fn() } } as unknown as AppDeps;
  const svc = new ConnectionsService(deps, stack, { enqueue } as unknown as JobProducer);
  return { svc, enqueue };
}

describe('ConnectionsService.disconnect', () => {
  it('queues the teardown when this call disconnected the row', async () => {
    const { svc, enqueue } = setup(true, { status: 'revoked', status_reason: 'user_disconnected' });
    await svc.disconnect(org, brandId, connectionId);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('re-queues the teardown for a row the user already disconnected (retry after a 503)', async () => {
    const { svc, enqueue } = setup(false, { status: 'revoked', status_reason: 'user_disconnected' });
    await svc.disconnect(org, brandId, connectionId);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 'active', status_reason: null },
    { status: 'reconnect_required', status_reason: 'oauth_pending' },
    { status: 'revoked', status_reason: null },
  ])('never queues a teardown for a row it did not disconnect ($status)', async (row) => {
    const { svc, enqueue } = setup(false, row);
    await svc.disconnect(org, brandId, connectionId);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
