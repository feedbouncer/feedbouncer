import { notFound } from 'next/navigation';
import { ReviewQueue } from '../../../../../../components/actions/review-queue';
import { ReviewModeBanner } from '../../../../../../components/review-mode/review-mode-banner';
import { PageHeader } from '../../../../../../components/ui/page-header';
import {
  stepAvailability,
  type ActionCapabilitiesDto,
  type Page,
  type ReviewItemView,
} from '../../../../../../lib/actions';
import { isUuid } from '../../../../../../lib/ids';
import {
  dataOrThrow,
  loadReviewMode,
  requireMe,
  serverGet,
} from '../../../../../../lib/server-api';

export default async function ReviewQueuePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; brandId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId, brandId } = await params;
  if (!isUuid(orgId) || !isUuid(brandId)) notFound();
  await requireMe(`/orgs/${orgId}/brands/${brandId}/review`);
  const review = await loadReviewMode(orgId, brandId);
  const { before } = await searchParams;
  const query = new URLSearchParams({ status: 'open', limit: '50' });
  if (typeof before === 'string' && isUuid(before)) query.set('before', before);
  const page = dataOrThrow(
    await serverGet<Page<ReviewItemView>>(
      `/api/v1/orgs/${orgId}/brands/${brandId}/review-items?${query.toString()}`,
    ),
    'review queue',
  );
  const caps = dataOrThrow(
    await serverGet<ActionCapabilitiesDto>(
      `/api/v1/orgs/${orgId}/brands/${brandId}/action-capabilities`,
    ),
    'action capabilities',
  );
  return (
    <main>
      <PageHeader title="Review queue" />
      {review.connections.map((s) => (
        <ReviewModeBanner
          key={s.connectionId}
          status={s}
          orgId={orgId}
          brandId={brandId}
          canManage={review.canManage}
        />
      ))}
      <ReviewQueue
        orgId={orgId}
        brandId={brandId}
        items={page.items}
        next={page.next}
        canBan={stepAvailability(caps).ban.available}
      />
    </main>
  );
}
