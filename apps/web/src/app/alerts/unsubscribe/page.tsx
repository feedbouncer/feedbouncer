import {
  RECIPIENT_COPY,
  RECIPIENT_TOKEN,
  RecipientAction,
} from '../../../components/alerts/recipient-action';

export const metadata = { referrer: 'no-referrer' };

export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] | undefined }>;
}) {
  const { token } = await searchParams;
  const valid = typeof token === 'string' && RECIPIENT_TOKEN.test(token);
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
