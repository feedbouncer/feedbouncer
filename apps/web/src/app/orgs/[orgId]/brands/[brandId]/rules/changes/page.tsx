import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BackLink } from '../../../../../../../components/ui/back-link';
import { ListPanel, ListRow } from '../../../../../../../components/ui/list';
import { PageHeader } from '../../../../../../../components/ui/page-header';
import { formatUtc } from '../../../../../../../lib/format';
import { isUuid } from '../../../../../../../lib/ids';
import type { RuleChangeView } from '../../../../../../../lib/rule-changes';
import { dataOrThrow, requireMe, serverGet } from '../../../../../../../lib/server-api';

export default async function RuleChangesPage({
  params,
}: {
  params: Promise<{ orgId: string; brandId: string }>;
}) {
  const { orgId, brandId } = await params;
  if (!isUuid(orgId) || !isUuid(brandId)) notFound();
  const rules = `/orgs/${orgId}/brands/${brandId}/rules`;
  await requireMe(`${rules}/changes`);
  const { changes } = dataOrThrow(
    await serverGet<{ changes: RuleChangeView[] }>(
      `/api/v1/orgs/${orgId}/brands/${brandId}/rule-changes`,
    ),
    'rule changes',
  );
  return (
    <main>
      <BackLink href={rules}>Back to rules</BackLink>
      <PageHeader
        title="Rule changes"
        description="Changes proposed through the API. Nothing applies until a person approves it."
      />
      {changes.length === 0 ? (
        <p data-state="empty">No rule changes yet.</p>
      ) : (
        <ListPanel>
          {changes.map((c) => (
            <ListRow key={c.id}>
              <Link href={`${rules}/changes/${c.id}`} className="font-medium">
                {c.operation} by {c.proposedBy.apiKeyName}
              </Link>
              <span className="text-small text-dim">
                {c.isStale ? 'stale' : c.status} · expires {formatUtc(c.expiresAt)}
              </span>
            </ListRow>
          ))}
        </ListPanel>
      )}
    </main>
  );
}
