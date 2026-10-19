// Read model for the "Hidden today" list: the latest applied hide per comment since local midnight
// in each brand's timezone. Every statement is parameterised, filters organization_id + brand_id on
// every join, and returns comment bodies and names for display only: never log them.
import type pg from 'pg';
import type { ActionActor, ActionStatus, BrandScope } from '@feedbouncer/comments';
import type { ConnectionStatus, Platform, PlatformState } from '@feedbouncer/connectors';
import { HIDE_DECISION_LATERAL_SQL, HIDE_STEP_LATERAL_SQL } from './hide-attribution.js';

export const HIDDEN_ROW_STATES = [
  'hidden',
  'pending',
  'restored',
  'already_visible',
  'unavailable',
  'failed',
] as const;
export type HiddenRowState = (typeof HIDDEN_ROW_STATES)[number];
export type ActorType = ActionActor['type'];

export type HiddenSource =
  | { type: 'rule'; ruleId: string | null; ruleName: string | null }
  | { type: 'classifier'; category: string | null }
  | { type: 'policy'; policyId: string | null; policyName: string | null }
  | { type: 'person'; userName: string | null }
  | { type: 'suggestion'; userName: string | null }
  | { type: 'api_key' }
  | { type: 'system' };

export interface UnhideAttempt {
  actionId: string;
  status: ActionStatus;
  outcomeCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface HistoryEntry {
  kind: 'hide' | 'unhide';
  actorType: ActorType;
  actorName: string | null;
  status: ActionStatus;
  outcomeCode: string | null;
  at: Date;
}

export interface HiddenItem {
  hideActionId: string;
  organizationId: string;
  organizationName: string;
  brandId: string;
  brandName: string;
  connectionId: string;
  connectionName: string;
  connectionStatus: ConnectionStatus;
  platform: Platform;
  commentId: string;
  commentBody: string;
  commentState: PlatformState;
  authorName: string | null;
  hiddenAt: Date;
  source: HiddenSource;
  reason: string | null;
  ruleStepId: string | null;
  lastAttempt: UnhideAttempt | null;
  state: HiddenRowState;
  canUnhide: boolean;
  history: HistoryEntry[];
}

export interface HiddenCursor {
  hiddenAt: Date;
  hideActionId: string;
}

export interface BrandDay {
  organizationId: string;
  brandId: string;
  brandName: string;
  timezone: string;
  timezoneSet: boolean;
  dayStart: Date;
}

export function hiddenRowState(i: {
  commentState: PlatformState;
  lastAttempt: UnhideAttempt | null;
}): HiddenRowState {
  const a = i.lastAttempt;
  if (i.commentState === 'deleted' || a?.outcomeCode === 'comment_gone') return 'unavailable';
  if (a?.status === 'pending') return 'pending';
  if (a?.status === 'applied') return 'restored';
  if (a?.status === 'noop' && a.outcomeCode === 'already_visible') return 'already_visible';
  if (a?.status === 'failed' || a?.status === 'not_eligible') return 'failed';
  if (!a && i.commentState === 'visible') return 'already_visible';
  return 'hidden';
}

export const canUnhide = (s: HiddenRowState): boolean => s === 'hidden' || s === 'failed';

const HISTORY_LIMIT = 10;

const DAYS_SQL = `
  SELECT b.organization_id, b.id, b.name, b.timezone, b.timezone_set_at IS NOT NULL AS timezone_set,
         date_trunc('day', $2::timestamptz, b.timezone) AS day_start
    FROM brand b
   WHERE b.organization_id = ANY($1::uuid[]) AND b.archived_at IS NULL`;

const baseQuery = (o: { days: string; hides: string; tail: string }) => `
WITH days AS (${DAYS_SQL}${o.days}),
hides AS (
  SELECT DISTINCT ON (a.comment_id) a.*, d.day_start
    FROM moderation_action a
    JOIN days d ON d.organization_id = a.organization_id AND d.id = a.brand_id
   WHERE a.organization_id = ANY($1::uuid[]) AND a.kind = 'hide' AND a.status = 'applied'
     AND a.completed_at >= d.day_start AND a.completed_at <= $2${o.hides}
   ORDER BY a.comment_id, a.completed_at DESC, a.id DESC)
SELECT h.id, h.organization_id, o.name AS organization_name, h.brand_id, b.name AS brand_name,
       h.connection_id, COALESCE(cn.display_name, cn.external_account_id) AS connection_name,
       cn.status AS connection_status, cn.platform, h.comment_id, c.body, c.platform_state,
       au.display_name AS author_name, h.completed_at, h.actor_type, h.rule_id, h.request_key,
       actor.display_name AS actor_name, r.name AS rule_name, dec.category,
       cp.id AS policy_id, cp.name AS policy_name, st.id AS step_id,
       st.run_suggestion_id IS NOT NULL AS from_suggestion,
       COALESCE(dec.reason, src.reason) AS reason,
       la.id AS attempt_id, la.status AS attempt_status, la.outcome_code AS attempt_outcome,
       la.created_at AS attempt_created_at, la.completed_at AS attempt_completed_at,
       hist.entries
  FROM hides h
  JOIN brand b ON b.organization_id = h.organization_id AND b.id = h.brand_id
  JOIN organization o ON o.id = h.organization_id
  JOIN comment c ON c.organization_id = h.organization_id AND c.brand_id = h.brand_id AND c.id = h.comment_id
  JOIN connection cn ON cn.organization_id = h.organization_id AND cn.brand_id = h.brand_id
                    AND cn.id = h.connection_id
  LEFT JOIN author au ON au.organization_id = c.organization_id AND au.brand_id = c.brand_id
                     AND au.connection_id = c.connection_id AND au.id = c.author_id
  LEFT JOIN app_user actor ON actor.id = h.actor_user_id
  LEFT JOIN rule r ON r.organization_id = h.organization_id AND r.brand_id = h.brand_id AND r.id = h.rule_id
  ${HIDE_STEP_LATERAL_SQL}
  ${HIDE_DECISION_LATERAL_SQL}
  LEFT JOIN custom_policy_revision pr ON pr.organization_id = h.organization_id AND pr.brand_id = h.brand_id
                                     AND pr.id = dec.policy_revision_id
  LEFT JOIN custom_policy cp ON cp.organization_id = pr.organization_id AND cp.brand_id = pr.brand_id
                            AND cp.id = pr.policy_id
  LEFT JOIN LATERAL (
    SELECT s.reason
      FROM action_suggestion_source s
     WHERE s.organization_id = h.organization_id AND s.brand_id = h.brand_id
       AND s.suggestion_id = st.run_suggestion_id
     ORDER BY s.created_at, s.id
     LIMIT 1) src ON true
  LEFT JOIN LATERAL (
    SELECT u.id, u.status, u.outcome_code, u.created_at, u.completed_at
      FROM moderation_action u
     WHERE u.organization_id = h.organization_id AND u.brand_id = h.brand_id AND u.kind = 'unhide'
       AND (u.reverses_action_id = h.id OR u.id = st.undo_action_id)
     ORDER BY u.created_at DESC, u.id DESC
     LIMIT 1) la ON true
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object('kind', e.kind, 'actorType', e.actor_type, 'actorName', e.display_name,
                                      'status', e.status, 'outcomeCode', e.outcome_code, 'at', e.at)
                    ORDER BY e.created_at, e.id) AS entries
      FROM (SELECT x.id, x.kind, x.actor_type, ux.display_name, x.status, x.outcome_code,
                   COALESCE(x.completed_at, x.created_at) AS at, x.created_at
              FROM moderation_action x
              LEFT JOIN app_user ux ON ux.id = x.actor_user_id
             WHERE x.organization_id = h.organization_id AND x.brand_id = h.brand_id
               AND x.comment_id = h.comment_id AND x.kind IN ('hide', 'unhide')
               AND x.created_at >= h.day_start
             ORDER BY x.created_at DESC, x.id DESC
             LIMIT ${HISTORY_LIMIT}) e) hist ON true
${o.tail}`;

const LIST_SQL = baseQuery({
  days: '',
  hides: '',
  tail: `WHERE $3::timestamptz IS NULL OR (h.completed_at, h.id) < ($3::timestamptz, $4::uuid)
 ORDER BY h.completed_at DESC, h.id DESC
 LIMIT $5`,
});

// $1 = [organization], $3 = brand, $4 = hide. Only the latest applied hide of the hide's own
// comment is a candidate, so an older hide on the same comment loads as null.
const LOAD_SQL = baseQuery({
  days: ' AND b.id = $3',
  hides: ` AND a.brand_id = $3 AND a.comment_id = (
       SELECT m.comment_id FROM moderation_action m
        WHERE m.organization_id = ($1::uuid[])[1] AND m.brand_id = $3 AND m.id = $4 AND m.kind = 'hide')`,
  tail: 'WHERE h.id = $4',
});

interface Row {
  id: string;
  organization_id: string;
  organization_name: string;
  brand_id: string;
  brand_name: string;
  connection_id: string;
  connection_name: string;
  connection_status: ConnectionStatus;
  platform: Platform;
  comment_id: string;
  body: string;
  platform_state: PlatformState;
  author_name: string | null;
  completed_at: Date;
  actor_type: ActorType;
  rule_id: string | null;
  actor_name: string | null;
  rule_name: string | null;
  category: string | null;
  policy_id: string | null;
  policy_name: string | null;
  step_id: string | null;
  from_suggestion: boolean | null;
  reason: string | null;
  attempt_id: string | null;
  attempt_status: ActionStatus | null;
  attempt_outcome: string | null;
  attempt_created_at: Date | null;
  attempt_completed_at: Date | null;
  entries: (Omit<HistoryEntry, 'at'> & { at: string })[] | null;
}

function sourceOf(r: Row): HiddenSource {
  switch (r.actor_type) {
    case 'rule':
      return { type: 'rule', ruleId: r.rule_id, ruleName: r.rule_name };
    case 'classifier':
      return { type: 'classifier', category: r.category };
    case 'policy':
      return { type: 'policy', policyId: r.policy_id, policyName: r.policy_name };
    case 'user':
      return r.from_suggestion
        ? { type: 'suggestion', userName: r.actor_name }
        : { type: 'person', userName: r.actor_name };
    case 'api_key':
      return { type: 'api_key' };
    case 'system':
      return { type: 'system' };
  }
}

function toItem(r: Row): HiddenItem {
  const lastAttempt: UnhideAttempt | null = r.attempt_id
    ? {
        actionId: r.attempt_id,
        status: r.attempt_status!,
        outcomeCode: r.attempt_outcome,
        createdAt: r.attempt_created_at!,
        completedAt: r.attempt_completed_at,
      }
    : null;
  const state = hiddenRowState({ commentState: r.platform_state, lastAttempt });
  return {
    hideActionId: r.id,
    organizationId: r.organization_id,
    organizationName: r.organization_name,
    brandId: r.brand_id,
    brandName: r.brand_name,
    connectionId: r.connection_id,
    connectionName: r.connection_name,
    connectionStatus: r.connection_status,
    platform: r.platform,
    commentId: r.comment_id,
    commentBody: r.body,
    commentState: r.platform_state,
    authorName: r.author_name,
    hiddenAt: r.completed_at,
    source: sourceOf(r),
    reason: r.reason,
    ruleStepId: r.step_id,
    lastAttempt,
    state,
    canUnhide: canUnhide(state),
    history: (r.entries ?? []).map((e) => ({ ...e, at: new Date(e.at) })),
  };
}

export class PgHiddenTodayStore {
  constructor(private readonly pool: pg.Pool) {}

