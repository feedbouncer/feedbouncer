import 'server-only';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { apiInternalUrl } from './api-url';
import type { ReviewModeStatusDto } from './review-mode';

// Callers must pass every interpolated path segment through isUuid first.
export async function serverGet<T>(
  path: `/api/v1/${string}`,
): Promise<{ status: number; data: T | null }> {
  // Reading cookies first opts the page out of static prerendering.
  const cookie = (await cookies()).toString();
  const base = apiInternalUrl();
  if (!base) throw new Error('API_INTERNAL_URL is not configured');
  const res = await fetch(new URL(path, base), {
    headers: cookie ? { cookie } : {},
    cache: 'no-store',
  });
  return { status: res.status, data: res.ok ? ((await res.json()) as T) : null };
}

export type Role = 'owner' | 'admin' | 'member';

export interface Me {
  user: { id: string; email: string; name: string | null; emailVerified: boolean };
  memberships: { organizationId: string; organizationName: string; role: Role }[];
}

export async function requireMe(nextPath: string): Promise<Me> {
  const r = await serverGet<Me>('/api/v1/me');
  if (r.status === 401 || !r.data) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  return r.data;
}

// 404 renders the not-found page; any other failure throws so it can never
// render as an empty list.
export function dataOrThrow<T>(r: { status: number; data: T | null }, what: string): T {
  if (r.data) return r.data;
  if (r.status === 404) notFound();
  throw new Error(`Could not load ${what} (status ${r.status})`);
}

/** The brand's review windows, the pending total, and whether the viewer may end a window. */
export async function loadReviewMode(
  orgId: string,
  brandId: string,
): Promise<{ connections: ReviewModeStatusDto[]; pendingTotal: number; canManage: boolean }> {
  const org = dataOrThrow(await serverGet<{ role: Role }>(`/api/v1/orgs/${orgId}`), 'organization');
  const status = dataOrThrow(
    await serverGet<{ connections: ReviewModeStatusDto[]; pendingTotal: number }>(
      `/api/v1/orgs/${orgId}/brands/${brandId}/review-mode`,
    ),
    'review mode',
  );
  return { ...status, canManage: org.role !== 'member' };
}
