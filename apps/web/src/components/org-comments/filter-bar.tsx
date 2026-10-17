import Link from 'next/link';
import { platformLabel } from '../../lib/actions';
import {
  categoryLabel,
  hasFilters,
  statusLabel,
  type FilterOptionsDto,
  type OrgCommentFilters,
} from '../../lib/org-comments';

function Select({
  name,
  label,
  value,
  children,
}: {
  name: string;
  label: string;
  value: string | null;
  children: React.ReactNode;
}) {
  return (
    <label>
      {label}{' '}
      <select name={name} defaultValue={value ?? ''}>
        <option value="">All</option>
        {children}
      </select>
    </label>
  );
}

export function FilterBar({
  orgId,
  options,
  applied,
  labels,
}: {
  orgId: string;
  options: FilterOptionsDto;
  applied: OrgCommentFilters;
  /** Option text per ad id. */
  labels: Map<string, string>;
}) {
  return (
    <form method="get" action={`/orgs/${orgId}/comments`}>
      <label>
        Show{' '}
        <select name="queue" defaultValue={applied.queue}>
          <option value="open">Open</option>
          <option value="done">Done</option>
          <option value="all">All</option>
        </select>
      </label>{' '}
      <Select name="platform" label="Platform" value={applied.platform}>
        {options.platforms.map((p) => (
          <option key={p} value={p}>
            {platformLabel(p)}
          </option>
        ))}
      </Select>{' '}
      <Select name="ad" label="Ad" value={applied.ad}>
        <option value="none">Not on an ad</option>
        {options.ads.map((a) => (
          <option key={a.adId} value={a.adId}>
            {labels.get(a.adId)}
          </option>
        ))}
      </Select>{' '}
      <Select name="category" label="Category" value={applied.category}>
        <option value="_none">Uncategorized</option>
        {options.categories.map((c) => (
          <option key={c} value={c}>
            {categoryLabel(c)}
          </option>
        ))}
      </Select>{' '}
      <Select name="status" label="Status" value={applied.status}>
        {options.statuses.map((s) => (
          <option key={s} value={s}>
            {statusLabel(s)}
          </option>
        ))}
      </Select>{' '}
      {options.tags.length > 0 ? (
        <>
          <label>
            Tags{' '}
            <select
              name="tag"
              multiple
              defaultValue={applied.tags}
              aria-describedby="tag-filter-hint"
            >
              {options.tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>{' '}
          <small id="tag-filter-hint">Comments must have every selected tag.</small>{' '}
        </>
      ) : null}
      <button type="submit">Apply</button>
      {hasFilters(applied) ? (
        <>
          {' '}
          <Link href={`/orgs/${orgId}/comments`}>Clear filters</Link>
        </>
      ) : null}{' '}
      <Link href={`/orgs/${orgId}/tags`}>Manage tags</Link>
      {options.adsTruncated ? <p>Showing the first 500 ads.</p> : null}
    </form>
  );
}
