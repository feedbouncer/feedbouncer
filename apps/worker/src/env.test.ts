import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { EnvError, Secret } from '@feedbouncer/service-runtime';
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

  describe('scan', () => {
    const classifier = {
      CLASSIFIER_PROVIDER: 'openai',
      CLASSIFIER_MODEL: 'gpt-x',
      CLASSIFIER_API_KEY: 'k'.repeat(40),
    };
    it('is disabled by default with the documented limits', () => {
      expect(load(base).scan).toEqual({
        enabled: false,
        maxComments: 2000,
        retentionDays: 30,
        workerConcurrency: 2,
      });
    });
    it('enables with the Facebook config and a classifier, and says so in the summary', () => {
      const env = load({ ...base, ...facebook, ...classifier, SCAN_TOOL_ENABLED: 'true' });
      expect(env.scan.enabled).toBe(true);
      expect(JSON.stringify(env)).toContain('"scanToolEnabled":true');
    });
    it('refuses to start enabled without the Facebook config or a classifier', () => {
      expect(messageOf(() => load({ ...base, ...classifier, SCAN_TOOL_ENABLED: 'true' }))).toMatch(
        /SCAN_TOOL_ENABLED=true requires .*FACEBOOK_APP_ID/,
      );
      expect(messageOf(() => load({ ...base, ...facebook, SCAN_TOOL_ENABLED: 'true' }))).toMatch(
        /SCAN_TOOL_ENABLED=true requires CLASSIFIER_PROVIDER/,
      );
    });
    it('rejects SCAN_RETENTION_DAYS above 30', () => {
      expect(messageOf(() => load({ ...base, SCAN_RETENTION_DAYS: '31' }))).toMatch(
        /SCAN_RETENTION_DAYS/,
      );
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

describe('tiktok connectors and polling settings', () => {
  const secret = 'tiktok-sentinel-secret-0123456789';
  const organic = {
    TIKTOK_CONNECTOR_ENABLED: 'true',
    TIKTOK_APP_ID: '7300000000000001',
    TIKTOK_APP_SECRET: secret,
  };
  const adsOnly = {
    TIKTOK_ADS_CONNECTOR_ENABLED: 'true',
    TIKTOK_ADS_APP_ID: '7300000000000002',
    TIKTOK_ADS_APP_SECRET: secret,
  };

  it('is off, with no polling settings read, by default', () => {
    const env = load({ ...base, TIKTOK_POLL_INTERVAL_SEC: '1', TIKTOK_MAX_PAGES_PER_JOB: '0' });
    expect(env.tiktok).toBeNull();
    expect(env.tiktokAds).toBeNull();
    expect(env.tiktokPolling).toBeNull();
  });
  it('works without any Facebook config', () => {
    const env = load({ ...base, ...organic });
    expect(env.facebook).toBeNull();
    expect(env.tiktok).toEqual({ appId: organic.TIKTOK_APP_ID, appSecret: new Secret(secret) });
    expect(env.tiktokAds).toBeNull();
  });
  it('applies the documented defaults', () => {
    const env = load({ ...base, ...organic, ...adsOnly });
    expect(env.tiktokPolling).toEqual({
      platforms: ['tiktok', 'tiktok_ads'],
      poll: {
        pollIntervalSec: 300,
        quietVideoPollIntervalSec: 21_600,
        activeVideoDays: 30,
        videoDiscoveryIntervalSec: 900,
        deepScanIntervalSec: 86_400,
        sourceUnavailableRetrySec: 21_600,
        maxSourcesPerJob: 25,
        adsPollIntervalSec: 300,
        adsOverlapSec: 900,
        adsFullScanIntervalSec: 86_400,
        maxPagesPerJob: 20,
      },
      scheduler: { tickSec: 30, maxConnectionsPerTick: 200 },
    });
  });
  it('schedules only the enabled platforms', () => {
    expect(load({ ...base, ...adsOnly }).tiktokPolling?.platforms).toEqual(['tiktok_ads']);
    expect(load({ ...base, ...organic }).tiktokPolling?.platforms).toEqual(['tiktok']);
  });
  it('lets the ads connector fall back to the organic app credentials', () => {
    const env = load({ ...base, ...organic, TIKTOK_ADS_CONNECTOR_ENABLED: 'true' });
    expect(env.tiktokAds).toEqual({ appId: organic.TIKTOK_APP_ID, appSecret: new Secret(secret) });
  });
  it.each([
    ['TIKTOK_CONNECTOR_ENABLED', organic, 'TIKTOK_APP_ID'],
    ['TIKTOK_ADS_CONNECTOR_ENABLED', adsOnly, 'TIKTOK_ADS_APP_ID'],
  ])('%s=true without app credentials fails startup', (flag, full, idName) => {
    const noCreds = { [flag]: 'true' };
    expect(messageOf(() => load({ ...base, ...noCreds }))).toMatch(idName);
    expect(() => load({ ...base, ...full })).not.toThrow();
  });
  it('reads the app secret from TIKTOK_APP_SECRET_FILE', () => {
    const fs = { size: () => secret.length + 1, read: () => `${secret}\n` };
    const env = loadWorkerEnv(
      { ...base, ...organic, TIKTOK_APP_SECRET: undefined, TIKTOK_APP_SECRET_FILE: '/run/s' },
      { warn: () => {}, fs },
    );
    expect(env.tiktok?.appSecret.reveal()).toBe(secret);
  });
  it('needs the public web url and mail config for reconnect notices and oauth', () => {
    expect(messageOf(() => load({ ...without('PUBLIC_WEB_URL'), ...organic }))).toMatch(
      /PUBLIC_WEB_URL/,
    );
    expect(load({ ...base, ...organic }).mail?.smtpUrl.href).toBe('smtp://mailpit:1025');
  });
  it('reads configured values', () => {
    const env = load({
      ...base,
      ...organic,
      ...adsOnly,
      TIKTOK_POLL_INTERVAL_SEC: '60',
      TIKTOK_MAX_PAGES_PER_JOB: '200',
      TIKTOK_ADS_POLL_OVERLAP_SEC: '0',
      TIKTOK_SCHEDULER_TICK_SEC: '5',
      TIKTOK_SCHEDULER_MAX_CONNECTIONS_PER_TICK: '5000',
    });
    expect(env.tiktokPolling?.poll).toMatchObject({
      pollIntervalSec: 60,
      maxPagesPerJob: 200,
      adsOverlapSec: 0,
    });
    expect(env.tiktokPolling?.scheduler).toEqual({ tickSec: 5, maxConnectionsPerTick: 5000 });
  });
  it.each([
    ['TIKTOK_POLL_INTERVAL_SEC', '59'],
    ['TIKTOK_POLL_INTERVAL_SEC', '3601'],
    ['TIKTOK_QUIET_VIDEO_POLL_INTERVAL_SEC', '299'],
    ['TIKTOK_ACTIVE_VIDEO_DAYS', '366'],
    ['TIKTOK_VIDEO_DISCOVERY_INTERVAL_SEC', '86401'],
    ['TIKTOK_DEEP_SCAN_INTERVAL_SEC', '3599'],
    ['TIKTOK_SOURCE_UNAVAILABLE_RETRY_SEC', '604801'],
    ['TIKTOK_MAX_SOURCES_PER_JOB', '201'],
    ['TIKTOK_ADS_POLL_INTERVAL_SEC', '3601'],
    ['TIKTOK_ADS_POLL_OVERLAP_SEC', '86401'],
    ['TIKTOK_ADS_FULL_SCAN_INTERVAL_SEC', '3599'],
    ['TIKTOK_MAX_PAGES_PER_JOB', '0'],
    ['TIKTOK_SCHEDULER_TICK_SEC', '4'],
    ['TIKTOK_SCHEDULER_MAX_CONNECTIONS_PER_TICK', '5001'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => load({ ...base, ...organic, ...adsOnly, [name]: value })).toThrow(EnvError);
  });
  it('does not read the settings of a connector that is off', () => {
    expect(() =>
      load({
        ...base,
        ...organic,
        TIKTOK_ADS_POLL_INTERVAL_SEC: '1',
        TIKTOK_ADS_POLL_OVERLAP_SEC: 'x',
      }),
    ).not.toThrow();
    expect(() => load({ ...base, ...adsOnly, TIKTOK_POLL_INTERVAL_SEC: '1' })).not.toThrow();
  });
  it('never serializes the app secrets', () => {
    expect(JSON.stringify(load({ ...base, ...organic, ...adsOnly }))).not.toContain(secret);
  });
});

describe('youtube connector settings', () => {
  const secret = 'youtube-sentinel-secret-0123456789';
  const enabled = {
    YOUTUBE_CONNECTOR_ENABLED: 'true',
    YOUTUBE_CLIENT_ID: '123-abc.apps.googleusercontent.com',
    YOUTUBE_CLIENT_SECRET: secret,
  };
  it('is off by default', () => {
    expect(load(base).youtube).toBeNull();
    expect(load({ ...base, YOUTUBE_PROJECT_DAILY_QUOTA: '0' }).youtube).toBeNull();
  });
  it('reads the defaults when enabled', () => {
    expect(load({ ...base, ...enabled }).youtube).toMatchObject({
      clientId: enabled.YOUTUBE_CLIENT_ID,
      projectDailyQuota: 10_000,
      projectHeadroomUnits: 1000,
      schedulerTickSec: 60,
      backlogCap: 5000,
    });
  });
  it('enabled without a client secret fails fast', () => {
    const noSecret = { ...base, ...enabled, YOUTUBE_CLIENT_SECRET: undefined };
    expect(messageOf(() => load(noSecret))).toMatch(/YOUTUBE_CLIENT_SECRET/);
  });
  it('rejects headroom at or above the quota', () => {
    const env = { ...base, ...enabled, YOUTUBE_PROJECT_DAILY_QUOTA: '2000' };
    expect(() => load({ ...env, YOUTUBE_PROJECT_HEADROOM_UNITS: '2000' })).toThrow(
      /YOUTUBE_PROJECT_HEADROOM_UNITS/,
    );
    expect(() => load({ ...env, YOUTUBE_PROJECT_HEADROOM_UNITS: '1999' })).not.toThrow();
  });
  it('reads the client secret from YOUTUBE_CLIENT_SECRET_FILE', () => {
    const fs = { size: () => secret.length + 1, read: () => `${secret}\n` };
    const env = loadWorkerEnv(
      {
        ...base,
        ...enabled,
        YOUTUBE_CLIENT_SECRET: undefined,
        YOUTUBE_CLIENT_SECRET_FILE: '/run/s',
      },
      { warn: () => {}, fs },
    );
    expect(env.youtube?.clientSecret.reveal()).toBe(secret);
  });
  it('needs the public web url and mail config, for the quota notices and oauth', () => {
    expect(messageOf(() => load({ ...without('PUBLIC_WEB_URL'), ...enabled }))).toMatch(
      /PUBLIC_WEB_URL/,
    );
    expect(load({ ...base, ...enabled }).mail?.smtpUrl.href).toBe('smtp://mailpit:1025');
  });
  it('never serializes or inspects the client secret', () => {
    const env = load({ ...base, ...enabled });
    expect(JSON.stringify(env)).toContain('"youtubeEnabled":true');
    for (const out of [JSON.stringify(env), inspect(env, { depth: 10, showHidden: true })])
      expect(out).not.toContain(secret);
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
    expect(messageOf(() => load({ ...base, PRIVACY_EXPORT_DIR: 'exports' }))).toBe(
      'PRIVACY_EXPORT_DIR must be an absolute path',
    );
  });
  it.each([
    ['PRIVACY_EXPORT_TTL_HOURS', '0'],
    ['PRIVACY_EXPORT_TTL_HOURS', '721'],
    ['PRIVACY_REQUEST_CONCURRENCY', '9'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => load({ ...base, [name]: value })).toThrow(EnvError);
  });
});
