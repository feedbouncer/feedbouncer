import Link from 'next/link';
import { Fragment } from 'react';
import { LocalTime } from '../local-time';
import { platformLabel } from '../../lib/actions';
import {
  categoryLabel,
  hasFilters,
  statusLabel,
  type FilterOptionsDto,
  pageHref,
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
  brandName = null,
}: {
  orgId: string;
  options: FilterOptionsDto;
  applied: OrgCommentFilters;
  /** Option text per ad id. */
  labels: Map<string, string>;
  /** Name of the applied brand, for the chip. */
  brandName?: string | null;
}) {
  const deepLink = [applied.brand, applied.from, applied.to, applied.signal].some(
    (v) => v !== null,
  );
  const parts: React.ReactNode[] = [];
  if (applied.signal) parts.push('Negative comments');
  if (applied.brand) parts.push(brandName ?? 'Brand');
  if (applied.from || applied.to)
    parts.push(
      <>
        {applied.from ? <LocalTime iso={applied.from} /> : 'Start'}
        {'–'}
        {applied.to ? <LocalTime iso={applied.to} /> : 'now'}
      </>,
    );
  return (
    <form method="get" action={`/orgs/${orgId}/comments`}>
      {deepLink ? (
        <p>
          <span>
            {parts.map((p, i) => (
              <Fragment key={i}>
                {i > 0 ? ' · ' : null}
                {p}
              </Fragment>
            ))}
          </span>{' '}
          <Link
            aria-label="Remove brand, date range and signal filters"
            href={pageHref(orgId, {
              ...applied,
              brand: null,
              from: null,
              to: null,
              signal: null,
            })}
          >
            ×
          </Link>
        </p>
      ) : null}
      {(['brand', 'from', 'to', 'signal'] as const).map((k) =>
        applied[k] ? <input key={k} type="hidden" name={k} value={applied[k]} /> : null,
      )}
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
