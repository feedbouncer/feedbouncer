import { describe, expect, it } from 'vitest';
import {
  effectiveDays,
  loadRetentionSettings,
  parseRetentionDays,
  retentionWarnings,
  type RetentionSettings,
} from './settings.js';

const NAME = 'RETENTION_COMMENTS_DAYS';
const message = (raw: string) =>
  `${NAME} must be a whole number of days from 1 to 36500, or "forever" (got ${JSON.stringify(raw)}).`;

const forever = loadRetentionSettings({});
const withDays = (days: Partial<RetentionSettings['days']>): RetentionSettings => ({
  ...forever,
  days: { ...forever.days, ...days },
});

describe('parseRetentionDays', () => {
  it.each([
    [undefined, 'forever'],
    ['forever', 'forever'],
    ['1', 1],
    ['36500', 36500],
  ])('accepts %j', (raw, expected) => {
    expect(parseRetentionDays(NAME, raw)).toBe(expected);
  });

  it.each(['', '0', '-1', '1.5', '1e3', '+5', ' 5', 'abc', '36501', 'FOREVER'])(
    'rejects %j with the exact message',
    (raw) => {
      expect(() => parseRetentionDays(NAME, raw)).toThrow(message(raw));
    },
  );
});

describe('loadRetentionSettings', () => {
  it('keeps everything forever by default', () => {
    expect(forever).toEqual({
      days: {
        comments: 'forever',
        decisions: 'forever',
        previews: 'forever',
        operational: 'forever',
        audit: 'forever',
      },
      purgeIntervalMinutes: 60,
      batchSize: 1000,
      confirmAbove: 10_000,
      maxRunMinutes: 10,
    });
  });

  it('reads each category and the purge tuning', () => {
    const s = loadRetentionSettings({
      RETENTION_COMMENTS_DAYS: '90',
      RETENTION_AUDIT_DAYS: '730',
      RETENTION_PURGE_INTERVAL_MINUTES: '5',
      RETENTION_BATCH_SIZE: '10000',
      RETENTION_CONFIRM_ABOVE: '0',
      RETENTION_MAX_RUN_MINUTES: '120',
    });
    expect(s.days.comments).toBe(90);
    expect(s.days.audit).toBe(730);
    expect(s.days.decisions).toBe('forever');
    expect([s.purgeIntervalMinutes, s.batchSize, s.confirmAbove, s.maxRunMinutes]).toEqual([
      5, 10_000, 0, 120,
    ]);
  });

  it('names the variable when a category is invalid', () => {
    expect(() => loadRetentionSettings({ RETENTION_AUDIT_DAYS: '0' })).toThrow(
      'RETENTION_AUDIT_DAYS must be a whole number of days from 1 to 36500, or "forever" (got "0").',
    );
  });

  it.each([
    ['RETENTION_PURGE_INTERVAL_MINUTES', '4'],
    ['RETENTION_BATCH_SIZE', '99'],
    ['RETENTION_CONFIRM_ABOVE', '10000001'],
    ['RETENTION_MAX_RUN_MINUTES', '121'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadRetentionSettings({ [name]: value })).toThrow(name);
  });
});

describe('retentionWarnings', () => {
  it('only reports the built-in limits when everything is forever', () => {
    expect(retentionWarnings(forever)).toEqual(['builtin_shorter']);
  });

  it('flags an audit period under a year', () => {
    expect(retentionWarnings(withDays({ audit: 30 }))).toContain('audit_below_recommended');
    expect(retentionWarnings(withDays({ audit: 365 }))).not.toContain('audit_below_recommended');
  });

  it('flags decisions kept longer than their comments', () => {
    expect(retentionWarnings(withDays({ comments: 30 }))).toContain('decisions_capped_by_comments');
    expect(retentionWarnings(withDays({ comments: 30, decisions: 30 }))).not.toContain(
      'decisions_capped_by_comments',
    );
    expect(retentionWarnings(withDays({ comments: 30, decisions: 10 }))).not.toContain(
      'decisions_capped_by_comments',
    );
  });

  it('flags previews configured longer than the built-in 7 days', () => {
    expect(retentionWarnings(withDays({ previews: 30 }))).toContain('builtin_shorter');
  });

  it('flags operational periods longer than the 30-day webhook limit', () => {
    expect(retentionWarnings(withDays({ operational: 60 }))).toContain('builtin_shorter');
  });
});

describe('effectiveDays', () => {
  it('caps previews at the built-in limit', () => {
    expect(effectiveDays(withDays({ previews: 30 })).previews).toBe(7);
    expect(effectiveDays(withDays({ previews: 3 })).previews).toBe(3);
    expect(effectiveDays(forever).previews).toBe(7);
  });

  it('leaves the other categories as configured', () => {
    expect(effectiveDays(withDays({ comments: 30 })).comments).toBe(30);
    expect(effectiveDays(forever).audit).toBe('forever');
  });
});
