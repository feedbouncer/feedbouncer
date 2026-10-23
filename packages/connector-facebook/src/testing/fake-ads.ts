// Ads half of the FakeGraph: ad accounts, ads with their creatives, per-account
// usage headers and revoked access. State lives in `AdsState`; the FakeGraph owns
// one and delegates `me/adaccounts` and `act_<n>/ads` to `routeAds` after its own
// token and appsecret_proof checks have passed. Dark posts are ordinary posts the
// FakeGraph tracks in `AdsState.dark`; they never appear in a Page feed.

export interface AdAccount {
  id: string;
  userId: string;
  name: string;
  accountStatus: number;
  usage: { utilPct: number; resetSec: number } | null;
}

export interface Ad {
  id: string;
  accountId: string;
  status: string;
  name: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  creative: Record<string, unknown>;
}

export interface AddAdOptions {
  name?: string;
  status?: string;
  storyId?: string | null;
  igMediaId?: string | null;
  igUserId?: string | null;
  objectType?: string;
  raw?: Record<string, unknown>;
}

export interface AdsState {
  accounts: Map<string, AdAccount>;
  ads: Map<string, Ad>;
  dark: Set<string>;
  gone: Set<string>;
  revoked: Map<string, number>; // `${userId}:${adAccountId}` -> Graph error code
}

export const createAdsState = (): AdsState => ({
  accounts: new Map(),
  ads: new Map(),
  dark: new Set(),
  gone: new Set(),
  revoked: new Map(),
});

export interface AdsHost {
  graphTime(ms: number): string;
  reply(status: number, body: unknown, headers?: Record<string, string>): Response;
  error(code: number, subcode?: number): Response;
}

export function addAdAccount(
  s: AdsState,
  id: string,
  userId: string,
  o: { name?: string; accountStatus?: number } = {},
): { adAccountId: string } {
  s.accounts.set(id, {
    id,
    userId,
    name: o.name ?? `Ad account ${id}`,
    accountStatus: o.accountStatus ?? 1,
    usage: null,
  });
  return { adAccountId: id };
}

export function addAd(
  s: AdsState,
  now: number,
  ids: { adId: string; creativeId: string },
  adAccountId: string,
  o: AddAdOptions = {},
): { adId: string; creativeId: string } {
  if (!s.accounts.has(adAccountId)) throw new Error('unknown ad account');
  const optional = (key: string, v: string | null | undefined) => (v ? { [key]: v } : {});
  s.ads.set(ids.adId, {
    id: ids.adId,
    accountId: adAccountId,
    status: o.status ?? 'ACTIVE',
    name: o.name ?? null,
    createdAtMs: now,
    updatedAtMs: now,
    creative: o.raw ?? {
      id: ids.creativeId,
      ...optional('effective_object_story_id', o.storyId),
      ...optional('effective_instagram_media_id', o.igMediaId),
      ...optional('instagram_user_id', o.igUserId),
      object_type: o.objectType ?? 'SHARE',
    },
  });
  return ids;
}

export function setAdStatus(s: AdsState, now: number, adId: string, status: string): void {
  const ad = findAd(s, adId);
  ad.status = status;
  ad.updatedAtMs = now;
}

export function setAdCreative(
  s: AdsState,
  now: number,
  adId: string,
  patch: { storyId?: string | null; igMediaId?: string | null; igUserId?: string | null },
): void {
  const ad = findAd(s, adId);
  const keys = {
    storyId: 'effective_object_story_id',
    igMediaId: 'effective_instagram_media_id',
    igUserId: 'instagram_user_id',
  } as const;
  for (const [k, field] of Object.entries(keys) as [keyof typeof keys, string][]) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v) ad.creative[field] = v;
    else delete ad.creative[field];
  }
  ad.updatedAtMs = now;
}

/** `status`: the ad leaves listings and reads as DELETED by id. `gone`: reading it by id fails 100/33. */
export function deleteAd(s: AdsState, now: number, adId: string, mode: 'status' | 'gone'): void {
  const ad = findAd(s, adId);
  if (mode === 'gone') {
    s.ads.delete(adId);
    s.gone.add(adId);
    return;
  }
  ad.status = 'DELETED';
  ad.updatedAtMs = now;
}

