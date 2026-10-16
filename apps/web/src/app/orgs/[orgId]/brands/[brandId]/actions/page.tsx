import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionLog, type LogFilters } from '../../../../../../components/actions/action-log';
import {
  STEP_ORDER,
  STEP_STATUSES,
  type LogEntryView,
  type Page,
} from '../../../../../../lib/actions';
import { isUuid } from '../../../../../../lib/ids';
import type { RuleView } from '../../../../../../lib/rules';
import { dataOrThrow, requireMe, serverGet } from '../../../../../../lib/server-api';

const one = (v: string | string[] | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

export default async function ActionLogPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; brandId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId, brandId } = await params;
  if (!isUuid(orgId) || !isUuid(brandId)) notFound();
  await requireMe(`/orgs/${orgId}/brands/${brandId}/actions`);
  const sp = await searchParams;
  const ruleId = one(sp.ruleId);
  const before = one(sp.before);
  const status = STEP_STATUSES.find((s) => s === sp.status);
  const type = STEP_ORDER.find((t) => t === sp.type);
  const filters: LogFilters = {
    ...(isUuid(ruleId) && { ruleId }),
    ...(status && { status }),
    ...(type && { type }),
  };
  const query = new URLSearchParams(Object.entries(filters));
  query.set('limit', '50');
  if (isUuid(before)) query.set('before', before);

  const base = `/api/v1/orgs/${orgId}/brands/${brandId}` as const;
  const log = dataOrThrow(
    await serverGet<Page<LogEntryView>>(`${base}/action-log?${query.toString()}`),
    'action log',
  );
  const { rules } = dataOrThrow(await serverGet<{ rules: RuleView[] }>(`${base}/rules`), 'rules');
  const brand = `/orgs/${orgId}/brands/${brandId}`;
  return (
    <main>
      <h1>Action log</h1>
      <ActionLog
        orgId={orgId}
        brandId={brandId}
        entries={log.items}
        rules={rules.map((r) => ({ id: r.id, name: r.name }))}
        filters={filters}
        next={log.next}
      />
      <p>
        <Link href={`${brand}/review`}>Review queue</Link> ·{' '}
        <Link href={`${brand}/rules`}>Back to rules</Link>
      </p>
    </main>
  );
}
