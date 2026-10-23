import { SCAN_FAILURES } from '@feedbouncer/scan/contract';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { errorCopy } from './copy';
import { sampleResult } from './fixtures';
import { FailedView, ResultView } from './result-view';

const render = (result = sampleResult(), mode: 'owner' | 'shared' = 'owner') =>
  renderToStaticMarkup(<ResultView result={result} pageName="Acme" mode={mode} />);

describe('ResultView', () => {
  it('hostile text is inert', () => {
    const text =
      '<script>alert(1)</script><img src=x onerror=alert(1)> javascript:alert(1) https://evil.example';
    const base = sampleResult();
    const html = render({ ...base, examples: [{ ...base.examples[0]!, text }] });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/<[^>]*\sonerror=/);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).not.toContain('dangerously');
  });

  it('shows the headline and the basis', () => {
    const html = render();
    expect(html).toContain('20% of comments on your last 2 ads look like scam or spam');
    expect(html).toContain('Based on 200 comments on 2 ads');
    expect(html).toContain('posted ×3');
  });

  it('empty result shows "Nothing to scan yet" and no "%"', () => {
    const html = render(sampleResult({ empty: true, sharePct: null, reliable: false }));
    expect(html).toContain('Nothing to scan yet');
    expect(html).not.toContain('%');
  });

  it('unreliable result shows the label next to the number', () => {
    const html = render(sampleResult({ reliable: false }));
    expect(html).toContain('20%');
    expect(html).toContain('Not enough comments for a reliable share.');
    expect(render()).not.toContain('Not enough comments');
  });

  it('sampled_comment_cap notice renders "based on a sample"', () => {
    expect(render(sampleResult({ notices: ['sampled_comment_cap'] }))).toContain(
      'based on a sample',
    );
  });

  it('shared mode renders "Ad 1" and never the owner label', () => {
    const shared = render(sampleResult(), 'shared');
    expect(shared).toContain('Ad 1');
    expect(shared).not.toContain('Summer sale');
    const owner = render();
    expect(owner).toContain('Summer sale');
  });

  it('exactly one CTA link', () => {
    for (const mode of ['owner', 'shared'] as const) {
      const html = render(sampleResult(), mode);
      expect(html.match(/<a /g)).toHaveLength(1);
      expect(html).toContain('href="/api/v1/scan/cta"');
      expect(html).toContain('FeedBouncer can hide comments like these automatically');
    }
  });

  it('disclaimer and retention text present verbatim', () => {
    const html = render();
    expect(html).toContain(
      'This is an estimate from an automated classifier, not a verdict. It can be wrong in both directions.',
    );
    expect(html).toContain('We keep this result for 30 days. You can delete it now.');
  });

  it('failed scan renders the specific message per failure and no percentage', () => {
    const seen = new Set<string>();
    for (const reason of SCAN_FAILURES) {
      const html = renderToStaticMarkup(<FailedView failureReason={reason} />);
      expect(html).toContain(errorCopy(reason)!);
      expect(html).toContain('href="/scan"');
      expect(html).not.toContain('%');
      seen.add(errorCopy(reason)!);
    }
    expect(seen.size).toBe(SCAN_FAILURES.length);
  });
});
