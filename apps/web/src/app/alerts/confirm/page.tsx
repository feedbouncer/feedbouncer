import { RecipientAction } from '../../../components/alerts/recipient-action';
import { RECIPIENT_COPY, RECIPIENT_TOKEN } from '../../../lib/alerts';

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
      <h1>Confirm alerts</h1>
      {valid ? (
        <RecipientAction kind="confirm" token={token} />
      ) : (
        <p>{RECIPIENT_COPY.confirm.invalid}</p>
      )}
    </main>
  );
}
