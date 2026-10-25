import { describe, expect, it } from 'vitest';
import { EXTERNAL_REF, JobError, JobRegistry, type JobContext } from '@feedbouncer/jobs';
import {
  DISCOVERY_JOB,
  EXECUTE_JOB,
  INGEST_JOB,
  LIFECYCLE_JOB,
  POLL_JOB,
  TIKTOK_ADS_POLL_JOB,
  TIKTOK_POLL_JOB,
  YOUTUBE_CYCLE_JOB,
  enqueueOnly,
  type IngestPayload,
} from './specs.js';
import { ingestCommentJob } from './ingest.js';

const p = (over: Partial<IngestPayload> = {}): IngestPayload => ({
  sourceExternalId: '900_1',
  commentExternalId: '900_1_7',
  event: 'created',
  platformEventSec: 1_760_000_000,
  changeId: '0123456789abcdef',
  ...over,
});

describe('INGEST_JOB', () => {
  it('keys created/deleted by comment and edits by event time and change', () => {
    expect(INGEST_JOB.externalRef(p())).toBe('900_1_7:created');
    expect(INGEST_JOB.externalRef(p({ event: 'deleted' }))).toBe('900_1_7:deleted');
    expect(INGEST_JOB.externalRef(p({ event: 'updated', platformEventSec: 1_760_000_123 }))).toBe(
      '900_1_7:updated:1760000123:0123456789abcdef',
    );
  });

  it('keeps two edits in the same second distinct', () => {
    const hide = p({ event: 'updated', changeId: 'aaaaaaaaaaaaaaaa' });
    const unhide = p({ event: 'updated', changeId: 'bbbbbbbbbbbbbbbb' });
    expect(INGEST_JOB.externalRef(hide)).not.toBe(INGEST_JOB.externalRef(unhide));
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
      p({ changeId: 'not-hex' }),
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

describe('EXECUTE_JOB', () => {
  const id = '6f1c2a4e-8d2b-4c3a-9b1e-0a1b2c3d4e5f';

  it('keys a run by its action', () => {
    expect(EXECUTE_JOB.externalRef({ actionId: id })).toBe(`action:${id}`);
    expect(EXTERNAL_REF.test(EXECUTE_JOB.externalRef({ actionId: id }))).toBe(true);
  });

  it('accepts only an action id', () => {
    expect(EXECUTE_JOB.payload.parse({ actionId: id })).toEqual({ actionId: id });
    for (const bad of [{}, { actionId: 'x' }, { actionId: id, text: 'hi' }, { actionId: 1 }])
      expect(EXECUTE_JOB.payload.safeParse(bad).success).toBe(false);
  });

  it('registers under a snake_case type with 8 attempts', () => {
    expect(EXECUTE_JOB.policy).toEqual({ maxAttempts: 8 });
    const r = new JobRegistry();
    r.register(enqueueOnly(EXECUTE_JOB));
    expect(r.supports(EXECUTE_JOB.type, 'facebook')).toBe(true);
  });
});

describe('LIFECYCLE_JOB', () => {
  const nonce = '6f1c2a4e-8d2b-4c3a-9b1e-0a1b2c3d4e5f:42';

  it('keys a run by operation and (re)connect event', () => {
    expect(LIFECYCLE_JOB.externalRef({ op: 'setup', nonce })).toBe(`setup:${nonce}`);
    expect(LIFECYCLE_JOB.externalRef({ op: 'teardown', nonce })).toBe(`teardown:${nonce}`);
    expect(EXTERNAL_REF.test(LIFECYCLE_JOB.externalRef({ op: 'teardown', nonce }))).toBe(true);
  });

  it('accepts only a connection id and audit sequence as nonce', () => {
    expect(LIFECYCLE_JOB.payload.parse({ op: 'setup', nonce })).toEqual({ op: 'setup', nonce });
    for (const bad of [
      { op: 'setup' },
      { op: 'refresh', nonce },
      { op: 'setup', nonce: '6f1c2a4e-8d2b-4c3a-9b1e-0a1b2c3d4e5f' },
      { op: 'setup', nonce: '6f1c2a4e-8d2b-4c3a-9b1e-0a1b2c3d4e5f:x' },
      { op: 'setup', nonce: '../x:1' },
      { op: 'setup', nonce, extra: 1 },
    ])
      expect(LIFECYCLE_JOB.payload.safeParse(bad).success).toBe(false);
  });

  it('registers under a snake_case type with 6 attempts', () => {
    expect(LIFECYCLE_JOB.policy).toEqual({ maxAttempts: 6 });
    const r = new JobRegistry();
    r.register(enqueueOnly(LIFECYCLE_JOB));
    expect(r.supports(LIFECYCLE_JOB.type, 'facebook')).toBe(true);
  });
});

describe('job definitions', () => {
  it('enqueueOnly keeps type, payload, key and policy and refuses to run', async () => {
    const def = enqueueOnly(INGEST_JOB);
    expect(def).toMatchObject({
      type: INGEST_JOB.type,
      platforms: ['facebook', 'instagram', 'youtube'],
      policy: { maxAttempts: 8 },
    });
    expect(def.payload).toBe(INGEST_JOB.payload);
    expect(def.externalRef(p())).toBe('900_1_7:created');
    const err = await def.handle({} as JobContext, p()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobError);
    expect(err).toMatchObject({ kind: 'non_retryable', code: 'not_a_worker' });
  });

  it('ingest and execute run for facebook and instagram, and ingest also for youtube', () => {
    const r = new JobRegistry();
    r.register(enqueueOnly(INGEST_JOB));
    r.register(enqueueOnly(EXECUTE_JOB));
    for (const type of [INGEST_JOB.type, EXECUTE_JOB.type]) {
      expect(r.supports(type, 'facebook')).toBe(true);
      expect(r.supports(type, 'instagram')).toBe(true);
      expect(r.supports(type, 'threads')).toBe(false);
    }
    // YouTube actions go through the budgeted backlog, never the per-action job.
    expect(r.supports(INGEST_JOB.type, 'youtube')).toBe(true);
    expect(r.supports(EXECUTE_JOB.type, 'youtube')).toBe(false);
  });

  it('youtube_cycle is registered for youtube only', () => {
    const r = new JobRegistry();
    r.register(enqueueOnly(YOUTUBE_CYCLE_JOB));
    expect(r.supports('youtube_cycle', 'youtube')).toBe(true);
    expect(r.supports('youtube_cycle', 'tiktok')).toBe(false);
    expect(YOUTUBE_CYCLE_JOB.externalRef({ connectionId: 'c' })).toBe('youtube_cycle:c');
  });

  it('enqueueOnly carries the lane so the API enqueues on the lane queue', () => {
    const r = new JobRegistry();
    r.register(enqueueOnly({ ...INGEST_JOB, lane: 'classify' }));
    expect(r.laneOf()(INGEST_JOB.type)).toBe('classify');
    expect(enqueueOnly(INGEST_JOB)).not.toHaveProperty('lane');
  });

  it('enqueueOnly takes its platforms from the spec', () => {
    expect(enqueueOnly({ ...INGEST_JOB, platforms: ['threads'] }).platforms).toEqual(['threads']);
    expect(enqueueOnly({ ...INGEST_JOB, platforms: 'all' }).platforms).toBe('all');
  });

  it('both definitions register (job type names are snake_case)', () => {
    const r = new JobRegistry();
    r.register(enqueueOnly(INGEST_JOB));
    const w = new JobRegistry();
    w.register(ingestCommentJob({} as Parameters<typeof ingestCommentJob>[0]));
    expect(w.supports(INGEST_JOB.type, 'facebook')).toBe(true);
    expect(w.supports(INGEST_JOB.type, 'threads')).toBe(false);
  });
});

describe('DISCOVERY_JOB', () => {
  it('keys a run by its bucket', () => {
    expect(DISCOVERY_JOB.externalRef({ bucket: 42 })).toBe('discover:42');
  });

  it('rejects extra keys and negative buckets', () => {
    expect(DISCOVERY_JOB.payload.safeParse({ bucket: 1 }).success).toBe(true);
    expect(DISCOVERY_JOB.payload.safeParse({ bucket: 1, extra: 1 }).success).toBe(false);
    expect(DISCOVERY_JOB.payload.safeParse({ bucket: -1 }).success).toBe(false);
  });
});

describe('POLL_JOB', () => {
  it('keys a run by its bucket on the facebook and instagram platforms', () => {
    expect(POLL_JOB.externalRef({ bucket: 7 })).toBe('ad_poll:7');
    expect(POLL_JOB.platforms).toEqual(['facebook', 'instagram']);
    expect(POLL_JOB.payload.safeParse({ bucket: 1, extra: 1 }).success).toBe(false);
  });
});

describe('TikTok poll jobs', () => {
  const connectionId = '6f1c2a4e-8d2b-4c3a-9b1e-0a1b2c3d4e5f';

  it('tiktok jobs are registered for their own platform only', () => {
    expect(TIKTOK_POLL_JOB).toMatchObject({ type: 'tiktok_poll', platforms: ['tiktok'] });
    expect(TIKTOK_ADS_POLL_JOB).toMatchObject({
      type: 'tiktok_ads_poll',
      platforms: ['tiktok_ads'],
    });
    const r = new JobRegistry();
    r.register(enqueueOnly(TIKTOK_POLL_JOB));
    r.register(enqueueOnly(TIKTOK_ADS_POLL_JOB));
    expect(r.supports('tiktok_poll', 'tiktok')).toBe(true);
    expect(r.supports('tiktok_poll', 'tiktok_ads')).toBe(false);
    expect(r.supports('tiktok_ads_poll', 'tiktok_ads')).toBe(true);
    expect(r.supports('tiktok_ads_poll', 'tiktok')).toBe(false);
    expect(r.supports('tiktok_poll', 'facebook')).toBe(false);
  });

  it('accept only a connection id and key a run by it', () => {
    for (const spec of [TIKTOK_POLL_JOB, TIKTOK_ADS_POLL_JOB]) {
      expect(spec.payload.parse({ connectionId })).toEqual({ connectionId });
      for (const bad of [{}, { connectionId: 'x' }, { connectionId, bucket: 1 }])
        expect(spec.payload.safeParse(bad).success).toBe(false);
      expect(EXTERNAL_REF.test(spec.externalRef({ connectionId }))).toBe(true);
    }
  });

  it('EXECUTE_JOB includes both TikTok platforms', () => {
    expect(EXECUTE_JOB.platforms).toEqual(['facebook', 'instagram', 'tiktok', 'tiktok_ads']);
  });
});
