import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  orgWithRoles,
  startTestApi,
  verifiedUser,
  type OrgFixture,
  type TestApi,
} from '../testing/harness.js';

let api: TestApi;
let org: OrgFixture;

beforeAll(async () => {
  api = await startTestApi({
    alerts: { slack: true, email: true, capPerHour: 30, emailPerMinute: 60 },
  });
  const [owner, admin, member] = await Promise.all(
    ['ts-owner', 'ts-admin', 'ts-member'].map((n) => verifiedUser(api, n)),
  );
  org = await orgWithRoles(api, 'tsA', { owner: owner!, admin: admin!, member: member! });
});
afterAll(() => api.close());

describe('email test sends', () => {
  it('spend the same per-address budget as confirmation mails', async () => {
    const base = `/api/v1/orgs/${org.orgId}/alert-channels`;
    const created = await api.req('POST', `${base}/email`, {
      cookie: org.admin.cookie,
      body: { email: `probe-${randomUUID().slice(0, 6)}@alerts.test` },
    });
    expect(created.status).toBe(201);
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await api.req('POST', `${base}/${created.body.channel.id}/test`, {
        cookie: org.admin.cookie,
      });
      codes.push(r.status);
    }
    expect(codes).toEqual([200, 200, 429]);
  });
});
