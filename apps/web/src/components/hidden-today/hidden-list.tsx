'use client';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import {
  hiddenTodayHref,
  type BrandDayDto,
  type HiddenItemDto,
  type HiddenTodayPage,
} from '../../lib/hidden-today';
import { HiddenRow } from './hidden-row';
import { TimezoneNotice } from './timezone-notice';

export function HiddenList(props: {
  items: HiddenItemDto[];
  next: HiddenTodayPage['next'];
  brands: BrandDayDto[];
  /** Whether the viewer may change settings, by organization id. */
  canManage: Record<string, boolean>;
}) {
  // Rows update in place from unhide results and polling, with no page reload.
  const [updates, setUpdates] = useState<Record<string, HiddenItemDto>>({});
  const onChange = useCallback(
    (item: HiddenItemDto) => setUpdates((u) => ({ ...u, [item.hideActionId]: item })),
    [],
  );
  const items = props.items.map((i) => updates[i.hideActionId] ?? i);

  return (
    <>
      {items.length === 0 ? (
        <section data-state="empty">
          <h2>Nothing hidden today</h2>
          <p>
            When FeedBouncer or someone on your team hides a comment, it appears here so you can
            undo it with one click.
          </p>
        </section>
      ) : null}
      {props.brands.map((b) => {
        const rows = items.filter((i) => i.brandId === b.brandId);
        return (
          <section key={b.brandId}>
            <div className="flex flex-col gap-1">
              <h2>{b.brandName}</h2>
              <p className="text-small text-dim">{`Since midnight (${b.timezone})`}</p>
            </div>
            {b.timezoneSet ? null : (
              <TimezoneNotice
                orgId={b.organizationId}
                brandId={b.brandId}
                brandName={b.brandName}
                canManage={props.canManage[b.organizationId] === true}
              />
            )}
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
              {rows.map((i) => (
                <HiddenRow key={i.hideActionId} item={i} onChange={onChange} />
              ))}
            </ul>
          </section>
        );
      })}
      {props.next ? (
        <Link href={hiddenTodayHref(props.next)} className="self-start text-small font-medium">
          Load more
        </Link>
      ) : null}
    </>
  );
}
