import { notFound } from 'next/navigation';
import { ApiForm } from '../../../../../../components/api-form';
import { RemoveDomainButton } from '../../../../../../components/rules/remove-domain-button';
import { Card, CardContent, CardHeader, CardTitle } from '../../../../../../components/ui/card';
import { ListPanel, ListRow } from '../../../../../../components/ui/list';
import { PageHeader } from '../../../../../../components/ui/page-header';
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
      <PageHeader
        title="Own domains"
        description="Links to these domains and their subdomains are never treated as spam by link rules unless a rule turns this off."
      />
      {domains.length === 0 ? (
        <p data-state="empty">No domains yet.</p>
      ) : (
        <ListPanel>
          {domains.map((d) => (
            <ListRow key={d.id}>
              <span className="font-semibold text-foreground">{d.displayDomain}</span>
              <RemoveDomainButton orgId={orgId} brandId={brandId} domainId={d.id} />
            </ListRow>
          ))}
        </ListPanel>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Add a domain</CardTitle>
        </CardHeader>
        <CardContent>
          <ApiForm
            action={`/api/v1/orgs/${orgId}/brands/${brandId}/domains`}
            fields={[{ name: 'domain', label: 'Domain', type: 'text' }]}
            submitLabel="Add domain"
            refresh
            layout="inline"
            variant="primary"
            className="max-w-sm"
          />
        </CardContent>
      </Card>
    </main>
  );
}
