import { notFound } from 'next/navigation';
import { ConnectButton } from '../../../../../../../../components/connect-button';
import { PagePicker, type PageAccount } from '../../../../../../../../components/page-picker';
import { isUuid } from '../../../../../../../../lib/ids';
import { requireMe, serverGet } from '../../../../../../../../lib/server-api';

export default async function SelectPagesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; brandId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId, brandId } = await params;
  const { grant } = await searchParams;
  if (!isUuid(orgId) || !isUuid(brandId) || !isUuid(grant)) notFound();
  await requireMe(`/orgs/${orgId}/brands/${brandId}/connections`);
  const r = await serverGet<{ accounts: PageAccount[] }>(
    `/api/v1/orgs/${orgId}/brands/${brandId}/connections/facebook/grants/${grant}`,
  );
  if (r.status === 404 || r.status === 403) {
    return (
      <main>
        <h1>Choose Pages</h1>
        <p role="alert">This sign-in has expired. Connect again.</p>
        <ConnectButton orgId={orgId} brandId={brandId} label="Connect Facebook Page" />
      </main>
    );
  }
  if (!r.data) throw new Error(`Could not load Pages (status ${r.status})`);
  return (
    <main>
      <h1>Choose Pages</h1>
      <PagePicker orgId={orgId} brandId={brandId} grantId={grant} accounts={r.data.accounts} />
    </main>
  );
}
