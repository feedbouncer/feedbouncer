import { describe, expect, it } from 'vitest';
import { describeDecision, describeFallback } from './reason.js';
import type { Evidence, RuleHit, RuleKind } from './types.js';

const hit = (kind: RuleKind, evidence: Evidence, ruleName = 'My rule'): RuleHit => ({
  ruleId: 'id',
  ruleName,
  kind,
  action: 'hide',
  actions: [{ type: 'hide' }],
  evidence,
});

describe('describeDecision', () => {
  it('describes every evidence kind with rule name and kind label', () => {
    const cases: [RuleHit, string, string][] = [
      [hit('keyword', { kind: 'keyword', term: 'spam' }), '(keyword)', 'matched "spam"'],
      [hit('regex', { kind: 'regex', patternIndex: 1 }), '(regex)', 'matched pattern #2'],
      [
        hit('link_domain', { kind: 'link', host: 'bit.ly', reason: 'shortener' }, 'Scam links'),
        '(link domain)',
        'link to bit.ly is a URL shortener',
      ],
      [
        hit('link_domain', { kind: 'link', host: 'a.io', reason: 'blocklisted' }),
        '(link domain)',
        'is blocklisted',
      ],
      [
        hit('link_domain', { kind: 'link', host: 'a.io', reason: 'not_allowlisted' }),
        '(link domain)',
        'is not on the allowlist',
      ],
      [
        hit('link_domain', { kind: 'link', host: 'a.io', reason: 'lookalike' }),
        '(link domain)',
        'looks like a disguised domain',
      ],
      [hit('emoji', { kind: 'emoji', emoji: '🔥' }), '(emoji)', 'contains 🔥'],
      [hit('emoji', { kind: 'emoji_count', count: 5, max: 2 }), '(emoji)', 'has 5 emoji (max 2)'],
      [
        hit('author', { kind: 'author', list: 'block', matchedOn: 'id' }),
        '(author)',
        'author is on the block list (matched by account ID)',
      ],
      [
        hit('author', { kind: 'author', list: 'trusted', matchedOn: 'handle' }),
        '(author)',
        'matched by handle',
      ],
      [
        hit('competitor', { kind: 'competitor', term: 'Acme', via: 'name' }),
        '(competitor)',
        'mentions competitor "Acme"',
      ],
    ];
    for (const [h, label, text] of cases) {
      const out = describeDecision(h);
      expect(out).toContain(`Rule "${h.ruleName}"`);
      expect(out).toContain(label);
      expect(out).toContain(text);
    }
  });
  it('matches the documented example', () => {
    expect(
      describeDecision(
        hit('link_domain', { kind: 'link', host: 'bit.ly', reason: 'shortener' }, 'Scam links'),
      ),
    ).toBe('Rule "Scam links" (link domain): link to bit.ly is a URL shortener.');
  });
  it('is at most 2000 chars', () => {
    const out = describeDecision(
      hit(
        'link_domain',
        { kind: 'link', host: 'h'.repeat(253), reason: 'blocklisted' },
        'n'.repeat(200),
      ),
    );
    expect(out.length).toBeLessThanOrEqual(2000);
    const long = describeDecision(hit('keyword', { kind: 'keyword', term: 't'.repeat(5000) }));
    expect(long.length).toBeLessThanOrEqual(2000);
  });
});

describe('describeFallback', () => {
  it('describes an unsupported action', () => {
    expect(describeFallback('Spam', 'remove', 'unsupported', 'instagram')).toBe(
      'Rule "Spam" wanted to delete this comment, but Instagram does not allow it (unsupported). Flagged for review instead.',
    );
  });
  it('maps known and unknown codes', () => {
    expect(describeFallback('S', 'hide', 'rate_limited', 'facebook')).toContain(
      'wanted to hide this comment, but the platform is rate-limiting us (still retrying) (rate_limited)',
    );
    expect(describeFallback('S', 'hide', 'weird', 'facebook')).toContain(
      'the platform call failed',
    );
    expect(describeFallback('S', 'hide', 'auth_expired', 'facebook')).toContain(
      'permission was revoked',
    );
  });
  it('is at most 2000 chars', () => {
    expect(describeFallback('n'.repeat(5000), 'hide', 'x', 'facebook').length).toBeLessThanOrEqual(
      2000,
    );
  });
});
