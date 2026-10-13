import { notFound } from 'next/navigation';
import {
  AccountPicker,
  type PickerAccount,
} from '../../../../../../../../components/account-picker';
import { ConnectButton } from '../../../../../../../../components/connect-button';
import { messageFor } from '../../../../../../../../lib/messages';
import { isUuid } from '../../../../../../../../lib/ids';
import { PLATFORM_COPY, isConnectable } from '../../../../../../../../lib/platforms';
import { requireMe, serverGet } from '../../../../../../../../lib/server-api';

export default async function SelectAccountsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; brandId: string; platform: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId, brandId, platform } = await params;
  const { grant } = await searchParams;
  if (!isConnectable(platform) || !isUuid(orgId) || !isUuid(brandId) || !isUuid(grant)) notFound();
  const copy = PLATFORM_COPY[platform];
  const title = platform === 'facebook' ? 'Choose Pages' : `Choose ${copy.accountNoun}s`;
  await requireMe(`/orgs/${orgId}/brands/${brandId}/connections/${platform}/select?grant=${grant}`);
  const r = await serverGet<{ accounts: PickerAccount[] }>(
    `/api/v1/orgs/${orgId}/brands/${brandId}/connections/${platform}/grants/${grant}`,
  );
  if (r.status === 403) {
    return (
      <main>
        <h1>{title}</h1>
        <p role="alert">{messageFor('forbidden')}</p>
      </main>
    );
  }
  if (r.status === 404 || r.status === 502) {
    return (
      <main>
        <h1>{title}</h1>
        <p role="alert">
          {r.status === 404
            ? 'This sign-in has expired. Connect again.'
            : messageFor('platform_error')}
        </p>
        <ConnectButton
          orgId={orgId}
          brandId={brandId}
          platform={platform}
          label={copy.connectLabel}
        />
      </main>
    );
  }
  if (!r.data) throw new Error(`Could not load accounts (status ${r.status})`);
  return (
    <main>
      <h1>{title}</h1>
      <AccountPicker
        orgId={orgId}
        brandId={brandId}
        platform={platform}
        grantId={grant}
        accounts={r.data.accounts}
      />
    </main>
  );
}
