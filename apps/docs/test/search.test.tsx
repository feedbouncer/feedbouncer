// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SEARCH_SUGGESTIONS,
  fallbackQueries,
  safeResultUrl,
  versionForPath,
  type Pagefind,
} from '../src/search/core';
import SearchView from '../src/search/SearchView';

const versions = [
  { name: 'current', path: 'next' },
  { name: '1.2.0', path: '' },
  { name: '1.1.0', path: '1.1.0' },
];

afterEach(cleanup);

describe('versionForPath', () => {
  it('uses the version in the path and falls back to the default', () => {
    expect(versionForPath('/feedbouncer/docs/next/x/', versions)).toBe('current');
    expect(versionForPath('/feedbouncer/docs/x/', versions)).toBe('1.2.0');
    expect(versionForPath('/feedbouncer/search/', versions)).toBe('1.2.0');
    expect(versionForPath('/feedbouncer/docs/1.1.0/api/quickstart/', versions)).toBe('1.1.0');
    expect(versionForPath('/feedbouncer/docs/', versions)).toBe('1.2.0');
  });
});

describe('safeResultUrl', () => {
  it('rejects non-relative and foreign URLs', () => {
    for (const bad of [
      'javascript:alert(1)',
      '//evil.example/x',
      'https://evil.example/x',
      '/other-base/docs/x',
      '/feedbouncer//evil',
      '/feedbouncer/../evil',
      '/feedbouncer/\\evil',
    ])
      expect(safeResultUrl(bad, '/feedbouncer/')).toBeNull();
    expect(safeResultUrl('/feedbouncer/docs/api/quickstart/', '/feedbouncer/')).toBe(
      '/feedbouncer/docs/api/quickstart/',
    );
  });
});

describe('fallbackQueries', () => {
  it('splits, lowercases, drops short words, de-duplicates and caps at 5', () => {
    expect(fallbackQueries('How TO Ban a Ban user')).toEqual(['how', 'ban', 'user']);
    expect(fallbackQueries('alpha beta gamma delta epsilon zeta eta')).toHaveLength(5);
    expect(fallbackQueries('a bc')).toEqual([]);
  });
});

describe('SEARCH_SUGGESTIONS', () => {
  it('lists the section starts and three key pages', () => {
    expect(SEARCH_SUGGESTIONS.map((s) => s.to)).toEqual([
      '/docs/concepts/overview',
      '/docs/rules/overview',
      '/docs/api/overview',
      '/docs/mcp/overview',
      '/docs/concepts/glossary',
      '/docs/api/quickstart',
      '/docs/mcp/verify',
    ]);
  });
});

const hit = (url: string, title: string, plain_excerpt: string) => ({
  id: url,
  data: async () => ({ url, meta: { title }, plain_excerpt }),
});

describe('SearchView', () => {
  const none: Pagefind = { search: async () => ({ results: [] }) };
  const props = { version: 'current', baseUrl: '/feedbouncer/' };

  it('renders a <script> query as text', async () => {
    const q = '<script>window.pwned=1</script>';
    const { container } = render(<SearchView {...props} q={q} loadPagefind={async () => none} />);
    await waitFor(() => expect(screen.getByText(/No pages match/)).toBeTruthy());
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText(`No pages match '${q}'. Try one of these:`)).toBeTruthy();
    expect(screen.getAllByRole('link')).toHaveLength(SEARCH_SUGGESTIONS.length);
  });

  it('renders titles and excerpts as text and drops unsafe links', async () => {
    const pagefind: Pagefind = {
      search: async () => ({
        results: [
          hit('/feedbouncer/docs/a/', '<b>Title</b>', '<img src=x onerror=alert(1)>'),
          hit('javascript:alert(1)', 'Evil', 'bad'),
        ],
      }),
    };
    const { container } = render(
      <SearchView {...props} q="x" loadPagefind={async () => pagefind} />,
    );
    await waitFor(() => expect(screen.getByText('<b>Title</b>')).toBeTruthy());
    expect(container.querySelector('img, b')).toBeNull();
    expect(screen.queryByText('Evil')).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('searches with the version filter and merges per-word fallbacks', async () => {
    const calls: [string, unknown][] = [];
    const pagefind: Pagefind = {
      search: async (term, options) => {
        calls.push([term, options]);
        return { results: term === 'ban' ? [hit('/feedbouncer/docs/ban/', 'Ban', 'Bans')] : [] };
      },
    };
    render(<SearchView {...props} q="how ban" loadPagefind={async () => pagefind} />);
    await waitFor(() => expect(screen.getByText('Ban')).toBeTruthy());
    expect(calls[0]).toEqual(['how ban', { filters: { version: 'current' } }]);
    expect(calls.map((c) => c[0])).toEqual(['how ban', 'how', 'ban']);
  });

  it('says search is unavailable when the index cannot load', async () => {
    render(
      <SearchView
        {...props}
        q="x"
        loadPagefind={async () => {
          throw new Error('offline');
        }}
      />,
    );
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });
});
