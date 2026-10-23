import type { SharedScanView } from '@feedbouncer/scan/contract';
import { notFound } from 'next/navigation';
import { dataOrThrow, serverGet } from '../../../../lib/server-api';
import { ResultView } from '../../_components/result-view';

export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false, follow: false } };

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export default async function SharedScanPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!TOKEN.test(token)) notFound();
  const shared = dataOrThrow(
    await serverGet<SharedScanView>(`/api/v1/scan/shared/${token}`),
    'shared result',
  );
  return (
    <main>
      <ResultView result={shared.result} pageName={shared.pageName} mode="shared" />
    </main>
  );
}
