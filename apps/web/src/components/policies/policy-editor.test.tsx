import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PolicyDto } from '../../lib/policies';
import { PolicyEditor } from './policy-editor';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const policy: PolicyDto = {
  id: 'p1',
  name: 'Vague',
  enabled: false,
  text: 'bad stuff',
  action: 'flag',
  revision: 2,
  revisionId: 'r2',
  warnings: ['few_words', 'vague_terms'],
  createdAt: '2026-10-15T10:00:00.000Z',
  updatedAt: '2026-10-15T10:00:00.000Z',
};

describe('PolicyEditor', () => {
  it('offers name, text with a counter and only flag, hide and delete', () => {
    const html = renderToStaticMarkup(<PolicyEditor orgId="o" brandId="b" mode="create" />);
    expect(html).toContain('Name');
    expect(html).toContain('Policy');
    expect(html).toContain('0 / 500');
    expect(html).toContain('Flag for review');
    expect(html).toContain('Hide');
    expect(html).toContain('Delete');
    expect(html).not.toContain('Allow');
    expect(html).not.toContain('value="approve"');
  });

  it('shows the warnings of an existing policy and the next revision number', () => {
    const html = renderToStaticMarkup(
      <PolicyEditor orgId="o" brandId="b" mode="edit" policy={policy} />,
    );
    expect(html).toContain('This policy is very short.');
    expect(html).toContain('are hard to apply consistently');
    expect(html).toContain('Changing the text or action creates revision 3.');
    expect(html).toContain('Run preview');
  });

  it('renders the policy text as text, not markup', () => {
    const html = renderToStaticMarkup(
      <PolicyEditor
        orgId="o"
        brandId="b"
        mode="edit"
        policy={{ ...policy, text: '<img src=x onerror=alert(1)>' }}
      />,
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
