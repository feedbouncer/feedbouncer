import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiForm } from '../../../../../../components/api-form';
import { RemoveDomainButton } from '../../../../../../components/rules/remove-domain-button';
import { isUuid } from '../../../../../../lib/ids';
import { dataOrThrow, requireMe, serverGet } from '../../../../../../lib/server-api';

interface Domain {
  id: string;
  displayDomain: string;
}

export default async function OwnDomainsPage({
  params,
}: {
  params: Promise<{ orgId: string; brandId: string }>;
}) {
  const { orgId, brandId } = await params;
  if (!isUuid(orgId) || !isUuid(brandId)) notFound();
  await requireMe(`/orgs/${orgId}/brands/${brandId}/domains`);
  const { domains } = dataOrThrow(
    await serverGet<{ domains: Domain[] }>(`/api/v1/orgs/${orgId}/brands/${brandId}/domains`),
    'own domains',
  );
  return (
    <main>
      <h1>Own domains</h1>
      <p>
        Links to these domains and their subdomains are never treated as spam by link rules unless a
        rule turns this off.
      </p>
      {domains.length === 0 ? <p>No domains yet.</p> : null}
      <ul>
        {domains.map((d) => (
          <li key={d.id}>
            {d.displayDomain} <RemoveDomainButton orgId={orgId} brandId={brandId} domainId={d.id} />
          </li>
        ))}
      </ul>
      <ApiForm
        action={`/api/v1/orgs/${orgId}/brands/${brandId}/domains`}
        fields={[{ name: 'domain', label: 'Domain', type: 'text' }]}
        submitLabel="Add domain"
        refresh
      />
      <p>
        <Link href={`/orgs/${orgId}/brands/${brandId}/rules`}>Back to rules</Link> ·{' '}
        <Link href={`/orgs/${orgId}/brands/${brandId}/policies`}>Policies</Link>
      </p>
    </main>
  );
}
