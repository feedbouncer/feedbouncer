// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ExampleComment from '../src/components/ExampleComment';
import FeatureStatus from '../src/components/FeatureStatus';
import manifest from '../../../docs/mcp/tools.json';
import McpToolReference from '../src/components/McpToolReference';
import ReferenceTable from '../src/components/ReferenceTable';
import RepoLink from '../src/components/RepoLink';
import Term from '../src/components/Term';
import WorkedExample from '../src/components/WorkedExample';
import { workedExampleSchema } from '../src/examples/schema';

const activeVersion = vi.hoisted(() => ({ name: 'current' }));
vi.mock('@docusaurus/plugin-content-docs/client', () => ({
  useActiveVersion: () => activeVersion,
}));

afterEach(() => {
  cleanup();
  activeVersion.name = 'current';
});

describe('ExampleComment', () => {
  it('renders markup literally, labelled as invented', () => {
    const { container } = render(<ExampleComment text={'<script>alert(1)</script>'} />);
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('<script>alert(1)</script>')).toBeTruthy();
    expect(container.querySelector('figcaption')?.textContent).toBe('Invented example');
  });

  it('marks mild abusive language', () => {
    const { container } = render(<ExampleComment text="x" mild />);
    expect(container.querySelector('figcaption')?.textContent).toBe(
      'Invented example (mild sample of abusive language)',
    );
  });
});

describe('FeatureStatus', () => {
  it.each([
    ['partial', 'Partial'],
    ['planned', 'Planned'],
    ['unsupported', 'Not supported'],
  ] as const)('labels %s as %s', (status, label) => {
    render(<FeatureStatus status={status}>Body text</FeatureStatus>);
    const note = screen.getByRole('note');
    expect(within(note).getByText(label)).toBeTruthy();
    expect(within(note).getByText('Body text')).toBeTruthy();
  });
});

const example = workedExampleSchema.parse({
  id: 'spam-links',
  title: 'Spam link',
  case: 'spam_links',
  rules: [
    {
      name: 'Block links',
      conditions: { type: 'link_domain', domains: ['spam.example.com'], mode: 'blocklist' },
      actions: [{ type: 'hide' }],
      mode: 'enforce',
      enabled: true,
      priority: 1,
    },
  ],
  brand: { ownDomains: ['feedbouncer.example.com'] },
  comment: { text: 'Visit spam.example.com now', mild: false },
  expected: {
    decidedRule: 'Block links',
    outcome: 'hide',
    steps: ['hide'],
    suggestions: [],
    alsoMatched: [],
  },
});

describe('WorkedExample', () => {
  it('shows the rule, sample input and decision', () => {
    render(<WorkedExample data={example} />);
    for (const name of ['Rule', 'Sample input', 'Decision'])
      expect(screen.getByRole('heading', { name })).toBeTruthy();
    expect(screen.getByText('Visit spam.example.com now')).toBeTruthy();
    expect(document.querySelector('pre code')?.textContent).toContain('"link_domain"');
  });
});

describe('RepoLink', () => {
  it('links to main for the current version', () => {
    render(<RepoLink path="docs/api/openapi.json">spec</RepoLink>);
    expect(screen.getByRole('link', { name: 'spec' }).getAttribute('href')).toBe(
      'https://github.com/feedbouncer/feedbouncer/blob/main/docs/api/openapi.json',
    );
  });

  it('links to the release tag for a released version', () => {
    activeVersion.name = '1.2.0';
    render(<RepoLink path="docs/api/openapi.json">spec</RepoLink>);
    expect(screen.getByRole('link', { name: 'spec' }).getAttribute('href')).toBe(
      'https://github.com/feedbouncer/feedbouncer/blob/v1.2.0/docs/api/openapi.json',
    );
  });
});

describe('ReferenceTable', () => {
  it('has a caption and column headers', () => {
    render(
      <ReferenceTable
        kind="errors"
        data={[{ code: 'invalid_request', status: 400, meaning: 'The request is malformed.' }]}
      />,
    );
    const table = screen.getByRole('table', { name: /error/i });
    expect(table.querySelector('caption')?.textContent).toMatch(/error/i);
    const headers = [...table.querySelectorAll('th[scope="col"]')].map((h) => h.textContent);
    expect(headers).toEqual(['Code', 'Status', 'Meaning']);
    expect(within(table).getByText('invalid_request')).toBeTruthy();
  });
});

describe('Term', () => {
  it('links to the glossary entry', () => {
    render(<Term id="dry-run">dry run</Term>);
    expect(screen.getByRole('link', { name: 'dry run' }).getAttribute('href')).toBe(
      '/docs/concepts/glossary#dry-run',
    );
  });
});

describe('McpToolReference', () => {
  it('renders the input and output tables of a tool from the manifest', () => {
    const { container } = render(<McpToolReference name="list_inbox" manifest={manifest} />);
    const captions = [...container.querySelectorAll('caption')].map((c) => c.textContent);
    expect(captions).toEqual(['list_inbox input', 'list_inbox structured output']);
    const [input] = container.querySelectorAll('table');
    const limit = within(input!).getByText('limit').closest('tr')!;
    expect(limit.textContent).toContain('1 to 50');
    expect(limit.textContent).toContain('default 20');
    expect(within(input!).getByText('status').closest('tr')!.textContent).toContain(
      'visible | hidden',
    );
  });

  it('marks required inputs', () => {
    const { container } = render(<McpToolReference name="reply_to_comment" manifest={manifest} />);
    const row = (name: string) => within(container).getAllByText(name)[0]!.closest('tr')!;
    expect(row('commentId').cells[2]!.textContent).toBe('yes');
    expect(row('idempotencyKey').cells[2]!.textContent).toBe('no');
  });

  it('refuses a tool that is not in the manifest', () => {
    expect(() => render(<McpToolReference name="no_such_tool" manifest={manifest} />)).toThrow(
      'Unknown MCP tool',
    );
  });
});