  async list(
    orgIds: readonly string[],
    now: Date,
    page: { before: HiddenCursor | null; limit: number },
  ): Promise<{ items: HiddenItem[]; next: HiddenCursor | null; brands: BrandDay[] }> {
    const [rows, brands] = await Promise.all([
      this.pool.query<Row>(LIST_SQL, listParams(orgIds, now, page)),
      this.brandDays(orgIds, now),
    ]);
    const items = rows.rows.slice(0, page.limit).map(toItem);
    const last = items.at(-1);
    return {
      items,
      next:
        rows.rows.length > page.limit && last
          ? { hiddenAt: last.hiddenAt, hideActionId: last.hideActionId }
          : null,
      brands,
    };
  }

  /** Each brand's timezone and the start of its current day. */
  async brandDays(orgIds: readonly string[], now: Date): Promise<BrandDay[]> {
    const { rows } = await this.pool.query<{
      organization_id: string;
      id: string;
      name: string;
      timezone: string;
      timezone_set: boolean;
      day_start: Date;
    }>(`${DAYS_SQL} ORDER BY b.name, b.id`, [[...orgIds], now]);
    return rows.map((b) => ({
      organizationId: b.organization_id,
      brandId: b.id,
      brandName: b.name,
      timezone: b.timezone,
      timezoneSet: b.timezone_set,
      dayStart: b.day_start,
    }));
  }

  /** The hide as a row, only while it is today's latest applied hide on its comment. */
  async load(scope: BrandScope, hideActionId: string, now: Date): Promise<HiddenItem | null> {
    const { rows } = await this.pool.query<Row>(LOAD_SQL, [
      [scope.organizationId],
      now,
      scope.brandId,
      hideActionId,
    ]);
    return rows[0] ? toItem(rows[0]) : null;
  }
}

const listParams = (
  orgIds: readonly string[],
  now: Date,
  page: { before: HiddenCursor | null; limit: number },
) => [
  [...orgIds],
  now,
  page.before?.hiddenAt ?? null,
  page.before?.hideActionId ?? null,
  page.limit + 1,
];

/** The statement and parameters behind `list`, for query-plan checks. */
export const listQuery = (
  orgIds: readonly string[],
  now: Date,
  page: { before: HiddenCursor | null; limit: number },
) => ({ text: LIST_SQL, values: listParams(orgIds, now, page) });
