import Link from 'next/link';
import { HiddenList } from '../../components/hidden-today/hidden-list';
import type { HiddenTodayPage } from '../../lib/hidden-today';
import { isUuid } from '../../lib/ids';
import { dataOrThrow, requireMe, serverGet } from '../../lib/server-api';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

export default async function HiddenTodayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requireMe('/hidden-today');
  const sp = await searchParams;
  const before =
    typeof sp.before === 'string' && ISO_UTC.test(sp.before) && !Number.isNaN(Date.parse(sp.before))
      ? sp.before
      : null;
  const beforeId = isUuid(sp.beforeId) ? sp.beforeId : null;
  // The API takes the two cursor parts together or not at all.
  const query = new URLSearchParams();
  if (before && beforeId) {
    query.set('before', before);
    query.set('beforeId', beforeId);
  }
  const page = dataOrThrow(
    await serverGet<HiddenTodayPage>(`/api/v1/me/hidden-today?${query.toString()}`),
    'hidden comments',
  );
  const canManage = Object.fromEntries(
    me.memberships.map((m) => [m.organizationId, m.role === 'owner' || m.role === 'admin']),
  );
  return (
    <main>
      <h1>Hidden today</h1>
      <p>Comments hidden since midnight. Unhide any we got wrong.</p>
      <HiddenList items={page.items} next={page.next} brands={page.brands} canManage={canManage} />
      <p>
        <Link href="/orgs">My organizations</Link>
      </p>
    </main>
  );
}
