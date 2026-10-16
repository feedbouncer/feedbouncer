import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ActionCapabilitiesDto, DraftStep } from '../../lib/actions';
import { StepEditor } from './step-editor';

const e = (platform: string, supported: boolean, maxChars: number | null = null) => ({
  platform,
  connectionId: platform,
  supported,
  missingScopes: [],
  maxChars,
});

const IG_ONLY: ActionCapabilitiesDto = {
  steps: {
    flag_for_review: { platforms: [e('instagram', true)] },
    private_reply: { platforms: [e('instagram', true, 1000)] },
    auto_reply: { platforms: [e('instagram', true, 2200)] },
    hide: { platforms: [e('instagram', true)] },
    ban: { platforms: [e('instagram', false)] },
    delete: { platforms: [e('instagram', true)] },
  },
};

const BOTH: ActionCapabilitiesDto = {
  steps: {
    ...IG_ONLY.steps,
    ban: { platforms: [e('facebook', true), e('instagram', false)] },
  },
};

const render = (
  value: DraftStep[],
  capabilities = IG_ONLY,
  extra: Partial<Parameters<typeof StepEditor>[0]> = {},
) =>
  renderToStaticMarkup(
    <StepEditor value={value} onChange={() => undefined} capabilities={capabilities} {...extra} />,
  );

/** The opening tag of the checkbox for a step. */
const box = (html: string, name: string) =>
  new RegExp(`<input[^>]*name="step-${name}"[^>]*>`).exec(html)?.[0];

/** The opening tag of the confirmation box of a destructive step. */
const confirmBox = (html: string, name: string) =>
  new RegExp(`<input[^>]*name="confirm-${name}"[^>]*>`).exec(html)?.[0];

describe('StepEditor', () => {
  it('hides ban for an IG-only brand', () => {
    const html = render([]);
    expect(box(html, 'ban')).toBeUndefined();
    expect(html).not.toContain('Ban author');
    expect(box(html, 'hide')).toBeDefined();
  });

  it('keeps a selected step that is no longer supported, so it can be unticked', () => {
    const html = render([{ type: 'ban', confirmHardToReverse: true }], IG_ONLY, {
      issues: [{ path: 'actions.0', message: 'not_supported_anywhere' }],
    });
    expect(box(html, 'ban')).toContain('checked');
    expect(box(html, 'ban')).not.toContain('disabled');
    expect(html).toContain('Not available on Instagram');
    expect(html).toContain('None of the connected accounts support this.');
  });

  it('says where a partly supported step is not available', () => {
    expect(render([], BOTH)).toContain('Not available on Instagram');
  });

  it('lists steps in execution order with their reversibility', () => {
    const html = render([]);
    const order = ['Flag for review', 'Private reply', 'Auto-reply', 'Hide', 'Delete'].map((l) =>
      html.indexOf(l),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain('Irreversible');
    expect(html).toContain('Partly reversible (reply can be deleted)');
  });

  it('delete requires ticking the irreversible box before the form is valid', () => {
    const none = render([]);
    expect(box(none, 'delete')).not.toContain('checked');
    expect(confirmBox(none, 'delete')).toBeUndefined();

    const chosen = render([{ type: 'delete' }]);
    expect(box(chosen, 'delete')).toContain('checked');
    const confirm = confirmBox(chosen, 'delete')!;
    expect(confirm).toContain('required');
    expect(confirm).not.toContain('checked');
    expect(chosen).toContain('I understand deleted comments cannot be restored');

    const confirmed = render([{ type: 'delete', confirmIrreversible: true }]);
    expect(confirmBox(confirmed, 'delete')).toContain('checked');
  });

  it('ban has its own unticked hard-to-reverse box', () => {
    const html = render([{ type: 'ban' }], BOTH);
    expect(confirmBox(html, 'ban')).toContain('required');
    expect(confirmBox(html, 'ban')).not.toContain('checked');
    expect(html).toContain('I understand a ban is hard to reverse');
  });

  it('warns where a step lacks a permission, before saving', () => {
    const caps: ActionCapabilitiesDto = {
      steps: {
        ...IG_ONLY.steps,
        private_reply: {
          platforms: [
            { ...e('instagram', true, 1000), missingScopes: ['instagram_manage_messages'] },
          ],
        },
      },
    };
    const html = render([], caps);
    expect(html).toContain('Needs a permission on Instagram');
    expect(render([], IG_ONLY)).not.toContain('Needs a permission');
  });

  it('disables a conflicting step and says why', () => {
    const html = render([{ type: 'hide' }]);
    expect(box(html, 'auto_reply')).toContain('disabled');
    expect(html).toContain('Can&#x27;t reply to a hidden comment. Remove Hide first.');
    expect(box(html, 'hide')).not.toContain('disabled');
  });

  it('template counter turns invalid above 2200 on IG', () => {
    const over = render([{ type: 'auto_reply', template: 'x'.repeat(2201) }]);
    expect(over).toContain('2201 / 2200');
    expect(over).toMatch(/<textarea[^>]*aria-invalid="true"/);
    const ok = render([{ type: 'auto_reply', template: 'x'.repeat(2200) }]);
    expect(ok).toContain('2200 / 2200');
    expect(ok).not.toContain('aria-invalid');
  });

  it('lists the template variables and shows server errors under their step', () => {
    const html = render(
      [{ type: 'hide' }, { type: 'private_reply', template: '{{nope}}' }],
      IG_ONLY,
      { issues: [{ path: 'actions.1.template', message: 'unknown_variable' }] },
    );
    expect(html).toContain('{{author_first_name}}');
    expect(html).toContain('{{name|fallback}}');
    expect(html).toContain('uses a variable that does not exist');
    expect(html.indexOf('uses a variable')).toBeGreaterThan(
      html.indexOf('name="template-private_reply"'),
    );
  });

  it('renders reply text as text, not markup', () => {
    const html = render([{ type: 'auto_reply', template: '<img src=x onerror=alert(1)>' }]);
    expect(html).not.toContain('<img');
  });
});
