import { REPORT_TOKEN_RE } from '@feedbouncer/reports/shared';
import { ReportUnsubscribe } from '../../../components/reports/ReportUnsubscribe';

export const metadata = { referrer: 'no-referrer' };

export default async function ReportUnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] | undefined }>;
}) {
  const { token } = await searchParams;
  return (
    <main>
      <h1>Unsubscribe from the weekly report</h1>
      <ReportUnsubscribe
        token={typeof token === 'string' && REPORT_TOKEN_RE.test(token) ? token : null}
      />
    </main>
  );
}
