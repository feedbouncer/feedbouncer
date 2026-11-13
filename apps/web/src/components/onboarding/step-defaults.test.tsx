import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import en from '../../../messages/en.json';
import type { OnboardingDefaultsDto } from '../../lib/onboarding';
import { withIntl } from '../../test/intl';
import { StepDefaults } from './step-defaults';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const CATEGORY_IDS = [
  'spam',
  'scam_phishing',
  'harassment_abuse',
  'hate_speech',
  'sexual_content',
  'profanity',
  'self_promotion',
] as const;

const defaults = (over: Partial<OnboardingDefaultsDto> = {}): OnboardingDefaultsDto => ({
  aiEnabled: true,
  basedOn: 'a'.repeat(64),
  categories: CATEGORY_IDS.map((category) => ({
    category,
    action: category === 'scam_phishing' ? 'hide' : category === 'spam' ? 'flag' : 'approve',
    threshold: 0.8,
    source: 'default',
  })),
  ...over,
});

const render = (d: OnboardingDefaultsDto) =>
  renderToStaticMarkup(withIntl(<StepDefaults orgId="o1" brandId="b1" initial={d} />));

const fieldset = (html: string, name: string) => {
  const at = html.indexOf(`<legend>${name}</legend>`);
  return html.slice(html.lastIndexOf('<fieldset', at), html.indexOf('</fieldset>', at));
};

const radio = (f: string, value: string) => {
  const at = f.indexOf(`value="${value}"`);
  return f.slice(f.lastIndexOf('<input', at), f.indexOf('>', at));
};

describe('StepDefaults', () => {
  it('fresh brand checks hide for scam_phishing and flag for spam; every category has a description', () => {
    const html = render(defaults());
    expect(radio(fieldset(html, 'Scam or phishing'), 'hide')).toContain('checked=""');
    expect(radio(fieldset(html, 'Spam'), 'flag')).toContain('checked=""');
    expect(radio(fieldset(html, 'Spam'), 'hide')).not.toContain('checked=""');
    expect(html.match(/<fieldset/g)).toHaveLength(7);
    for (const id of CATEGORY_IDS) {
      const c = (en.onboarding.category as Record<string, { name: string; description: string }>)[
        id
      ];
      expect(c?.description.length).toBeGreaterThan(10);
    }
    expect(html).toContain('>Continue<');
  });

  it('remove category is read-only', () => {
    const d = defaults();
    d.categories[5] = { ...d.categories[5]!, action: 'remove' };
    const html = render(d);
    const f = fieldset(html, 'Profanity');
    expect(f).not.toContain('type="radio"');
    expect(f).toContain('href="/orgs/o1/brands/b1/classifier"');
    expect(html).not.toMatch(/value="remove"/);
  });

  it('aiOff note shown when aiEnabled=false', () => {
    expect(render(defaults({ aiEnabled: false }))).toContain(en.onboarding.defaults.aiOff);
    expect(render(defaults())).not.toContain(en.onboarding.defaults.aiOff);
  });

  it('uses fieldset legends, relative links only and no http urls', () => {
    expect(render(defaults())).not.toMatch(/https?:\/\//);
  });
});
