import type pg from 'pg';
import {
  loadPublicComment,
  loadPublicFlaggedItem,
  toCommentResource,
  toFlaggedItemResource,
} from '@feedbouncer/public-api';
import { TEST_EVENT_MESSAGE, type HIDE_SOURCES } from './payloads.js';

export type RenderedEvent =
  | { kind: 'ok'; type: string; occurredAt: Date; body: string }
  | { kind: 'gone' };

interface EventRow {
  type: string;
  occurred_at: Date;
  comment_id: string | null;
  review_item_id: string | null;
  moderation_action_id: string | null;
  test_endpoint_id: string | null;
}

interface ActionRow {
  id: string;
  actor_type: string;
  rule_id: string | null;
  created_at: Date;
  hidden_at: Date;
}

const AUTOMATIC_REASONS: Readonly<Record<string, string>> = {
  rule: 'Hidden by an automatic rule.',
  classifier: 'Hidden by the AI classifier.',
  policy: 'Hidden by a custom policy.',
  user: 'Hidden by a team member.',
  api_key: 'Hidden through the FeedBouncer API.',
  system: 'Hidden by FeedBouncer.',
};

const DECIDING_ACTORS = ['rule', 'classifier', 'policy'];

async function hideBlock(c: pg.ClientBase, org: string, commentId: string, actionId: string) {
  const { rows } = await c.query<ActionRow>(
    `SELECT id, actor_type, rule_id, created_at, coalesce(completed_at, created_at) AS hidden_at
       FROM moderation_action
      WHERE organization_id = $1 AND id = $2 AND comment_id = $3`,
    [org, actionId, commentId],
  );
  const action = rows[0];
  if (!action) return null;
  let reason = AUTOMATIC_REASONS[action.actor_type] ?? AUTOMATIC_REASONS.system!;
  if (DECIDING_ACTORS.includes(action.actor_type)) {
    const decision = await c.query<{ reason: string }>(
      `SELECT reason FROM decision
        WHERE organization_id = $1 AND comment_id = $2 AND outcome = 'hide' AND actor_type = $3
          AND ($4::uuid IS NULL OR rule_id = $4) AND created_at <= $5
        ORDER BY created_at DESC, sequence DESC LIMIT 1`,
      [
        org,
        commentId,
        action.actor_type,
        action.actor_type === 'rule' ? action.rule_id : null,
        action.created_at,
      ],
    );
    reason = decision.rows[0]?.reason ?? reason;
  }
  return {
    actionId: action.id,
    source: (action.actor_type === 'api_key'
      ? 'api'
      : action.actor_type) as (typeof HIDE_SOURCES)[number],
    reason,
    ruleId: action.rule_id,
    hiddenAt: action.hidden_at.toISOString(),
  };
}

/** Renders the event as it is now: the payload is never stored. */
export async function renderEvent(
  c: pg.ClientBase,
  org: string,
  eventId: string,
): Promise<RenderedEvent> {
  const { rows } = await c.query<EventRow>(
    `SELECT type, occurred_at, comment_id, review_item_id, moderation_action_id, test_endpoint_id
       FROM webhook_event WHERE organization_id = $1 AND id = $2`,
    [org, eventId],
  );
  const event = rows[0];
  if (!event) return { kind: 'gone' };
  const data = await renderData(c, org, event);
  if (!data) return { kind: 'gone' };
  const body = JSON.stringify({
    id: eventId,
    type: event.type,
    createdAt: event.occurred_at.toISOString(),
    organizationId: org,
    data,
  });
  return { kind: 'ok', type: event.type, occurredAt: event.occurred_at, body };
}

async function renderData(c: pg.ClientBase, org: string, e: EventRow): Promise<object | null> {
  if (e.type === 'webhook.test')
    return { endpointId: e.test_endpoint_id, message: TEST_EVENT_MESSAGE };
  if (e.type === 'item.flagged') {
    const found = await loadPublicFlaggedItem(c, org, e.review_item_id!);
    return found?.comment
      ? { flaggedItem: toFlaggedItemResource(found.item, toCommentResource(found.comment)) }
      : null;
  }
  const row = await loadPublicComment(c, org, e.comment_id!);
  if (!row) return null;
  const comment = toCommentResource(row);
  if (e.type === 'comment.received') return { comment };
  const hide = await hideBlock(c, org, row.id, e.moderation_action_id!);
  return hide && { comment, hide };
}
