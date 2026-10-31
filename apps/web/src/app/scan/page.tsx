import type { ScanView } from '@feedbouncer/scan/contract';
import Link from 'next/link';
import { serverGet } from '../../lib/server-api';
import { ConnectButton } from './_components/connect-button';
import { errorCopy, scopeLabel } from './_components/copy';
import { DeleteDataButton } from './_components/delete-data-button';
import { Badge } from '../../components/ui/badge';
import { Card, CardContent } from '../../components/ui/card';

export const dynamic = 'force-dynamic';

const first = (v: string | string[] | undefined) => (typeof v === 'string' ? v : null);

function statusText(s: ScanView): string {
  if (s.status === 'completed') return 'Done';
  return s.status === 'failed' ? 'Did not finish' : 'In progress';
}

function statusVariant(s: ScanView): 'good' | 'coral' | 'secondary' {
  if (s.status === 'completed') return 'good';
  return s.status === 'failed' ? 'coral' : 'secondary';
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
    <main className="flex flex-col gap-8">
      <h1 className="text-center text-hero tracking-hero">
        How many comments on your ads are scams?
      </h1>
      <p className="mx-auto max-w-lede text-center text-lede text-dim">
        Connect your Facebook account and we will check the comments on your last ads for scams and
        spam. It is free, and read-only: we never hide, delete or post anything.
      </p>
      {error ? (
        <div role="alert" className="mx-auto w-full max-w-lede">
          <p>{error}</p>
          {missing.length > 0 ? (
            <ul className="ms-5 list-disc">
              {missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-col items-center gap-3">
        <ConnectButton />
      </div>
      {scans.length > 0 ? (
        <section className="flex flex-col gap-4">
          <h2>Your previous scans</h2>
          <ul className="flex flex-col gap-3">
            {scans.map((s) => (
              <li key={s.id}>
                <Card className="flex-row flex-wrap items-center gap-x-3 gap-y-2 px-(--fb-card-pad) py-4">
                  <Link
                    href={`/scan/results/${s.id}`}
                    className="min-w-0 flex-1 break-words font-semibold"
                  >
                    {s.pageName}
                  </Link>
                  <span className="text-small text-dim">
                    {new Date(s.createdAt).toISOString().slice(0, 10)}
                  </span>
                  <Badge variant={statusVariant(s)}>{statusText(s)}</Badge>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <Card className="bg-elevated">
          <CardContent className="flex flex-col items-start gap-4">
            <h2>Your data</h2>
            <p>We keep results for 30 days. You can delete everything we hold about you now.</p>
            <DeleteDataButton />
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
