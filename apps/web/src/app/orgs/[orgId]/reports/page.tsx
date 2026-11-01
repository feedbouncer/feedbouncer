import { can } from '@feedbouncer/authz';
import { buildView } from '@feedbouncer/reports/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { WeekPicker } from '../../../../components/reports/WeekPicker';
import { WeeklyReport } from '../../../../components/reports/WeeklyReport';
import { PageHeader } from '../../../../components/ui/page-header';
import { isUuid } from '../../../../lib/ids';
import { messageFor } from '../../../../lib/messages';
import { fetchWeeklyReport, parseWeekParam } from '../../../../lib/reports';
import { requireMe, serverGet, type Role } from '../../../../lib/server-api';

export default async function WeeklyReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ week?: string | string[] | undefined }>;
}) {
  const { orgId } = await params;
  if (!isUuid(orgId)) notFound();
  await requireMe(`/orgs/${orgId}/reports`);
  const orgResponse = await serverGet<{ organization: { name: string }; role: Role }>(
    `/api/v1/orgs/${orgId}`,
  );
  if (!orgResponse.data) notFound();
  const org = orgResponse.data;
  if (!can(org.role, 'report.read'))
    return (
      <main>
        <PageHeader title="Weekly report" />
        <p>Only owners and admins can see the weekly report.</p>
      </main>
    );
  const { week } = await searchParams;
  // A malformed week shows the latest report rather than an error.
  const report = await fetchWeeklyReport(orgId, parseWeekParam(week));
  return (
    <main>
      <PageHeader
        title="Weekly report"
        actions={report ? <WeekPicker orgId={orgId} current={report.weekStart} weeks={report.weeks} /> : null}
      />
      {report ? (
        <WeeklyReport view={buildView(report.stats, org.organization.name)} source={report.source} />
      ) : (
        <p role="alert">
          {messageFor('invalid_week')} <Link href={`/orgs/${orgId}/reports`}>Show the latest week</Link>
        </p>
      )}
    </main>
  );
}
