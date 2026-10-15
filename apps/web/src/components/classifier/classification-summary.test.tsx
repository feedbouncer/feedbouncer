import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CATEGORIES, type ClassificationView } from '../../lib/classifier';
import { ClassificationSummary } from './classification-summary';

const classified: ClassificationView = {
  id: 'c1',
  status: 'classified',
  skipReason: null,
  unclassifiedReason: null,
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  scores: Object.fromEntries(CATEGORIES.map((c) => [c, 0.05])) as ClassificationView['scores'],
  language: 'en',
  languageSupported: true,
  lowSignal: false,
  truncated: false,
  inputChars: 40,
  ruleDecided: false,
  outcome: 'hide',
  triggers: [],
  downgraded: null,
  createdAt: '2026-10-15T10:00:00.000Z',
};

const render = (c: ClassificationView | null) =>
  renderToStaticMarkup(<ClassificationSummary classification={c} />);

describe('ClassificationSummary', () => {
  it('lists the seven scores, highlights triggers and names the model', () => {
    const html = render({
      ...classified,
      scores: { ...classified.scores!, spam: 0.93 },
      triggers: [
        { category: 'spam', score: 0.93, threshold: 0.8, action: 'hide', effectiveAction: 'hide' },
      ],
    });
    expect(html.match(/<li/g)).toHaveLength(7);
    expect(html).toContain('Spam');
    expect(html).toContain('0.93');
    expect(html).toContain('<strong>');
    expect(html).toContain('anthropic');
    expect(html).toContain('claude-haiku-4-5');
  });

  it('flags truncated and low-signal text', () => {
    const html = render({ ...classified, truncated: true, lowSignal: true });
    expect(html).toContain('Only the first 4,000 characters were classified');
    expect(html).toContain('Very short or emoji-only text');
  });

  it('shows the status for unclassified and skipped rows', () => {
    expect(
      render({
        ...classified,
        status: 'unclassified',
        unclassifiedReason: 'timeout',
        scores: null,
      }),
    ).toContain('Not classified: the classifier timed out');
    expect(
      render({ ...classified, status: 'skipped', skipReason: 'deleted', scores: null }),
    ).toContain('Not classified: comment was deleted');
    expect(render(null)).toContain('Not classified yet');
  });
});
