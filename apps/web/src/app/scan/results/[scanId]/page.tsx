import type { ScanView } from '@feedbouncer/scan/contract';
import { notFound } from 'next/navigation';
import { isUuid } from '../../../../lib/ids';
import { dataOrThrow, serverGet } from '../../../../lib/server-api';
import { ScanPoller } from '../../_components/scan-poller';
import { FailedView, ResultView } from '../../_components/result-view';
import { ShareControls } from '../../_components/share-controls';

export const dynamic = 'force-dynamic';

export default async function ScanResultPage({ params }: { params: Promise<{ scanId: string }> }) {
  const { scanId } = await params;
  if (!isUuid(scanId)) notFound();
  const scan = dataOrThrow(await serverGet<ScanView>(`/api/v1/scan/scans/${scanId}`), 'scan');
  return (
    <main>
      {scan.status === 'failed' ? (
        <FailedView failureReason={scan.failureReason} />
      ) : scan.status === 'completed' && scan.result ? (
        <>
          <ResultView result={scan.result} pageName={scan.pageName} mode="owner" />
          <ShareControls scanId={scan.id} shared={scan.shared} />
        </>
      ) : (
        <ScanPoller scanId={scan.id} />
      )}
    </main>
  );
}
