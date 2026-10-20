import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkerConnection } from '@feedbouncer/jobs';
import {
  PRIVACY_QUEUE,
  PgPrivacyRequestStore,
  PrivacyJobData,
  processPrivacyRequest,
  publishRetentionStatus,
  loadRetentionSettings,
} from '@feedbouncer/privacy';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';

const SUBJECT_ID = 'psid-subject-8841';
const SUBJECT_HANDLE = 'zed.subject';
const SUBJECT_NAME = 'Zed Subjectson';

let api: TestApi;
let dir: string;
let consumer: Worker;
let consumerRedis: ReturnType<typeof createWorkerConnection>;
let A: OrgFixture;
let B: OrgFixture;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'fb-api-privacy-'));
  api = await startTestApi({ privacyExportDir: dir });
  const store = new PgPrivacyRequestStore(api.pool, api.deps.env.encryption);
  consumerRedis = createWorkerConnection(api.deps.env.redisUrl.href);
  consumer = new Worker(
    PRIVACY_QUEUE,
    (job) =>
      processPrivacyRequest(
        {
          store,
          pool: api.pool,
          exportDir: dir,
          exportTtlHours: 1,
          batchSize: 100,
          log: api.deps.log,
        },
        PrivacyJobData.parse(job.data).requestId,
        { finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1) },
      ),
    { connection: consumerRedis, prefix: api.deps.env.jobs.prefix },
  );
  A = await orgWithRoles(api, 'pa');
  B = await orgWithRoles(api, 'pb');
  const conn = await api.seedFacebookConnection(A);
  await api.pool.query(
    `INSERT INTO author (organization_id, brand_id, connection_id, external_id, display_name)
     VALUES ($1, $2, $3, $4, $5)`,
    [A.orgId, A.brandId, conn.scope.connectionId, SUBJECT_ID, SUBJECT_NAME],
  );
});
afterAll(async () => {
  await consumer.close();
  consumerRedis.disconnect();
  await api.close();
  await rm(dir, { recursive: true, force: true });
});

const base = (orgId: string) => `/api/v1/orgs/${orgId}/privacy`;
const subjects = [{ platform: 'facebook', externalId: SUBJECT_ID, handle: SUBJECT_HANDLE }];
const post = (org: OrgFixture, cookie: string, body: unknown) =>
  api.req('POST', `${base(org.orgId)}/requests`, { cookie, body });

