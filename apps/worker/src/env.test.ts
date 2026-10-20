import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { EnvError } from '@feedbouncer/service-runtime';
import { randomKeyEntry } from '@feedbouncer/secrets/testing';
import { loadWorkerEnv } from './env.js';

const base = {
  FB_ENV: 'production',
  DATABASE_URL: 'postgresql://fb:dev-only-pw@postgres:5432/fb',
  REDIS_URL: 'redis://:dev-only-pw@redis:6379/0',
  FB_ENCRYPTION_KEYS: randomKeyEntry('k1'),
  FB_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
  SMTP_URL: 'smtp://mailpit:1025',
  PUBLIC_WEB_URL: 'https://app.example.com',
};
const facebook = {
  FACEBOOK_APP_ID: '1234567890',
  FACEBOOK_APP_SECRET: 'sentinel-fb-app-secret-0123456789',
  FACEBOOK_WEBHOOK_VERIFY_TOKEN: 'sentinel-fb-verify-token-0123456789',
};
const opts = { warn: () => {} };
const load = (env: Record<string, string | undefined>) => loadWorkerEnv(env, opts);

function without(...names: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(base).filter(([k]) => !names.includes(k)));
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(EnvError);
    return (err as Error).message;
  }
  throw new Error('expected an EnvError');
}

