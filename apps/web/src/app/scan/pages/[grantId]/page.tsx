import type { ScanPageOption } from '@feedbouncer/scan/contract';
import { notFound } from 'next/navigation';
import { isUuid } from '../../../../lib/ids';
import { dataOrThrow, serverGet } from '../../../../lib/server-api';
import { PagePicker } from '../../_components/page-picker';

export const dynamic = 'force-dynamic';

export default async function ScanPagesPage({ params }: { params: Promise<{ grantId: string }> }) {
  const { grantId } = await params;
  if (!isUuid(grantId)) notFound();
  const { pages, instagramGranted } = dataOrThrow(
    await serverGet<{ pages: ScanPageOption[]; instagramGranted: boolean }>(
      `/api/v1/scan/grants/${grantId}`,
    ),
    'Pages',
  );
  return (
    <main className="mx-auto flex w-full max-w-form flex-col gap-6">
      <h1>Choose a Page</h1>
      {pages.length === 0 ? (
        <p className="text-dim">We found no Pages on this Facebook account.</p>
      ) : (
        <PagePicker grantId={grantId} pages={pages} />
      )}
      {instagramGranted ? null : (
        <p className="text-small text-dim">
          Instagram comments will not be included: Instagram access was not granted.
        </p>
      )}
    </main>
  );
}
