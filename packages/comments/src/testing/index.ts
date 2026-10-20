import { applyPlatformComment } from '../apply.js';
import type { PgCommentStore } from '../store.js';

type Upsert = Awaited<ReturnType<PgCommentStore['upsertFromPlatform']>>;

/** Upserts a comment the test expects to be stored, failing when it was suppressed. */
export async function upsertStored(
  store: PgCommentStore,
  ...args: Parameters<PgCommentStore['upsertFromPlatform']>
): Promise<Extract<Upsert, { suppressed: false }>> {
  const r = await store.upsertFromPlatform(...args);
  if (r.suppressed) throw new Error('comment_suppressed');
  return r;
}

/** Like `upsertStored`, through `applyPlatformComment`. */
export async function applyStored(
  ...args: Parameters<typeof applyPlatformComment>
): Promise<Extract<Awaited<ReturnType<typeof applyPlatformComment>>, { suppressed: false }>> {
  const r = await applyPlatformComment(...args);
  if (r.suppressed) throw new Error('comment_suppressed');
  return r;
}
