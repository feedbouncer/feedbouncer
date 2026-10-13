import { describe, expect, it } from 'vitest';
import { EXTERNAL_REF, JobError, JobRegistry, type JobContext } from '@feedbouncer/jobs';
import { INGEST_JOB, enqueueOnly, type IngestPayload } from './specs.js';
import { ingestCommentJob } from './ingest.js';

const p = (over: Partial<IngestPayload> = {}): IngestPayload => ({
  sourceExternalId: '900_1',
  commentExternalId: '900_1_7',
  event: 'created',
  platformEventSec: 1_760_000_000,
  ...over,
});

describe('INGEST_JOB', () => {
  it('keys created/deleted by comment and edits by the platform event time', () => {
    expect(INGEST_JOB.externalRef(p())).toBe('900_1_7:created');
    expect(INGEST_JOB.externalRef(p({ event: 'deleted' }))).toBe('900_1_7:deleted');
    expect(INGEST_JOB.externalRef(p({ event: 'updated', platformEventSec: 1_760_000_123 }))).toBe(
      '900_1_7:updated:1760000123',
    );
  });

  it('accepts Graph ids and rejects anything else', () => {
    expect(INGEST_JOB.payload.parse(p())).toEqual(p());
    for (const bad of [
      { ...p(), extra: 1 },
      p({ commentExternalId: '../me' }),
      p({ commentExternalId: '1/2' }),
      p({ commentExternalId: '' }),
      p({ sourceExternalId: 'a b' }),
      p({ commentExternalId: 'a\u0000' }),
      p({ event: 'edited' as never }),
      p({ platformEventSec: 0 }),
      p({ platformEventSec: 1.5 }),
      p({ platformEventSec: 10_000_000_001 }),
    ])
      expect(INGEST_JOB.payload.safeParse(bad).success).toBe(false);
  });

  it('every valid payload yields a valid idempotency ref', () => {
    const long = p({
      event: 'updated',
      commentExternalId: 'x'.repeat(200),
      platformEventSec: 10_000_000_000,
    });
    expect(INGEST_JOB.payload.safeParse(long).success).toBe(true);
    expect(EXTERNAL_REF.test(INGEST_JOB.externalRef(long))).toBe(true);
    expect(
      INGEST_JOB.payload.safeParse({ ...long, commentExternalId: 'x'.repeat(201) }).success,
    ).toBe(false);
  });

  it('retries up to 8 times', () => expect(INGEST_JOB.policy).toEqual({ maxAttempts: 8 }));
});

describe('job definitions', () => {
  it('enqueueOnly keeps type, payload, key and policy and refuses to run', async () => {
    const def = enqueueOnly(INGEST_JOB);
    expect(def).toMatchObject({
      type: INGEST_JOB.type,
      platforms: ['facebook'],
      policy: { maxAttempts: 8 },
    });
    expect(def.payload).toBe(INGEST_JOB.payload);
    expect(def.externalRef(p())).toBe('900_1_7:created');
    const err = await def.handle({} as JobContext, p()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobError);
    expect(err).toMatchObject({ kind: 'non_retryable', code: 'not_a_worker' });
  });

  it('enqueueOnly takes its platforms from the spec', () => {
    expect(enqueueOnly({ ...INGEST_JOB, platforms: ['youtube'] }).platforms).toEqual(['youtube']);
    expect(enqueueOnly({ ...INGEST_JOB, platforms: 'all' }).platforms).toBe('all');
  });

  it('both definitions register (job type names are snake_case)', () => {
    const r = new JobRegistry();
    r.register(enqueueOnly(INGEST_JOB));
    const w = new JobRegistry();
    w.register(ingestCommentJob({} as Parameters<typeof ingestCommentJob>[0]));
    expect(w.supports(INGEST_JOB.type, 'facebook')).toBe(true);
    expect(w.supports(INGEST_JOB.type, 'youtube')).toBe(false);
  });
});