async function untilDone(org: OrgFixture, cookie: string, id: string) {
  const end = Date.now() + 20_000;
  for (;;) {
    const r = await api.req('GET', `${base(org.orgId)}/requests/${id}`, { cookie });
    if (r.status !== 200 || ['done', 'failed'].includes(r.body.status)) return r;
    if (Date.now() > end) throw new Error('request did not finish');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const auditCount = async (orgId: string, action: string) =>
  Number(
    (
      await api.pool.query<{ n: string }>(
        'SELECT count(*) AS n FROM audit_event WHERE organization_id = $1 AND action = $2',
        [orgId, action],
      )
    ).rows[0]!.n,
  );

describe('privacy admin API', () => {
  it('owner runs an erasure dry run; the view carries counts and never the subjects', async () => {
    const r = await post(A, A.owner.cookie, { kind: 'erasure', dryRun: true, subjects });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ id: expect.any(String), status: 'queued' });
    const done = await untilDone(A, A.owner.cookie, r.body.id);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      kind: 'erasure',
      mode: 'dry_run',
      status: 'done',
      requestedVia: 'api',
      actorUserId: A.owner.userId,
      found: true,
      exportAvailable: false,
    });
    expect(done.body.counts).toBeTypeOf('object');
    const list = await api.req('GET', `${base(A.orgId)}/requests?limit=5`, {
      cookie: A.owner.cookie,
    });
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { id: string }) => i.id)).toContain(r.body.id);
    for (const text of [JSON.stringify(done.body), JSON.stringify(list.body)]) {
      for (const secret of [SUBJECT_ID, SUBJECT_HANDLE, SUBJECT_NAME, 'subjects'])
        expect(text).not.toContain(secret);
    }
  });

  it('admin exports and downloads a zip whose hash matches the recorded one', async () => {
    const r = await post(A, A.admin.cookie, { kind: 'export', subjects });
    expect(r.status).toBe(202);
    const done = await untilDone(A, A.admin.cookie, r.body.id);
    expect(done.body).toMatchObject({ status: 'done', found: true, exportAvailable: true });
    const dl = await api.app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: `${base(A.orgId)}/requests/${r.body.id}/export`,
        headers: { cookie: A.admin.cookie },
      });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/zip');
    expect(dl.headers['content-disposition']).toBe(
      `attachment; filename="feedbouncer-export-${r.body.id}.zip"`,
    );
    expect(dl.headers['cache-control']).toBe('no-store');
    const { rows } = await api.pool.query<{ export_sha256: Buffer }>(
      'SELECT export_sha256 FROM privacy_request WHERE id = $1',
      [r.body.id],
    );
    expect(createHash('sha256').update(dl.rawPayload).digest()).toEqual(rows[0]!.export_sha256);
    expect(await auditCount(A.orgId, 'privacy.export_downloaded')).toBeGreaterThan(0);
  });

  it('a member is refused, the denial is audited and logged, and nothing is queued', async () => {
    const before = await auditCount(A.orgId, 'privacy.access_denied');
    const attempts = [
      post(A, A.member.cookie, { kind: 'export', subjects }),
      api.req('GET', `${base(A.orgId)}/retention`, { cookie: A.member.cookie }),
      api.req('GET', `${base(A.orgId)}/requests/${randomUUID()}/export`, {
        cookie: A.member.cookie,
      }),
    ];
    for (const r of await Promise.all(attempts)) {
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('forbidden');
    }
    expect(await auditCount(A.orgId, 'privacy.access_denied')).toBe(before + 3);
    const { rows } = await api.pool.query(
      "SELECT details FROM audit_event WHERE organization_id = $1 AND action = 'privacy.access_denied'",
      [A.orgId],
    );
    const text = JSON.stringify(rows);
    expect(text).toContain('privacy.read');
    expect(text).toContain('privacy.export');
    for (const secret of [SUBJECT_ID, SUBJECT_HANDLE, A.member.email]) {
      expect(text).not.toContain(secret);
    }
    expect(api.logLines.some((l) => l.includes('privacy.access_denied'))).toBe(true);
    const requests = await api.pool.query(
      'SELECT 1 FROM privacy_request WHERE actor_user_id = $1',
      [A.member.userId],
    );
    expect(requests.rowCount).toBe(0);
  });

  it('a non-member gets 404 and leaves no audit row in the target org', async () => {
    const before = await auditCount(A.orgId, 'privacy.access_denied');
    for (const [method, url, body] of [
      ['GET', `${base(A.orgId)}/retention`, undefined],
      ['GET', `${base(A.orgId)}/requests`, undefined],
      ['POST', `${base(A.orgId)}/requests`, { kind: 'export', subjects }],
    ] as const) {
      const r = await api.req(method, url, { cookie: B.owner.cookie, body });
      expect(r.status, url).toBe(404);
    }
    expect(await auditCount(A.orgId, 'privacy.access_denied')).toBe(before);
  });

  it('keeps tenants apart on every download path', async () => {
    const exp = await post(B, B.owner.cookie, { kind: 'export', subjects });
    await untilDone(B, B.owner.cookie, exp.body.id);
    const get = (orgId: string, id: string, cookie: string) =>
      api.req('GET', `${base(orgId)}/requests/${id}/export`, { cookie });
    expect((await get(B.orgId, exp.body.id, B.owner.cookie)).status).toBe(200);
    // org A's owner: under A's path the id is not A's; under B's path A's owner is no member.
    expect((await get(A.orgId, exp.body.id, A.owner.cookie)).status).toBe(404);
    expect((await get(B.orgId, exp.body.id, A.owner.cookie)).status).toBe(404);
    const view = await api.req('GET', `${base(A.orgId)}/requests/${exp.body.id}`, {
      cookie: A.owner.cookie,
    });
    expect(view.status).toBe(404);

    const bodies = new Set<string>();
    for (const id of [
      '../../etc/passwd',
      '%2e%2e%2fsecret',
      '00000000-0000-0000-0000-000000000000',
    ]) {
      const r = await get(A.orgId, id, A.owner.cookie);
      expect(r.status, id).toBe(404);
      bodies.add(JSON.stringify(r.body));
    }
    bodies.add(JSON.stringify((await get(A.orgId, exp.body.id, A.owner.cookie)).body));
    expect(bodies.size).toBe(1);
  });

  it('serves nothing once an export has expired, is not an export, or left the export directory', async () => {
    const exp = await post(A, A.owner.cookie, { kind: 'export', subjects });
    await untilDone(A, A.owner.cookie, exp.body.id);
    const url = `${base(A.orgId)}/requests/${exp.body.id}/export`;
    const get = () => api.req('GET', url, { cookie: A.owner.cookie });
    const expected = JSON.stringify(
      (
        await api.req('GET', `${base(A.orgId)}/requests/${randomUUID()}/export`, {
          cookie: A.owner.cookie,
        })
      ).body,
    );

    // A symlink pointing out of the export directory is refused.
    const outside = path.join(await mkdtemp(path.join(tmpdir(), 'fb-outside-')), 'secret.zip');
    await writeFile(outside, 'not an export');
    const file = path.join(dir, `${exp.body.id}.zip`);
    const kept = `${file}.kept`;
    await rename(file, kept);
    await symlink(outside, file);
    const escaped = await get();
    expect(escaped.status).toBe(404);
    expect(JSON.stringify(escaped.body)).toBe(expected);
    await rm(file);
    await rename(kept, file);
    expect((await get()).status).toBe(200);

    // Expired.
    await api.pool.query(
      "UPDATE privacy_request SET export_expires_at = now() - interval '1 second' WHERE id = $1",
      [exp.body.id],
    );
    const expired = await get();
    expect(expired.status).toBe(404);
    expect(JSON.stringify(expired.body)).toBe(expected);
    const view = await api.req('GET', `${base(A.orgId)}/requests/${exp.body.id}`, {
      cookie: A.owner.cookie,
    });
    expect(view.body.exportAvailable).toBe(false);

    // A finished erasure has no export.
    const er = await post(A, A.owner.cookie, { kind: 'erasure', dryRun: true, subjects });
    await untilDone(A, A.owner.cookie, er.body.id);
    const notExport = await api.req('GET', `${base(A.orgId)}/requests/${er.body.id}/export`, {
      cookie: A.owner.cookie,
    });
    expect(notExport.status).toBe(404);
    expect(JSON.stringify(notExport.body)).toBe(expected);
    await rm(path.dirname(outside), { recursive: true, force: true });
    expect((await readdir(dir)).every((f) => f.endsWith('.zip'))).toBe(true);
  });

  it('validates the request strictly', async () => {
    const ok = { kind: 'erasure', dryRun: true, subjects };
    const bad: unknown[] = [
      { ...ok, subjects: Array.from({ length: 21 }, () => subjects[0]) },
      { ...ok, subjects: [] },
      { ...ok, unknown: 1 },
      { ...ok, subjects: [{ platform: 'facebook', externalId: 'a\nb' }] },
      { ...ok, subjects: [{ platform: 'facebook', externalId: 'a', extra: 1 }] },
      { ...ok, subjects: [{ platform: 'facebook' }] },
      { ...ok, subjects: [{ platform: 'nope', externalId: 'a' }] },
      { kind: 'export', subjects, keepRuleEntries: { reason: 'legal hold' } },
      { ...ok, keepRuleEntries: { reason: '' } },
      { ...ok, keepRuleEntries: { reason: 'x', other: 1 } },
      { ...ok, reference: 'a b' },
      { ...ok, dryRun: 'yes' },
      { kind: 'other', subjects },
    ];
    for (const body of bad) {
      const r = await post(A, A.owner.cookie, body);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(r.body.error.code).toBe('invalid_request');
      expect(JSON.stringify(r.body)).not.toContain(SUBJECT_ID);
    }
    const accepted = await post(A, A.owner.cookie, {
      ...ok,
      reference: 'TICKET-42',
      keepRuleEntries: { reason: 'litigation hold 7' },
    });
    expect(accepted.status).toBe(202);
    const list = await api.req('GET', `${base(A.orgId)}/requests?limit=0`, {
      cookie: A.owner.cookie,
    });
    expect(list.status).toBe(400);
  });

  it('pages the list newest first', async () => {
    const all = await api.req('GET', `${base(A.orgId)}/requests?limit=100`, {
      cookie: A.owner.cookie,
    });
    const ids = all.body.items.map((i: { id: string }) => i.id);
    expect(ids.length).toBeGreaterThan(2);
    const page = await api.req('GET', `${base(A.orgId)}/requests?limit=2&before=${ids[1]}`, {
      cookie: A.owner.cookie,
    });
    expect(page.body.items.map((i: { id: string }) => i.id)).toEqual(ids.slice(2, 4));
    const foreign = await api.req('GET', `${base(B.orgId)}/requests?before=${ids[0]}`, {
      cookie: B.owner.cookie,
    });
    expect(foreign.body.items.map((i: { id: string }) => i.id)).not.toContain(ids[0]);
  });

  it('an unknown identifier finishes as found=false with zero counts, not as an error', async () => {
    const r = await post(A, A.owner.cookie, {
      kind: 'erasure',
      subjects: [{ platform: 'facebook', externalId: 'nobody-here' }],
    });
    const done = await untilDone(A, A.owner.cookie, r.body.id);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'done', found: false });
    expect(Object.values(done.body.counts).every((n) => n === 0)).toBe(true);
  });

  it('shows the retention status the worker published', async () => {
    await publishRetentionStatus(
      api.pool,
      loadRetentionSettings({ RETENTION_COMMENTS_DAYS: '30' }),
    );
    const r = await api.req('GET', `${base(A.orgId)}/retention`, { cookie: A.admin.cookie });
    expect(r.status).toBe(200);
    expect(r.body.settings.days.comments).toBe(30);
    expect(r.body.effective.comments).toBe(30);
    expect(r.body.warnings).toContain('decisions_capped_by_comments');
    expect(Object.keys(r.body).sort()).toEqual(
      ['effective', 'lastRun', 'settings', 'updatedAt', 'warnings'].sort(),
    );
  });

  it('never logs an identifier', () => {
    const logs = api.logLines.join('\n');
    for (const secret of [SUBJECT_ID, SUBJECT_HANDLE, SUBJECT_NAME]) {
      expect(logs).not.toContain(secret);
    }
  });
});

describe('separation of duties', () => {
  const root = new URL('.', import.meta.url);
  const sources = async () => {
    const names = (await readdir(root)).filter((f) => f.endsWith('.ts') && !f.includes('.test.'));
    return Promise.all(names.map(async (f) => [f, await readFile(new URL(f, root), 'utf8')]));
  };

  it('the API code never erases, writes exports or opens sealed subjects', async () => {
    const files = await sources();
    expect(files.length).toBeGreaterThan(2);
    for (const [name, text] of files as [string, string][]) {
      expect(text, name).not.toMatch(/\b(eraseSubject|writeSubjectExport)\b/);
      expect(text, name).not.toMatch(/\bopen\s*\(|\bopen\b[^;]*from '@feedbouncer\/secrets'/);
      expect(text, name).not.toMatch(/@feedbouncer\/classifier/);
    }
  });

  it('the API package keeps its dependency list apart from the privacy package', async () => {
    const pkg = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).toContain('@feedbouncer/privacy');
    expect(
      Object.keys(pkg.dependencies).filter((d) => d.startsWith('@feedbouncer/classifier')),
    ).toEqual(['@feedbouncer/classifier']);
  });
});
