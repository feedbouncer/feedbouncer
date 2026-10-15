import { describe, expect, it } from 'vitest';
import {
  buildThresholdUpdate,
  classificationStatusText,
  classifierEvidence,
  formatScore,
  hasChanges,
  initialEdits,
  rerunNotice,
  thresholdsKey,
  transitionText,
  type ThresholdView,
} from './classifier';

const view = (
  category: ThresholdView['category'],
  over: Partial<ThresholdView> = {},
): ThresholdView => ({
  category,
  threshold: 0.8,
  action: 'hide',
  source: 'default',
  updatedAt: null,
  updatedBy: null,
  ...over,
});

const edit = (v: ThresholdView, over = {}) => ({
  threshold: String(v.threshold),
  action: v.action,
  useDefault: false,
  ...over,
});

describe('classifier lib', () => {
  it('formats evidence with the right comparator', () => {
    expect(formatScore(0.8)).toBe('0.80');
    expect(
      classifierEvidence({ category: 'hate_speech', score: 0.93, threshold: 0.8 } as never),
    ).toBe('Hate speech 0.93 ≥ 0.80');
    expect(
      classifierEvidence({ category: 'hate_speech', score: 0.1, threshold: 0.8 } as never),
    ).toBe('Hate speech 0.10 < 0.80');
  });

  it('describes classification status', () => {
    expect(classificationStatusText(null)).toBe('Not classified yet');
    expect(
      classificationStatusText({ status: 'unclassified', unclassifiedReason: 'timeout' } as never),
    ).toBe('Not classified: the classifier timed out');
    expect(
      classificationStatusText({ status: 'unclassified', unclassifiedReason: 'disabled' } as never),
    ).toBe('Not classified: no classifier is configured');
    expect(
      classificationStatusText({
        status: 'classified',
        languageSupported: false,
        language: 'sw',
      } as never),
    ).toBe('Classified (language not supported: sw), destructive actions disabled');
    expect(classificationStatusText({ status: 'skipped', skipReason: 'deleted' } as never)).toBe(
      'Not classified: comment was deleted',
    );
  });

  it('names transitions', () => {
    expect(transitionText('none→hide')).toBe('Not actioned → Hide');
    expect(transitionText('hide→remove')).toBe('Hide → Delete');
  });

  it('rebuilds edit state from the server values after a reset', () => {
    const before = [view('spam', { source: 'brand', threshold: 0.7 })];
    const after = [view('spam')];
    const stale = { spam: edit(before[0]!, { useDefault: true }) };
    expect(hasChanges(before, stale)).toBe(true);
    expect(thresholdsKey(before)).not.toBe(thresholdsKey(after));
    const fresh = initialEdits(after);
    expect(fresh.spam).toEqual({ threshold: '0.8', action: 'hide', useDefault: false });
    expect(hasChanges(after, fresh)).toBe(false);
  });

  describe('buildThresholdUpdate', () => {
    const spam = view('spam');
    const hate = view('hate_speech', { source: 'brand', threshold: 0.7 });
    const original = [spam, hate];

    it('sends only changed categories', () => {
      const r = buildThresholdUpdate(original, {
        spam: edit(spam, { threshold: '0.9' }),
        hate_speech: edit(hate),
      });
      expect(r.errors).toEqual({});
      expect(r.items).toEqual([{ category: 'spam', threshold: 0.9, action: 'hide' }]);
    });

    it('sends useDefault for a brand override reset', () => {
      const r = buildThresholdUpdate(original, {
        spam: edit(spam),
        hate_speech: edit(hate, { useDefault: true }),
      });
      expect(r.items).toEqual([{ category: 'hate_speech', useDefault: true }]);
    });

    it('rejects out-of-range, non-numeric and over-precise values', () => {
      const r = buildThresholdUpdate(original, {
        spam: edit(spam, { threshold: '1.5' }),
        hate_speech: edit(hate, { threshold: '0.12345' }),
      });
      expect(r.errors.spam).toBe('Threshold must be between 0 and 1.');
      expect(r.errors.hate_speech).toBe('Threshold can have at most 4 decimal places.');
      expect(
        buildThresholdUpdate(original, { spam: edit(spam, { threshold: '' }) }).errors.spam,
      ).toBe('Threshold must be a number between 0 and 1.');
    });
  });
});

describe('rerunNotice', () => {
  it('explains an empty re-run, and reports started and partially failed ones', () => {
    expect(rerunNotice({ enqueued: 0, failed: 0 })).toBe(
      'Nothing to re-run: no active connections.',
    );
    expect(rerunNotice({ enqueued: 2, failed: 0 })).toBe('Re-run started on 2 connection(s).');
    expect(rerunNotice({ enqueued: 1, failed: 1 })).toBe(
      'Re-run started on 1 connection(s); 1 could not be started.',
    );
  });
});
