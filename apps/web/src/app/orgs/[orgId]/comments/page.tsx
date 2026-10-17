import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AccountNotices } from '../../../../components/org-comments/account-notices';
import { CommentRow } from '../../../../components/org-comments/comment-row';
import { EmptyState } from '../../../../components/org-comments/empty-state';
import { FilterBar } from '../../../../components/org-comments/filter-bar';
import { LocalTime } from '../../../../components/local-time';
import { isUuid } from '../../../../lib/ids';
import {
  adOptionLabels,
  apiQuery,
  hasFilters,
  pageHref,
  parseSearchParams,
  totalText,
  type CommentFiltersDto,
  type CommentsPageDto,
} from '../../../../lib/org-comments';
import { requireMe, serverGet } from '../../../../lib/server-api';

export default async function OrgCommentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  if (!isUuid(orgId)) notFound();
  await requireMe(`/orgs/${orgId}/comments`);
  const { filters, cursor } = parseSearchParams(await searchParams);
  const base = `/api/v1/orgs/${orgId}/comments` as const;
  const [list, meta] = await Promise.all([
    serverGet<CommentsPageDto>(`${base}?${apiQuery(filters, cursor)}`),
    serverGet<CommentFiltersDto>(`${base}/filters`),
  ]);
  if (list.status === 404 || meta.status === 404) notFound();
  if (list.status === 403 || meta.status === 403)
    return (
      <main>
        <h1>Comments</h1>
        <p role="alert">You don&apos;t have access to comments in this workspace.</p>
      </main>
    );
  if (!list.data || !meta.data)
    return (
      <main>
        <h1>Comments</h1>
        <p role="alert">Couldn&apos;t load comments.</p>
        <p>
          <Link href={pageHref(orgId, filters, cursor)}>Try again</Link>
        </p>
      </main>
    );
  const { items, next, total, applied } = list.data;
  const { options, accounts, lastSyncedAt, canManageConnections } = meta.data;
  return (
    <main>
      <h1>Comments</h1>
      <p>
        {lastSyncedAt ? (
          <>
            Last synced <LocalTime iso={lastSyncedAt} exactTitle />
          </>
        ) : (
          'Not synced yet'
        )}
      </p>
      <AccountNotices orgId={orgId} accounts={accounts} canManage={canManageConnections} />
      {accounts.length === 0 ? (
        <EmptyState kind="no_accounts" orgId={orgId} canManage={canManageConnections} />
      ) : (
        <>
          <FilterBar
            orgId={orgId}
            options={options}
            applied={applied}
            labels={adOptionLabels(options.ads)}
          />
          <p>{totalText(total)}</p>
          {items.length === 0 ? (
            <EmptyState
              kind={hasFilters(applied) ? 'no_match' : 'no_comments'}
              orgId={orgId}
              canManage={canManageConnections}
            />
          ) : (
            <ul>
              {items.map((c) => (
                <CommentRow key={c.id} item={c} />
              ))}
            </ul>
          )}
          <p>
            {next ? <Link href={pageHref(orgId, applied, next)}>Older comments</Link> : null}
            {next && cursor ? ' · ' : null}
            {cursor ? <Link href={pageHref(orgId, applied)}>Back to newest</Link> : null}
          </p>
        </>
      )}
    </main>
  );
}
