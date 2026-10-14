// Lists a meta_ads connection's active ads and records which Facebook post and
// Instagram media each one shows, under the brand's own Page / IG connections.
// Resolution is per brand: another tenant's connections are never consulted.
// Ads missing from a COMPLETE listing are retired; a truncated or failed
// listing retires nothing.
import { JobError, type JobDefinition } from '@feedbouncer/jobs';
import type {
  Clock,
  ConnectionDirectory,
  ConnectorRuntime,
  NormalizedSource,
} from '@feedbouncer/connectors';
import type {
  BrandMetaConnections,
  DiscoveredAdRow,
  FacebookResolution,
  InstagramResolution,
  PgAdTracking,
} from '../ads/tracking.js';
import { DISCOVERY_JOB, type DiscoveryPayload } from './specs.js';

const FB_REASONS: readonly string[] = [
  'no_post',
  'dynamic_creative_unsupported',
  'post_deleted',
  'invalid_platform_id',
];
const IG_REASONS: readonly string[] = [
  'not_instagram',
  'post_deleted',
  'instagram_media_pending',
  'invalid_platform_id',
];

export function resolveAd(src: NormalizedSource, conns: BrandMetaConnections): DiscoveredAdRow {
  const info = src.ad;
  if (!info) throw new TypeError('resolveAd: source is not an ad');
  const fb = info.placements.find((p) => p.platform === 'facebook');
  const ig = info.placements.find((p) => p.platform === 'instagram');

  let facebook: DiscoveredAdRow['facebook'];
  const page = fb?.sourceExternalId ? conns.facebook.get(fb.accountExternalId ?? '') : undefined;
  if (fb?.sourceExternalId) {
    facebook = {
      sourceExternalId: fb.sourceExternalId,
      resolution: page ? 'linked' : 'page_not_connected',
      connection: page ?? null,
    };
  } else {
    const r = fb?.unresolvedReason ?? 'no_post';
    facebook = {
      sourceExternalId: null,
      resolution: (FB_REASONS.includes(r) ? r : 'invalid_platform_id') as FacebookResolution,
      connection: null,
    };
  }

  let instagram: DiscoveredAdRow['instagram'];
  const accountExternalId = ig?.accountExternalId ?? null;
  if (ig?.sourceExternalId) {
    // Unknown account: a brand with exactly one IG connection is the likely owner. A wrong
    // guess surfaces as source_inaccessible when comments are listed, within the brand.
    const only = conns.instagram.size === 1 ? [...conns.instagram.values()][0] : undefined;
    const conn = accountExternalId === null ? only : conns.instagram.get(accountExternalId);
    instagram = {
      sourceExternalId: ig.sourceExternalId,
      accountExternalId,
      resolution: conn ? 'linked' : 'instagram_account_not_connected',
      connection: conn ?? null,
    };
  } else {
    const r = ig?.unresolvedReason ?? 'not_instagram';
    instagram = {
      sourceExternalId: null,
      accountExternalId,
      resolution: (IG_REASONS.includes(r) ? r : 'invalid_platform_id') as InstagramResolution,
      connection: null,
    };
  }

  return {
    externalId: src.externalId,
    adAccountExternalId: info.adAccountExternalId,
    effectiveStatus: info.effectiveStatus,
    active: src.active,
    facebook,
    instagram,
  };
}

export function adDiscoveryJob(d: {
  runtime: ConnectorRuntime;
  directory: ConnectionDirectory;
  tracking: PgAdTracking;
  clock: Clock;
  maxAdsPerAccount?: number;
}): JobDefinition<DiscoveryPayload> {
  const max = d.maxAdsPerAccount ?? 20_000;
  return {
    ...DISCOVERY_JOB,
    handle: async (ctx) => {
      const rec = await d.directory.load(ctx.scope);
      if (!rec) throw new JobError('non_retryable', 'connection_not_found');
      const conns = await d.tracking.brandMetaConnections(ctx.scope);
      const at = new Date(d.clock.now());
      const client = await d.runtime.connect(ctx.scope);

      const seen = new Set<string>();
      const unresolved = new Map<string, number>();
      const bump = (reason: string) => unresolved.set(reason, (unresolved.get(reason) ?? 0) + 1);
      let listed = 0;
      let linked = 0;
      let cursor: string | null = null;
      do {
        const page = await client.listSources(cursor, { priority: 'background' });
        for (const src of page.items) {
          if (!src.ad) continue;
          const row = resolveAd(src, conns);
          await d.tracking.recordAd(ctx.scope, row, at);
          seen.add(row.externalId);
          listed += 1;
          let any = false;
          for (const r of [row.facebook.resolution, row.instagram.resolution]) {
            if (r === 'linked') any = true;
            else bump(r);
          }
          if (any) linked += 1;
        }
        cursor = page.nextCursor;
      } while (cursor !== null && listed < max);

      const complete = cursor === null;
      let retired = 0;
      if (complete) retired = await d.tracking.retireMissing(ctx.scope, seen, at);
      else ctx.log.warn('ads.discovery_truncated', { listed });
      for (const [reason, count] of unresolved) ctx.log.info('ads.unresolved', { reason, count });
      return {
        listed,
        linked,
        retired,
        complete,
        // JobResult is flat: one key per reason.
        ...Object.fromEntries([...unresolved].map(([r, n]) => [`unresolved_${r}`, n])),
      };
    },
  };
}
