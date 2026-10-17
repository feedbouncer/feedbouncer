import { describe, expect, it } from 'vitest';
import { normalizeEmail, parseSlackWebhookUrl } from './channels.js';

const GOOD = 'https://hooks.slack.com/services/TABC12345/BXYZ98765/abcdefghijklmnop1234';

describe('parseSlackWebhookUrl', () => {
  it.each([
    'http://hooks.slack.com/services/T00/B00/abcdefghijklmnop',
    'https://hooks.slack.com.evil.io/services/T00/B00/abcdefghijklmnop',
    'https://hooks.slack.com:8443/services/T00/B00/abcdefghijklmnop',
    'https://u@hooks.slack.com/services/T00/B00/abcdefghijklmnop',
    'https://169.254.169.254/services/T00/B00/abcdefghijklmnop',
    'https://hooks.slack.com/services/T00/B00/short',
    `${GOOD}?x=1`,
    `${GOOD}#`,
    ` ${GOOD}`,
    'not a url',
  ])('rejects non-Slack and look-alike webhook URLs: %s', (raw) => {
    expect(parseSlackWebhookUrl(raw)).toEqual({ ok: false });
  });

  it('accepts a valid URL and hints at the tail of each id', () => {
    const r = parseSlackWebhookUrl(GOOD);
    expect(r.ok && r.hint).toBe('T…2345/B…8765');
    expect(r.ok && r.url.href).toBe(GOOD);
    expect(r.ok && r.hint).not.toContain('abcdefgh');
  });
});

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Ann@Example.COM ')).toBe('ann@example.com');
  });
  it.each(['a@b,c@d', '<a@b>', `${'a'.repeat(250)}@b.co`, 'nope', ''])('rejects %s', (raw) => {
    expect(normalizeEmail(raw)).toBeNull();
  });
});
