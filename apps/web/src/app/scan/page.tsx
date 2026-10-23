import type { ScanView } from '@feedbouncer/scan/contract';
import Link from 'next/link';
import { serverGet } from '../../lib/server-api';
import { ConnectButton } from './_components/connect-button';
import { errorCopy, scopeLabel } from './_components/copy';
import { DeleteDataButton } from './_components/delete-data-button';

export const dynamic = 'force-dynamic';

const first = (v: string | string[] | undefined) => (typeof v === 'string' ? v : null);

function statusText(s: ScanView): string {
  if (s.status === 'completed') return 'Done';
  return s.status === 'failed' ? 'Did not finish' : 'In progress';
}

export default async function ScanPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const error = errorCopy(first(sp.error));
  const missing = [
    ...new Set((first(sp.missing) ?? '').split(',').flatMap((s) => scopeLabel(s) ?? [])),
  ];
  const list = await serverGet<{ scans: ScanView[] }>('/api/v1/scan/scans');
  const scans = list.data?.scans ?? [];
  return (
    <main>
      <h1>How many comments on your ads are scams?</h1>
      <p>
        Connect your Facebook account and we will check the comments on your last ads for scams and
        spam. It is free, and read-only: we never hide, delete or post anything.
      </p>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          {missing.length > 0 ? (
            <ul>
              {missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <ConnectButton />
      {scans.length > 0 ? (
        <section>
          <h2>Your previous scans</h2>
          <ul>
            {scans.map((s) => (
              <li key={s.id}>
                <Link href={`/scan/results/${s.id}`}>{s.pageName}</Link> ·{' '}
                {new Date(s.createdAt).toISOString().slice(0, 10)} · {statusText(s)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <h2>Your data</h2>
        <p>We keep results for 30 days. You can delete everything we hold about you now.</p>
        <DeleteDataButton />
      </section>
    </main>
  );
}
