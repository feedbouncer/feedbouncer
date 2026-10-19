import Link from 'next/link';
import { notFound } from 'next/navigation';
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
      <h1>Rule changes</h1>
      <p>Changes proposed through the API. Nothing applies until a person approves it.</p>
      {changes.length === 0 ? (
        <p>No rule changes yet.</p>
      ) : (
        <ul>
          {changes.map((c) => (
            <li key={c.id}>
              <Link href={`${rules}/changes/${c.id}`}>
                {c.operation} by {c.proposedBy.apiKeyName}
              </Link>{' '}
              · {c.isStale ? 'stale' : c.status} · expires {formatUtc(c.expiresAt)}
            </li>
          ))}
        </ul>
      )}
      <p>
        <Link href={rules}>Back to rules</Link>
      </p>
    </main>
  );
}
