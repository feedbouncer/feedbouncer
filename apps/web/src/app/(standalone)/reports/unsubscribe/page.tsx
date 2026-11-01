import { REPORT_TOKEN_RE } from '@feedbouncer/reports/shared';
import { ReportUnsubscribe } from '../../../../components/reports/ReportUnsubscribe';
import { Card, CardContent, CardHeader, CardTitle } from '../../../../components/ui/card';

export const metadata = { referrer: 'no-referrer' };

export default async function ReportUnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] | undefined }>;
}) {
  const { token } = await searchParams;
  return (
    <main>
      <Card className="mx-auto max-w-form">
        <CardHeader>
          <CardTitle>
            <h1 className="text-card-title font-semibold tracking-normal">
              Unsubscribe from the weekly report
            </h1>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ReportUnsubscribe
            token={typeof token === 'string' && REPORT_TOKEN_RE.test(token) ? token : null}
          />
        </CardContent>
      </Card>
    </main>
  );
}
