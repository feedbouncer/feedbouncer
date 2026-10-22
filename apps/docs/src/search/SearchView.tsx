import { useEffect, useState, type ReactNode } from 'react';
import { SEARCH_SUGGESTIONS, runSearch, type Pagefind, type SearchResult } from './core';

interface Props {
  q: string;
  version: string;
  baseUrl: string;
  loadPagefind: () => Promise<Pagefind>;
}

type State = { status: 'idle' | 'loading' | 'error' } | { status: 'done'; results: SearchResult[] };

export default function SearchView({ q, version, baseUrl, loadPagefind }: Props): ReactNode {
  const [state, setState] = useState<State>({ status: q ? 'loading' : 'idle' });

  useEffect(() => {
    if (!q) return setState({ status: 'idle' });
    let current = true;
    setState({ status: 'loading' });
    loadPagefind()
      .then((pagefind) => runSearch(pagefind, q, version, baseUrl))
      .then(
        (results) => current && setState({ status: 'done', results }),
        () => current && setState({ status: 'error' }),
      );
    return () => {
      current = false;
    };
  }, [q, version, baseUrl, loadPagefind]);

  return (
    <>
      <form action={`${baseUrl}search/`} method="get" role="search">
        <label htmlFor="search-page-input">Search the documentation</label>
        <input id="search-page-input" type="search" name="q" defaultValue={q} />
        <input type="hidden" name="version" value={version} />
        <button type="submit">Search</button>
      </form>
      <div aria-live="polite">
        {state.status === 'loading' && <p>Searching…</p>}
        {state.status === 'error' && <p role="alert">Search is unavailable right now.</p>}
        {state.status === 'done' && state.results.length > 0 && (
          <ul>
            {state.results.map((r) => (
              <li key={r.url}>
                <a href={r.url}>{r.title}</a>
                <p>{r.excerpt}</p>
              </li>
            ))}
          </ul>
        )}
        {state.status === 'done' && state.results.length === 0 && (
          <>
            <p>{`No pages match '${q}'. Try one of these:`}</p>
            <ul>
              {SEARCH_SUGGESTIONS.map((s) => (
                <li key={s.to}>
                  <a href={`${baseUrl}${s.to.slice(1)}`}>{s.title}</a>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}
