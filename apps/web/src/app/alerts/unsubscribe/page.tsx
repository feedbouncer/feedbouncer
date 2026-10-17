import { RECIPIENT_COPY, RecipientAction } from '../../../components/alerts/recipient-action';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const metadata = { referrer: 'no-referrer' };

export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] | undefined }>;
}) {
  const { token } = await searchParams;
  const valid = typeof token === 'string' && TOKEN.test(token);
  return (
    <main>
      <h1>Unsubscribe from alerts</h1>
      {valid ? (
        <RecipientAction kind="unsubscribe" token={token} />
      ) : (
        <p>{RECIPIENT_COPY.unsubscribe.invalid}</p>
      )}
    </main>
  );
}
