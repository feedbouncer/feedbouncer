import { GATED_STEP_TYPES, SUGGESTION_STATUSES } from '@feedbouncer/actions/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ReviewModeBanner } from '../../../../../../components/review-mode/review-mode-banner';
import { SuggestionQueue } from '../../../../../../components/review-mode/suggestion-queue';
import { isUuid } from '../../../../../../lib/ids';
import type { PendingAuthor, QueueFilter, SuggestionView } from '../../../../../../lib/review-mode';
import type { RuleView } from '../../../../../../lib/rules';
import {
  dataOrThrow,
  loadReviewMode,
  requireMe,
  serverGet,
} from '../../../../../../lib/server-api';

const oneOf = <T extends string>(values: readonly T[], v: unknown): T | undefined =>
  values.find((x) => x === v);
const uuid = (v: unknown): string | undefined => (isUuid(v) ? v : undefined);

export default async function SuggestionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; brandId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId, brandId } = await params;
  if (!isUuid(orgId) || !isUuid(brandId)) notFound();
  await requireMe(`/orgs/${orgId}/brands/${brandId}/suggestions`);
  const sp = await searchParams;
  const filter: QueueFilter = {
    status: oneOf([...SUGGESTION_STATUSES, 'all'], sp.status) ?? 'pending',
    connectionId: uuid(sp.connectionId),
    ruleId: uuid(sp.ruleId),
    authorId: uuid(sp.authorId),
    stepType: oneOf(GATED_STEP_TYPES, sp.stepType),
  };
  const query = new URLSearchParams({ limit: '50' });
  for (const [k, v] of Object.entries(filter)) if (v !== undefined) query.set(k, v);
  const before = uuid(sp.before);
  if (before) query.set('before', before);
  const api = `/api/v1/orgs/${orgId}/brands/${brandId}` as const;
  const page = dataOrThrow(
    await serverGet<{ items: SuggestionView[]; next: string | null }>(
      `${api}/suggestions?${query.toString()}`,
    ),
    'suggestions',
  );
  const authors = filter.connectionId
    ? dataOrThrow(
        await serverGet<{ items: PendingAuthor[] }>(
          `${api}/suggestions/authors?connectionId=${filter.connectionId}&limit=50`,
        ),
        'authors',
      ).items
    : [];
  const { rules } = dataOrThrow(await serverGet<{ rules: RuleView[] }>(`${api}/rules`), 'rules');
  const review = await loadReviewMode(orgId, brandId);
  const brand = `/orgs/${orgId}/brands/${brandId}`;
  return (
    <main>
      <h1>Suggestions</h1>
      {review.connections.map((s) => (
        <ReviewModeBanner
          key={s.connectionId}
          status={s}
          orgId={orgId}
          brandId={brandId}
          canManage={review.canManage}
        />
      ))}
      <SuggestionQueue
        orgId={orgId}
        brandId={brandId}
        items={page.items}
        next={page.next}
        authors={authors}
        filter={filter}
        connections={review.connections.map((c) => ({
          id: c.connectionId,
          name: c.displayName ?? 'Unnamed account',
        }))}
        rules={rules.map((r) => ({ id: r.id, name: r.name }))}
      />
      <p>
        <Link href={`${brand}/review`}>Review queue</Link> ·{' '}
        <Link href={`${brand}/comments`}>Comments</Link> ·{' '}
        <Link href={`${brand}/connections`}>Connections</Link> ·{' '}
        <Link href={`${brand}/rules`}>Rules</Link>
      </p>
    </main>
  );
}