describe('loadWorkerEnv', () => {
  it('reads the webhook delivery settings with defaults', () => {
    expect(load(base).webhookConcurrency).toBe(32);
    expect(load(base).webhookAllowedPrivateCidrs).toEqual([]);
    const env = load({
      ...base,
      WEBHOOK_DISPATCH_CONCURRENCY: '8',
      WEBHOOK_ALLOWED_PRIVATE_CIDRS: '10.0.0.0/8',
    });
    expect(env.webhookConcurrency).toBe(8);
    expect(env.webhookAllowedPrivateCidrs).toEqual(['10.0.0.0/8']);
  });

  it('rejects a malformed webhook setting', () => {
    expect(() => load({ ...base, WEBHOOK_DISPATCH_CONCURRENCY: '0' })).toThrow(/WEBHOOK_DISPATCH/);
    expect(() => load({ ...base, WEBHOOK_ALLOWED_PRIVATE_CIDRS: 'nope' })).toThrow(
      /WEBHOOK_ALLOWED_PRIVATE_CIDRS/,
    );
  });

  it('rejects an invalid LOG_LEVEL', () => {
    expect(() => load({ ...base, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('applies defaults', () => {
    expect(load(base)).toMatchObject({
      appEnv: 'production',
      concurrency: 4,
      healthPort: 3002,
      logLevel: 'info',
    });
    expect(load(base).encryption.activeKeyId).toBe('k1');
  });
  it('loads job queue settings and keeps them in the redacted summary', () => {
    const env = load({ ...base, JOB_CONCURRENCY_FACEBOOK: '3', JOB_DLQ_RETENTION_DAYS: '7' });
    expect(env.jobs.concurrency.facebook).toBe(3);
    expect(env.jobs.dlqRetentionMs).toBe(7 * 86_400_000);
    expect(JSON.stringify(env)).toContain('"jobQueuePrefix":"fb"');
  });
  it('fails fast on an invalid job setting', () => {
    expect(() => load({ ...base, JOB_MAX_ATTEMPTS: '0' })).toThrow(/JOB_MAX_ATTEMPTS/);
  });
  it('loads telemetry config with the worker metrics port default', () => {
    expect(load(base).telemetry.metrics.port).toBe(9465);
    expect(load(base).telemetry.metrics.host).toBe('127.0.0.1');
  });
  it('rejects an invalid OTEL_TRACES_EXPORTER', () => {
    expect(() => load({ ...base, OTEL_TRACES_EXPORTER: 'bogus' })).toThrow(/OTEL_TRACES_EXPORTER/);
  });
  it('never reads OTLP headers into config', () => {
    const env = load({ ...base, OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer s3cret' });
    expect(JSON.stringify(env)).not.toContain('s3cret');
    expect(inspect(env, { depth: 10 })).not.toContain('s3cret');
  });
  it('bounds WORKER_CONCURRENCY', () => {
    expect(() => load({ ...base, WORKER_CONCURRENCY: '0' })).toThrow(/WORKER_CONCURRENCY/);
    expect(() => load({ ...base, WORKER_CONCURRENCY: '65' })).toThrow(/WORKER_CONCURRENCY/);
  });
  it('bounds MODERATION_CHECK_CONCURRENCY and defaults it to 4', () => {
    expect(load(base).moderationCheckConcurrency).toBe(4);
    expect(load({ ...base, MODERATION_CHECK_CONCURRENCY: '64' }).moderationCheckConcurrency).toBe(
      64,
    );
    for (const bad of ['0', '65']) {
      expect(() => load({ ...base, MODERATION_CHECK_CONCURRENCY: bad })).toThrow(
        /MODERATION_CHECK_CONCURRENCY/,
      );
    }
  });
  it('requires both URLs', () => {
    expect(() => load(without('DATABASE_URL'))).toThrow(/DATABASE_URL is not set/);
  });
  it('never echoes credentials from a malformed URL', () => {
    const attempt = () => load({ ...base, REDIS_URL: 'http://:dev-only-pw@redis:6379' });
    expect(attempt).toThrow(/REDIS_URL/);
    expect(attempt).not.toThrow(/dev-only-pw/);
  });
  it('refuses to boot in production without encryption keys', () => {
    expect(messageOf(() => load(without('FB_ENCRYPTION_KEYS')))).toMatch(
      /FB_ENCRYPTION_KEYS is not set/,
    );
  });
  it('defaults to production rules when FB_ENV is unset', () => {
    const dbUrl = 'postgresql://feedbouncer:dev-only-postgres-password@postgres:5432/feedbouncer';
    const msg = messageOf(() => load({ ...without('FB_ENV'), DATABASE_URL: dbUrl }));
    expect(msg).toMatch(/DATABASE_URL is set to a documented example value/);
    expect(msg).not.toContain('dev-only-postgres-password');
  });
  it('a whole-config dump contains no connection passwords or key material', () => {
    const entry = randomKeyEntry('k1');
    const env = load({
      ...base,
      DATABASE_URL: 'postgresql://u:sentinel-db-pw-123@db:5432/x',
      REDIS_URL: 'redis://:sentinel-redis-pw-456@redis:6379/0',
      FB_ENCRYPTION_KEYS: entry,
    });
    const material = entry.slice(3);
    for (const out of [JSON.stringify(env), inspect(env, { depth: 10, showHidden: true })]) {
      for (const s of ['sentinel-db-pw-123', 'sentinel-redis-pw-456', material])
        expect(out).not.toContain(s);
    }
    expect(env.databaseUrl.password).toBe('sentinel-db-pw-123');
  });

  describe('classifier', () => {
    it('is disabled by default and gives the classify lane 4 consumers, above the per-brand cap', () => {
      const env = load(base);
      expect(env.classifier.model).toBeNull();
      expect(env.jobs.laneConcurrency).toEqual({ classify: 4, policy: 4 });
      expect(env.classifier.perBrandInFlight).toBe(2);
    });
    it('warns when the classify lane is not wider than the per-brand cap', () => {
      const warnings: string[] = [];
      loadWorkerEnv(
        { ...base, JOB_CONCURRENCY_LANE_CLASSIFY: '2' },
        { warn: (m) => warnings.push(m) },
      );
      expect(warnings.join('\n')).toMatch(
        /JOB_CONCURRENCY_LANE_CLASSIFY.*CLASSIFIER_BRAND_MAX_IN_FLIGHT/,
      );
      const quiet: string[] = [];
      loadWorkerEnv(base, { warn: (m) => quiet.push(m) });
      expect(quiet.join('\n')).not.toMatch(/CLASSIFIER_BRAND_MAX_IN_FLIGHT/);
      const off: string[] = [];
      loadWorkerEnv({ ...base, JOB_CONCURRENCY_LANE_CLASSIFY: '0' }, { warn: (m) => off.push(m) });
      expect(off.join('\n')).not.toMatch(/CLASSIFIER_BRAND_MAX_IN_FLIGHT/);
    });
    it('honors JOB_CONCURRENCY_LANE_CLASSIFY and reads CLASSIFIER_API_KEY_FILE', () => {
      const env = loadWorkerEnv(
        {
          ...base,
          JOB_CONCURRENCY_LANE_CLASSIFY: '5',
          CLASSIFIER_PROVIDER: 'google',
          CLASSIFIER_MODEL: 'gemini-2.5-flash',
          CLASSIFIER_API_KEY_FILE: '/run/secrets/clf',
        },
        {
          warn: () => {},
          fs: { size: () => 40, read: () => 'file-sentinel-key-0123456789abcdef\n' },
        },
      );
      expect(env.jobs.laneConcurrency).toEqual({ classify: 5, policy: 4 });
      expect(env.classifier.model?.provider).toBe('google');
      for (const out of [JSON.stringify(env), inspect(env, { depth: 10, showHidden: true })])
        expect(out).not.toContain('file-sentinel-key');
    });
  });

  describe('policy', () => {
    it('reuses the classifier model by default and gives the policy lane 4 consumers', () => {
      const env = load({
        ...base,
        CLASSIFIER_PROVIDER: 'openai',
        CLASSIFIER_MODEL: 'gpt-x',
        CLASSIFIER_API_KEY: 'k'.repeat(40),
      });
      expect(env.policy.model).toMatchObject({ provider: 'openai', model: 'gpt-x' });
      expect(env.jobs.laneConcurrency).toEqual({ classify: 4, policy: 4 });
      expect(load(base).policy.model).toBeNull();
    });
    it('uses its own provider when POLICY_PROVIDER is set', () => {
      const env = load({
        ...base,
        CLASSIFIER_PROVIDER: 'openai',
        CLASSIFIER_MODEL: 'gpt-x',
        CLASSIFIER_API_KEY: 'k'.repeat(40),
        POLICY_PROVIDER: 'none',
      });
      expect(env.policy.model).toBeNull();
      expect(env.classifier.model).not.toBeNull();
    });
    it('warns when the policy lane is not wider than the per-brand cap', () => {
      const warnings: string[] = [];
      loadWorkerEnv(
        { ...base, JOB_CONCURRENCY_LANE_POLICY: '2' },
        { warn: (m) => warnings.push(m) },
      );
      expect(warnings.join('\n')).toMatch(
        /JOB_CONCURRENCY_LANE_POLICY.*POLICY_BRAND_MAX_IN_FLIGHT/,
      );
      const quiet: string[] = [];
      loadWorkerEnv(base, { warn: (m) => quiet.push(m) });
      expect(quiet.join('\n')).not.toMatch(/POLICY_BRAND_MAX_IN_FLIGHT/);
    });
    it('reads POLICY_API_KEY_FILE without leaking the key', () => {
      const env = loadWorkerEnv(
        {
          ...base,
          POLICY_PROVIDER: 'google',
          POLICY_MODEL: 'gemini-2.5-flash',
          POLICY_API_KEY_FILE: '/run/secrets/pol',
        },
        {
          warn: () => {},
          fs: { size: () => 40, read: () => 'policy-sentinel-key-0123456789abcdef\n' },
        },
      );
      expect(env.policy.model?.provider).toBe('google');
      for (const out of [JSON.stringify(env), inspect(env, { depth: 10, showHidden: true })])
        expect(out).not.toContain('policy-sentinel-key');
    });
  });

  describe('instagram', () => {
    it('leaves instagram null unless INSTAGRAM_CONNECTOR_ENABLED=true', () => {
      expect(load({ ...base, ...facebook }).instagram).toBeNull();
      expect(load({ ...base, ...facebook, INSTAGRAM_CONNECTOR_ENABLED: 'false' }).instagram).toBe(
        null,
      );
    });
    it('shares the facebook meta app when enabled', () => {
      const env = load({ ...base, ...facebook, INSTAGRAM_CONNECTOR_ENABLED: 'true' });
      expect(env.instagram?.meta).toBe(env.facebook);
      expect(JSON.stringify(env)).toContain('"instagramEnabled":true');
      expect(JSON.stringify(env)).not.toContain(facebook.FACEBOOK_APP_SECRET);
    });
    it('INSTAGRAM_CONNECTOR_ENABLED=true without facebook config fails startup', () => {
      expect(messageOf(() => load({ ...base, INSTAGRAM_CONNECTOR_ENABLED: 'true' }))).toMatch(
        /INSTAGRAM_CONNECTOR_ENABLED=true requires .*FACEBOOK_APP_ID/,
      );
    });
    it('reads per-platform job concurrency and stale threshold for instagram', () => {
      const env = load({
        ...base,
        JOB_CONCURRENCY_INSTAGRAM: '5',
        CONNECTOR_STALE_AFTER_SECONDS_INSTAGRAM: '7200',
      });
      expect(env.jobs.concurrency.instagram).toBe(5);
      expect(env.jobs.concurrency.facebook).toBe(2);
      expect(env.health.staleAfterMs('instagram')).toBe(7_200_000);
      expect(env.health.staleAfterMs('facebook')).toBe(3_600_000);
    });
  });

  describe('alerts', () => {
    it('is off by default and needs no mail', () => {
      const env = load(without('SMTP_URL', 'PUBLIC_WEB_URL'));
      expect(env.alerts).toEqual({
        slack: false,
        email: false,
        capPerHour: 30,
        emailPerMinute: 60,
      });
      expect(env.mail).toBeNull();
    });
    it('slack alone needs no mail config but does need PUBLIC_WEB_URL', () => {
      const env = load({ ...without('SMTP_URL'), ALERT_CHANNELS: 'slack' });
      expect(env.alerts.slack).toBe(true);
      expect(env.mail).toBeNull();
      expect(env.publicWebUrl?.origin).toBe('https://app.example.com');
      expect(() =>
        load({ ...without('SMTP_URL', 'PUBLIC_WEB_URL'), ALERT_CHANNELS: 'slack' }),
      ).toThrow(/PUBLIC_WEB_URL is not set/);
      expect(() =>
        load({ ...without('SMTP_URL'), ALERT_CHANNELS: 'slack', PUBLIC_WEB_URL: 'nope' }),
      ).toThrow(EnvError);
      expect(() =>
        load({
          ...without('SMTP_URL'),
          ALERT_CHANNELS: 'slack',
          PUBLIC_WEB_URL: 'https://app.example.com/x',
        }),
      ).toThrow(/origin/);
    });
    it('email alerts read mail config even when facebook is unset', () => {
      const env = load({ ...base, ALERT_CHANNELS: 'email' });
      expect(env.facebook).toBeNull();
      expect(env.mail?.smtpUrl.href).toBe('smtp://mailpit:1025');
    });
    it('slack,email without SMTP_URL fails startup', () => {
      expect(
        messageOf(() => load({ ...without('SMTP_URL'), ALERT_CHANNELS: 'slack,email' })),
      ).toMatch(/SMTP_URL/);
    });
    it('rejects an unknown channel and an out-of-range limit', () => {
      expect(() => load({ ...base, ALERT_CHANNELS: 'sms' })).toThrow(/ALERT_CHANNELS/);
      expect(() => load({ ...base, ALERT_MAX_PER_WORKSPACE_PER_HOUR: '0' })).toThrow(
        /ALERT_MAX_PER_WORKSPACE_PER_HOUR/,
      );
    });
    it('reads the limits', () => {
      const env = load({
        ...base,
        ALERT_MAX_PER_WORKSPACE_PER_HOUR: '5',
        ALERT_EMAIL_MAX_PER_MINUTE: '7',
      });
      expect(env.alerts).toMatchObject({ capPerHour: 5, emailPerMinute: 7 });
    });
  });

  describe('weekly reports', () => {
    it('WEEKLY_REPORTS unset → false', () => {
      const env = load(without('SMTP_URL', 'PUBLIC_WEB_URL'));
      expect(env.weeklyReports).toBe(false);
      expect(env.mail).toBeNull();
    });
    it("'on' without SMTP_URL → EnvError", () => {
      expect(messageOf(() => load({ ...without('SMTP_URL'), WEEKLY_REPORTS: 'on' }))).toMatch(
        /SMTP_URL/,
      );
      expect(
        messageOf(() => load({ ...without('SMTP_URL', 'PUBLIC_WEB_URL'), WEEKLY_REPORTS: 'on' })),
      ).toMatch(/PUBLIC_WEB_URL/);
    });
    it("'yes' → EnvError", () => {
      expect(messageOf(() => load({ ...base, WEEKLY_REPORTS: 'yes' }))).toMatch(/WEEKLY_REPORTS/);
    });
    it("'on' with mail and PUBLIC_WEB_URL → true and mail loaded even without Facebook", () => {
      const env = load({ ...base, WEEKLY_REPORTS: 'on' });
      expect(env.weeklyReports).toBe(true);
      expect(env.facebook).toBeNull();
      expect(env.mail?.smtpUrl.href).toBe('smtp://mailpit:1025');
      expect(env.publicWebUrl?.origin).toBe('https://app.example.com');
    });
  });

  describe('facebook, mail and public url', () => {
    it('leaves facebook null when FACEBOOK_APP_ID is unset', () => {
      expect(load(base).facebook).toBeNull();
    });
    it('parses a full facebook config', () => {
      const env = load({ ...base, ...facebook });
      expect(env.facebook?.appId).toBe('1234567890');
      expect(env.facebook?.graphVersion).toBe('v26.0');
      expect(env.facebook?.appSecret.reveal()).toBe(facebook.FACEBOOK_APP_SECRET);
    });
    it('fails fast on a partial facebook config', () => {
      expect(() => load({ ...base, FACEBOOK_APP_ID: '1234567890' })).toThrow(/FACEBOOK_APP_SECRET/);
    });
    it('honours FACEBOOK_APP_SECRET_FILE', () => {
      const rest = { ...facebook, FACEBOOK_APP_SECRET: undefined };
      const fs = { size: () => 29, read: () => 'file-secret-0123456789abcdef\n' };
      const env = loadWorkerEnv(
        { ...base, ...rest, FACEBOOK_APP_SECRET_FILE: '/run/s' },
        { warn: () => {}, fs },
      );
      expect(env.facebook?.appSecret.reveal()).toBe('file-secret-0123456789abcdef');
    });
    it('never serializes the facebook secrets', () => {
      const env = load({ ...base, ...facebook });
      for (const out of [JSON.stringify(env), inspect(env, { depth: 10, showHidden: true })]) {
        expect(out).not.toContain(facebook.FACEBOOK_APP_SECRET);
        expect(out).not.toContain(facebook.FACEBOOK_WEBHOOK_VERIFY_TOKEN);
      }
    });
    it('reads smtp, mail sender and public web url', () => {
      const env = load({ ...base, ...facebook, MAIL_FROM: 'FB <fb@example.com>' });
      expect(env.mail?.smtpUrl.href).toBe('smtp://mailpit:1025');
      expect(env.mail?.mailFrom).toBe('FB <fb@example.com>');
      expect(env.mail?.publicWebUrl.origin).toBe('https://app.example.com');
    });
    it('loads without SMTP_URL and PUBLIC_WEB_URL when facebook is not configured', () => {
      const env = load(without('SMTP_URL', 'PUBLIC_WEB_URL'));
      expect(env.facebook).toBeNull();
      expect(env.mail).toBeNull();
    });
    it('requires SMTP_URL and PUBLIC_WEB_URL when facebook is configured', () => {
      expect(() => load({ ...without('SMTP_URL'), ...facebook })).toThrow(/SMTP_URL is not set/);
      expect(() => load({ ...without('PUBLIC_WEB_URL'), ...facebook })).toThrow(
        /PUBLIC_WEB_URL is not set/,
      );
    });
    it('rejects a public web url that is not an origin', () => {
      expect(() =>
        load({ ...base, ...facebook, PUBLIC_WEB_URL: 'https://app.example.com/x' }),
      ).toThrow(/PUBLIC_WEB_URL must be an origin/);
    });
  });
});

describe('ad polling settings', () => {
  const adsOn = { ...base, ...facebook, META_ADS_CONNECTOR_ENABLED: 'true' };

  it('applies the documented defaults', () => {
    const env = load(adsOn);
    expect(env.metaAds?.activeStatuses).toEqual(['ACTIVE']);
    expect(env.adPolling?.poll).toMatchObject({
      intervalSec: 300,
      graceDays: 7,
      maxSourcesPerJob: 100,
      unavailableRetrySec: 21_600,
      igDeepScanSec: 86_400,
    });
    expect(env.adPolling?.scheduler).toEqual({
      tickSec: 30,
      discoveryIntervalSec: 900,
      pollIntervalSec: 300,
      graceDays: 7,
      maxConnectionsPerTick: 500,
    });
  });
  it('is disabled unless META_ADS_CONNECTOR_ENABLED=true', () => {
    expect(load({ ...base, ...facebook }).metaAds).toBeNull();
  });
  it('leaves ad polling unconfigured, and its variables unread, when the connector is off', () => {
    const env = load({ ...base, ...facebook, AD_POLL_INTERVAL_SEC: '1' });
    expect(env.adPolling).toBeNull();
  });
  it.each([
    ['AD_POLL_INTERVAL_SEC', '3601'],
    ['AD_DISCOVERY_INTERVAL_SEC', '299'],
    ['AD_RETIREMENT_GRACE_DAYS', '31'],
    ['AD_POLL_MAX_SOURCES_PER_JOB', '0'],
    ['AD_SOURCE_UNAVAILABLE_RETRY_SEC', '599'],
    ['AD_IG_DEEP_SCAN_INTERVAL_SEC', '3599'],
    ['AD_SCHEDULER_TICK_SEC', '9'],
    ['AD_SCHEDULER_MAX_CONNECTIONS_PER_TICK', '10001'],
    ['META_ADS_ACTIVE_STATUSES', 'active;drop'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => load({ ...adsOn, [name]: value })).toThrow(EnvError);
  });
  it('requires the Facebook Meta app config', () => {
    expect(() => load({ ...base, META_ADS_CONNECTOR_ENABLED: 'true' })).toThrow(EnvError);
  });
});

describe('retention and privacy settings', () => {
  it('keeps everything forever by default', () => {
    const env = load(base);
    expect(Object.values(env.retention.days)).toEqual(Array(5).fill('forever'));
    expect(env.privacy).toEqual({
      exportDir: '/var/lib/feedbouncer/privacy-exports',
      exportTtlHours: 72,
      requestConcurrency: 1,
    });
  });
  it('reads configured values', () => {
    const env = load({
      ...base,
      RETENTION_AUDIT_DAYS: '730',
      PRIVACY_EXPORT_DIR: '/data/exports',
      PRIVACY_EXPORT_TTL_HOURS: '24',
      PRIVACY_REQUEST_CONCURRENCY: '2',
    });
    expect(env.retention.days.audit).toBe(730);
    expect(env.privacy).toEqual({
      exportDir: '/data/exports',
      exportTtlHours: 24,
      requestConcurrency: 2,
    });
  });
  it('rejects an invalid retention period with the exact message', () => {
    expect(messageOf(() => load({ ...base, RETENTION_AUDIT_DAYS: '0' }))).toBe(
      'RETENTION_AUDIT_DAYS must be a whole number of days from 1 to 36500, or "forever" (got "0").',
    );
  });
  it('rejects a relative export directory', () => {
    expect(() => load({ ...base, PRIVACY_EXPORT_DIR: 'exports' })).toThrow(EnvError);
  });
  it.each([
    ['PRIVACY_EXPORT_TTL_HOURS', '0'],
    ['PRIVACY_EXPORT_TTL_HOURS', '721'],
    ['PRIVACY_REQUEST_CONCURRENCY', '9'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => load({ ...base, [name]: value })).toThrow(EnvError);
  });
});
