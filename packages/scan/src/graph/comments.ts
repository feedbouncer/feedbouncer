import { type NormalizedComment, ConnectorError } from '@feedbouncer/connectors';
import { listComments } from '@feedbouncer/connector-facebook';
import { listComments as listIgComments } from '@feedbouncer/connector-instagram';
import type { Secret } from '@feedbouncer/service-runtime';
import type { AdPost } from './ads.js';
import { scanCallContext, type ScanGraph } from './pages.js';

const PAGE_LIMIT = 100;

/**
 * Newest-first comments of one ad post. Stops at the first comment older than
 * `sinceMs`, after `perPostCap` comments (hidden ones included) or when the
 * cursor ends. Connector errors pass through unchanged.
 */
export async function* readPostComments(
  g: ScanGraph,
  pageToken: Secret,
  post: AdPost,
  sinceMs: number,
  perPostCap: number,
  signal: AbortSignal,
): AsyncGenerator<NormalizedComment> {
  const ctx = scanCallContext(g, pageToken, post.postExternalId, signal);
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const req = { sourceExternalId: post.postExternalId, cursor, limit: PAGE_LIMIT };
    let page;
    if (post.platform === 'facebook') page = await listComments(g.fb, g.nowMs, ctx, req);
    else if (g.ig) {
      page = await listIgComments(g.ig, g.nowMs, ctx, { ...req, includeReplies: true });
    } else throw new ConnectorError('permanent', 'instagram_unavailable');
    for (const c of page.items) {
      if (c.postedAt.getTime() < sinceMs) return;
      if (seen.has(c.externalId)) continue;
      seen.add(c.externalId);
      yield c;
      if (seen.size >= perPostCap) return;
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
}
