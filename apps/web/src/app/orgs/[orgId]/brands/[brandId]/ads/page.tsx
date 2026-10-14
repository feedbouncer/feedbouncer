import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolutionText, type AdView } from '../../../../../../lib/ads';
import { formatUtc } from '../../../../../../lib/format';
import { isUuid } from '../../../../../../lib/ids';
import { dataOrThrow, requireMe, serverGet } from '../../../../../../lib/server-api';

interface AdsPage {
  ads: AdView[];
  nextCursor: string | null;
  hints: { pagesNotConnected: number; instagramNotConnected: number };
}

const CURSOR = /^[A-Za-z0-9_-]{1,256}$/;

export default async function AdsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; brandId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId, brandId } = await params;
  if (!isUuid(orgId) || !isUuid(brandId)) notFound();
  await requireMe(`/orgs/${orgId}/brands/${brandId}/ads`);
  const sp = await searchParams;
  const query = new URLSearchParams({ limit: '50' });
  if (typeof sp.cursor === 'string' && CURSOR.test(sp.cursor)) query.set('cursor', sp.cursor);
  const { ads, nextCursor, hints } = dataOrThrow(
    await serverGet<AdsPage>(`/api/v1/orgs/${orgId}/brands/${brandId}/ads?${query.toString()}`),
    'ads',
  );
  const connections = `/orgs/${orgId}/brands/${brandId}/connections`;
  return (
    <main>
      <h1>Ads</h1>
      {hints.pagesNotConnected > 0 ? (
        <p>
          {hints.pagesNotConnected} active ads run on a Facebook Page that is not connected.{' '}
          <Link href={connections}>Connect a Page</Link>
        </p>
      ) : null}
      {hints.instagramNotConnected > 0 ? (
        <p>
          {hints.instagramNotConnected} active ads run on an Instagram account that is not
          connected. <Link href={connections}>Connect an Instagram account</Link>
        </p>
      ) : null}
      {ads.length === 0 ? <p>No ads found yet.</p> : null}
      {ads.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Ad</th>
              <th scope="col">Account</th>
              <th scope="col">Status</th>
              <th scope="col">Facebook</th>
              <th scope="col">Instagram</th>
              <th scope="col">Last checked</th>
            </tr>
          </thead>
          <tbody>
            {ads.map((a) => (
              <tr key={a.adId + a.adAccountId}>
                <td>{a.adId}</td>
                <td>{a.adAccountId}</td>
                <td>{a.active ? 'Active' : 'Inactive'}</td>
                <td>{resolutionText(a.facebook.resolution)}</td>
                <td>{resolutionText(a.instagram.resolution)}</td>
                <td>
                  {a.lastPolledAt ? formatUtc(a.lastPolledAt) : 'Not yet'}
                  {a.postUnavailable ? <p>Post unavailable — retrying later</p> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {nextCursor ? (
        <p>
          <Link
            href={`/orgs/${orgId}/brands/${brandId}/ads?cursor=${encodeURIComponent(nextCursor)}`}
          >
            More ads
          </Link>
        </p>
      ) : null}
      <p>
        <Link href={connections}>Connections</Link> ·{' '}
        <Link href={`/orgs/${orgId}/brands/${brandId}/comments`}>Comments</Link>
      </p>
    </main>
  );
}
