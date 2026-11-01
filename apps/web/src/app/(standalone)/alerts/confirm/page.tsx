import { RecipientAction } from '../../../../components/alerts/recipient-action';
import { Card, CardContent, CardHeader, CardTitle } from '../../../../components/ui/card';
import { RECIPIENT_COPY, RECIPIENT_TOKEN } from '../../../../lib/alerts';

export const metadata = { referrer: 'no-referrer' };

export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] | undefined }>;
}) {
  const { token } = await searchParams;
  const valid = typeof token === 'string' && RECIPIENT_TOKEN.test(token);
  return (
    <main>
      <Card className="mx-auto max-w-form">
        <CardHeader>
          <CardTitle>
            <h1 className="text-card-title font-semibold tracking-normal">Confirm alerts</h1>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {valid ? (
            <RecipientAction kind="confirm" token={token} />
          ) : (
            <p>{RECIPIENT_COPY.confirm.invalid}</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