function findAd(s: AdsState, adId: string): Ad {
  const ad = s.ads.get(adId);
  if (!ad) throw new Error('unknown ad');
  return ad;
}

const AD_ID_PATH = /^\d{1,32}$/;
const AD_ACCOUNT_PATH = /^act_(\d{1,32})$/;

function cursorPage<T>(
  items: T[],
  query: URLSearchParams,
): { slice: T[]; more: boolean; after: string } {
  const limit = Number(query.get('limit') ?? '25');
  const size = Number.isInteger(limit) && limit > 0 ? limit : 25;
  const after = query.get('after') ?? '';
  const start = /^a\d{1,9}$/.test(after) ? Number(after.slice(1)) : 0;
  const end = start + size;
  return { slice: items.slice(start, end), more: end < items.length, after: `a${end}` };
}

/** Handles `GET me/adaccounts` and `GET act_<n>/ads`; null for any other request. */
export function routeAds(
  s: AdsState,
  host: AdsHost,
  method: string,
  path: string[],
  query: URLSearchParams,
  who: { kind: 'user' | 'page'; id: string },
): Response | null {
  const [first, second] = path;
  if (path.length === 1 && first !== undefined && AD_ID_PATH.test(first)) {
    const ad = s.ads.get(first);
    if (!ad && !s.gone.has(first)) return null;
    if (method !== 'GET') return host.error(100);
    if (who.kind !== 'user') return host.error(200);
    if (!ad || s.accounts.get(ad.accountId)?.userId !== who.id) return host.error(100, 33);
    return host.reply(200, { id: ad.id, name: ad.name, effective_status: ad.status });
  }
  const accountId = first === undefined ? undefined : AD_ACCOUNT_PATH.exec(first)?.[1];
  const listing = first === 'me' && second === 'adaccounts';
  if (path.length !== 2 || (!listing && !(accountId && second === 'ads'))) return null;
  if (method !== 'GET') return host.error(100);
  if (who.kind !== 'user') return host.error(200);

  const prefix = `${who.id}:`;
  if (listing) {
    const code = [...s.revoked].find(([k]) => k.startsWith(prefix))?.[1];
    if (code !== undefined) return host.error(code);
    const mine = [...s.accounts.values()].filter((a) => a.userId === who.id);
    const p = cursorPage(mine, query);
    return host.reply(200, {
      data: p.slice.map((a) => ({
        id: `act_${a.id}`,
        account_id: a.id,
        name: a.name,
        account_status: a.accountStatus,
      })),
      paging: { cursors: { after: p.after } },
    });
  }

  const revoked = s.revoked.get(`${prefix}${accountId}`);
  if (revoked !== undefined) return host.error(revoked);
  const account = s.accounts.get(accountId!);
  if (!account || account.userId !== who.id) return host.error(200);

  let statuses: string[] | null = null;
  const filter = query.get('effective_status');
  if (filter !== null) {
    try {
      const parsed: unknown = JSON.parse(filter);
      if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string')) throw new Error();
      statuses = parsed as string[];
    } catch {
      return host.error(100);
    }
  }
  const matching = [...s.ads.values()].filter(
    (a) =>
      a.accountId === account.id &&
      a.status !== 'DELETED' &&
      (!statuses || statuses.includes(a.status)),
  );
  const p = cursorPage(matching, query);
  const usage = account.usage
    ? {
        'x-ad-account-usage': JSON.stringify({
          acc_id_util_pct: account.usage.utilPct,
          reset_time_duration: account.usage.resetSec,
        }),
      }
    : {};
  return host.reply(
    200,
    {
      data: p.slice.map((a) => ({
        id: a.id,
        account_id: a.accountId,
        name: a.name,
        effective_status: a.status,
        created_time: host.graphTime(a.createdAtMs),
        updated_time: host.graphTime(a.updatedAtMs),
        creative: a.creative,
      })),
      paging: {
        cursors: { after: p.after },
        // Off-host on purpose: a client that follows `next` would leave Graph.
        ...(p.more ? { next: `https://evil.example/${first}/ads?after=${p.after}` } : {}),
      },
    },
    usage,
  );
}
