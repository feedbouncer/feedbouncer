import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { withIntl } from '../../test/intl';
import { Progress } from './progress';

const steps = {
  connect: 'done',
  defaults: 'pending',
  review_mode: 'pending',
  report: 'pending',
} as const;
const html = renderToStaticMarkup(
  withIntl(<Progress steps={steps} current="defaults" orgId="o1" />),
);

describe('Progress', () => {
  it('marks the current step inside a labelled list and counts steps', () => {
    expect(html).toContain('<ol aria-label="Setup progress"');
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain('Step 2 of 4');
  });

  it('links only reachable steps; the rest are aria-disabled text', () => {
    expect(html).toContain('href="/orgs/o1/onboarding/connect"');
    expect(html).not.toContain('onboarding/review_mode"');
    expect(html).not.toContain('onboarding/report"');
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(2);
  });
});
