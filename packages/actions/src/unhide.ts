// One-click unhide for the "Hidden today" list. The request key is derived here, never taken from
// the client, so repeated clicks and second tabs collapse to one action.
import type pg from 'pg';
import type { BrandScope, ModerationActions } from '@feedbouncer/comments';
import type { Clock, ConnectorCapabilities, Platform } from '@feedbouncer/connectors';
import type { HiddenItem, PgHiddenTodayStore } from './hidden-today.js';
import type { PgReviewQueue } from './review.js';
import type { PgActionRunStore } from './runs.js';
import { undoStep, type Audit } from './services.js';

type Forwarded = 'not_found' | 'connection_needs_reconnect' | 'connection_inactive';

export type UnhideResult =
  | { status: 'ok'; item: HiddenItem }
  | { status: 'refused'; code: Forwarded }
  | { status: 'refused'; code: 'missing_permission'; permission: string };

const FORWARDED: readonly string[] = [
  'not_found',
  'connection_needs_reconnect',
  'connection_inactive',
] satisfies Forwarded[];
const isForwarded = (code: string): code is Forwarded => FORWARDED.includes(code);

async function missingPermission(
  pool: pg.Pool,
  scope: BrandScope,
  item: HiddenItem,
  caps: ConnectorCapabilities | null,
): Promise<string | null> {
  const needed = caps?.actionScopes?.unhide ?? [];
  if (needed.length === 0) return null;
  const { rows } = await pool.query<{ granted_scopes: string[] }>(
    `SELECT granted_scopes FROM connection
      WHERE organization_id = $1 AND brand_id = $2 AND id = $3`,
    [scope.organizationId, scope.brandId, item.connectionId],
  );
  const granted = new Set(rows[0]?.granted_scopes);
  return needed.find((s) => !granted.has(s)) ?? null;
}

export async function unhideHidden(
  d: {
    pool: pg.Pool;
    hidden: PgHiddenTodayStore;
    runs: PgActionRunStore;
    review: PgReviewQueue;
    actions: Pick<ModerationActions, 'request'>;
    audit: Audit;
    caps: (platform: Platform) => ConnectorCapabilities | null;
    clock: Clock;
  },
  scope: BrandScope,
  hideActionId: string,
  userId: string,
): Promise<UnhideResult> {
  const now = () => new Date(d.clock.now());
  const item = await d.hidden.load(scope, hideActionId, now());
  if (!item) return { status: 'refused', code: 'not_found' };
  // A replay or a stale tab: report the current state and write nothing.
  if (!item.canUnhide) return { status: 'ok', item };

  const permission = await missingPermission(d.pool, scope, item, d.caps(item.platform));
  if (permission) return { status: 'refused', code: 'missing_permission', permission };

  // Any other refusal, or losing a race to another click, leaves the row to say what happened.
  const refusal = item.ruleStepId
    ? await undoStep(d, scope, item.ruleStepId, userId)
    : await d.actions.request({
        scope,
        commentId: item.commentId,
        kind: 'unhide',
        actor: { type: 'user', userId },
        // One key per attempt: a retry after a failed unhide is a new request.
        requestKey: item.lastAttempt
          ? `unhide:${hideActionId}:${item.lastAttempt.actionId}`
          : `unhide:${hideActionId}`,
        reverses: hideActionId,
      });
  if (refusal.status === 'refused' && isForwarded(refusal.code))
    return { status: 'refused', code: refusal.code };

  const current = await d.hidden.load(scope, hideActionId, now());
  return current ? { status: 'ok', item: current } : { status: 'refused', code: 'not_found' };
}
