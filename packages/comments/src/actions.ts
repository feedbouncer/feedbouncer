// Moderation action requests. A request is checked against the stored comment
// and connection before anything is sent; outcomes known up front (nothing to
// do, not allowed; see eligibility.ts) are recorded without a platform call.
// Everything else is stored as `pending` and executed by the
// `moderation_execute` job.
// Requests are idempotent per (organization, request key): a retry returns the
// stored action and, while it is still pending, re-enqueues it (the job is
// deduplicated by action id). Every statement is filtered by organization_id +
// brand_id. Reply text is stored on the action only; it never goes into logs,
// job payloads, job results or audit details.
import type pg from 'pg';
import { isUniqueViolation, withTransaction } from '@feedbouncer/db';
import {
  replyTextSchema,
  type Clock,
  type ConnectorCapabilities,
  type Platform,
  type ResponseKind,
} from '@feedbouncer/connectors';
import type { JobProducer } from '@feedbouncer/jobs';
import { UUID, type Logger } from '@feedbouncer/service-runtime';
import { ACTION_KINDS, type ActionActor, type ActionKind } from './action-kinds.js';
import type { BrandScope, CommentRow, PgCommentStore } from './store.js';
import { EXECUTE_JOB } from './jobs/specs.js';
import {
  connectionRefusal,
  eligibilityComment,
  evaluateEligibility,
  resolveConstraints,
} from './eligibility.js';

export type ActionStatus = 'pending' | 'applied' | 'noop' | 'not_eligible' | 'failed';

export interface ModerationActionView {
  readonly id: string;
  readonly commentId: string;
  readonly kind: ActionKind;
  readonly actorType: ActionActor['type'];
  readonly actorUserId: string | null;
  readonly status: ActionStatus;
  readonly outcomeCode: string | null;
  readonly replyText: string | null;
  readonly undoKind: ActionKind | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export type RefusalCode =
  | 'not_found'
  | 'connection_needs_reconnect'
  | 'connection_inactive'
  | 'unsupported'
  | 'request_key_conflict';

export type RequestActionResult =
  /** `recorded`: the outcome was known up front (noop / not_eligible); nothing was sent. */
  | { readonly status: 'accepted' | 'recorded'; readonly action: ModerationActionView }
  | { readonly status: 'refused'; readonly code: RefusalCode }
  /** Longer than the platform accepts for this kind of reply; `max` is the limit in code points. */
  | { readonly status: 'refused'; readonly code: 'text_too_long'; readonly max: number };

const SAFE_OUTCOME_CODE = /^[a-z][a-z_]{0,63}$/;

/** `code` when it is a closed snake_case code (what fallback columns accept), otherwise `fallback`. */
export function safeOutcomeCode(code: string | null | undefined, fallback: string): string {
  return code && SAFE_OUTCOME_CODE.test(code) ? code : fallback;
}

/**
 * For automated actors: null when the requested action went through (or is
 * pending); otherwise a closed snake_case code saying why it did not, to record
 * as a fallback.
 */
export function actionFallbackCode(r: RequestActionResult): string | null {
  if (r.status === 'refused') return safeOutcomeCode(r.code, 'refused');
  const s = r.action.status;
  if (s === 'failed' || (r.status === 'recorded' && s === 'not_eligible'))
    return safeOutcomeCode(r.action.outcomeCode, s);
  return null;
}

export const REQUEST_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
/** Prefixes of request keys the server derives itself; clients cannot claim them. */
const RESERVED_KEY_PREFIXES = ['auto:', 'undo:', 'review:', 'clf:', 'pol:', 'rule-eval:'];

/** A request key a client may supply: well-formed and outside the server-generated key space. */
export const isClientRequestKey = (key: unknown): key is string =>
  typeof key === 'string' &&
  REQUEST_KEY.test(key) &&
  !RESERVED_KEY_PREFIXES.some((p) => key.startsWith(p));
export const REPLY_KINDS: ReadonlySet<ActionKind> = new Set(['public_reply', 'private_reply']);
const REQUEST_KEY_UNIQUE = 'moderation_action_organization_id_request_key_key';
const PRIVATE_REPLY_ONCE = 'moderation_action_private_reply_once_key';

export const VIEW_COLUMNS = `id, comment_id, kind, actor_type, actor_user_id, status, outcome_code,
  reply_text, undo_kind, created_at, completed_at`;

export const toView = (r: Record<string, unknown>): ModerationActionView => ({
  id: r.id as string,
  commentId: r.comment_id as string,
  kind: r.kind as ActionKind,
  actorType: r.actor_type as ActionActor['type'],
  actorUserId: (r.actor_user_id as string | null) ?? null,
  status: r.status as ActionStatus,
  outcomeCode: (r.outcome_code as string | null) ?? null,
  replyText: (r.reply_text as string | null) ?? null,
  undoKind: (r.undo_kind as ActionKind | null) ?? null,
  createdAt: r.created_at as Date,
  completedAt: (r.completed_at as Date | null) ?? null,
});

const INSERT = `
  INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type,
                                 actor_user_id, rule_id, request_key, reply_text, status, outcome_code,
                                 reverses_action_id, completed_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text, $12, $13,
          CASE WHEN $11::text = 'pending' THEN NULL ELSE now() END)
  RETURNING ${VIEW_COLUMNS}`;

/**
 * The audit record of a finished action. Details hold identifiers and codes
 * only: never the reply text or anything from the platform.
 */
export async function recordActionAudit(
  tx: pg.ClientBase,
  a: {
    organizationId: string;
    brandId: string;
    actionId: string;
    commentId: string;
    kind: ActionKind;
    actorType: ActionActor['type'];
    actorUserId: string | null;
    status: Exclude<ActionStatus, 'pending'>;
    outcomeCode: string | null;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_event (organization_id, brand_id, actor_type, actor_user_id, action,
                              subject_type, subject_id, details)
     VALUES ($1, $2, $3, $4, 'comment.moderated', 'comment', $5, $6::jsonb)`,
    [
      a.organizationId,
      a.brandId,
      a.actorType,
      a.actorUserId,
      a.commentId,
      JSON.stringify({
        actionId: a.actionId,
        kind: a.kind,
        status: a.status,
        outcomeCode: a.outcomeCode,
      }),
    ],
  );
}

interface Verdict {
  readonly status: 'pending' | 'noop' | 'not_eligible';
  readonly code: string | null;
}

interface Request {
  scope: BrandScope;
  commentId: string;
  kind: ActionKind;
  actor: ActionActor;
  requestKey: string;
  text?: string;
  /** The action in this brand this one reverses (an unhide for a hide). */
  reverses?: string;
}

/** A stored action with the action it reverses, for comparing a replay with the original request. */
interface StoredAction {
  readonly view: ModerationActionView;
  readonly reverses: string | null;
}

const refused = (code: RefusalCode): RequestActionResult => ({ status: 'refused', code });

/** Throws a TypeError on malformed input; the API validates before calling. Returns the reply text. */
function validate(i: Request): string | null {
  const bad = (f: string): never => {
    throw new TypeError(`Invalid moderation action request: ${f}`);
  };
  if (!(ACTION_KINDS as readonly string[]).includes(i.kind)) bad('kind');
  if (typeof i.requestKey !== 'string' || !REQUEST_KEY.test(i.requestKey)) bad('requestKey');
  const a = i.actor as { type?: unknown; userId?: unknown; ruleId?: unknown };
  if (a?.type === 'user') {
    if (typeof a.userId !== 'string' || !UUID.test(a.userId)) bad('actor');
  } else if (a?.type === 'rule') {
    if (typeof a.ruleId !== 'string' || !UUID.test(a.ruleId)) bad('actor');
  } else if (a?.type !== 'classifier' && a?.type !== 'policy' && a?.type !== 'system') bad('actor');
  if (i.reverses !== undefined && (typeof i.reverses !== 'string' || !UUID.test(i.reverses)))
    bad('reverses');
  if (!REPLY_KINDS.has(i.kind)) {
    if (i.text !== undefined) bad('text');
    return null;
  }
  const t = replyTextSchema.safeParse(i.text);
  return t.success ? t.data : bad('text');
}

export class ModerationActions {
  constructor(
    private readonly d: {
      pool: pg.Pool;
      store: PgCommentStore;
      producer: Pick<JobProducer, 'enqueue'>;
      capabilities: (p: Platform) => ConnectorCapabilities | undefined;
      clock: Clock;
      log: Logger;
    },
  ) {}

  async request(i: Request): Promise<RequestActionResult> {
    const text = validate(i);
    const comment = await this.d.store.load(i.scope, i.commentId);
    if (!comment) return refused('not_found');
    if (i.reverses !== undefined && !(await this.#inBrand(i.scope, i.reverses)))
      return refused('not_found');

    const existing = await this.#byKey(i.scope, i.requestKey);
    if (existing) return this.#replay(existing, i, comment);

    const blocked = connectionRefusal(comment.connectionStatus);
    if (blocked) return refused(blocked);

    const caps = this.d.capabilities(comment.platform);
    if (!caps) return refused('unsupported');
    // privateReplied was read with the comment; two racing private replies are
    // still caught by the unique index on insert.
    const e = evaluateEligibility({
      kind: i.kind,
      actorType: i.actor.type,
      comment: eligibilityComment(comment),
      caps,
      now: new Date(this.d.clock.now()),
    });
    if (e.verdict === 'unsupported') return refused('unsupported');
    if (text !== null) {
      const max = resolveConstraints(caps).maxReplyChars[i.kind as ResponseKind];
      if ([...text].length > max) return { status: 'refused', code: 'text_too_long', max };
    }

    return this.#insert(
      i,
      comment,
      text,
      e.verdict === 'ok' ? { status: 'pending', code: null } : { status: e.verdict, code: e.code },
    );
  }

  async list(scope: BrandScope, commentId: string): Promise<ModerationActionView[]> {
    if (!UUID.test(commentId)) return [];
    const r = await this.d.pool.query(
      `SELECT ${VIEW_COLUMNS} FROM moderation_action
        WHERE organization_id = $1 AND brand_id = $2 AND comment_id = $3
        ORDER BY created_at, id`,
      [scope.organizationId, scope.brandId, commentId],
    );
    return r.rows.map(toView);
  }

  async #insert(
    i: Request,
    c: CommentRow,
    text: string | null,
    v: Verdict,
  ): Promise<RequestActionResult> {
    const params = [
      i.scope.organizationId,
      i.scope.brandId,
      c.connectionId,
      c.id,
      i.kind,
      i.actor.type,
      i.actor.type === 'user' ? i.actor.userId : null,
      i.actor.type === 'rule' ? i.actor.ruleId : null,
      i.requestKey,
      text,
      v.status,
      v.code,
      i.reverses ?? null,
    ];
    let action: ModerationActionView;
    try {
      action =
        v.status === 'pending'
          ? toView((await this.d.pool.query(INSERT, params)).rows[0])
          : await withTransaction(this.d.pool, async (tx) => {
              const row = toView((await tx.query(INSERT, params)).rows[0]);
              await recordActionAudit(tx, {
                organizationId: i.scope.organizationId,
                brandId: i.scope.brandId,
                actionId: row.id,
                commentId: row.commentId,
                kind: row.kind,
                actorType: row.actorType,
                actorUserId: row.actorUserId,
                status: v.status as 'noop' | 'not_eligible',
                outcomeCode: v.code,
              });
              return row;
            });
    } catch (err) {
      if (isUniqueViolation(err, REQUEST_KEY_UNIQUE)) {
        // A concurrent request with the same key won, or the key is used in another brand.
        const existing = await this.#byKey(i.scope, i.requestKey);
        return existing ? this.#replay(existing, i, c) : refused('request_key_conflict');
      }
      if (isUniqueViolation(err, PRIVATE_REPLY_ONCE))
        return this.#insert(i, c, text, {
          status: 'not_eligible',
          code: 'private_reply_already_sent',
        });
      throw err;
    }
    this.d.log.info('moderation action requested', {
      actionId: action.id,
      kind: action.kind,
      actorType: action.actorType,
      status: action.status,
    });
    if (action.status !== 'pending') return { status: 'recorded', action };
    try {
      await this.#enqueue(i.scope, c, action.id);
    } catch (err) {
      // Nothing will run it, and a pending private reply would block later ones.
      await this.#markEnqueueFailed(i, action);
      throw err;
    }
    return { status: 'accepted', action };
  }

  async #markEnqueueFailed(i: Request, action: ModerationActionView): Promise<void> {
    await withTransaction(this.d.pool, async (tx) => {
      const u = await tx.query(
        `UPDATE moderation_action
            SET status = 'failed', outcome_code = 'enqueue_failed', completed_at = now()
          WHERE id = $3 AND organization_id = $1 AND brand_id = $2 AND status = 'pending'`,
        [i.scope.organizationId, i.scope.brandId, action.id],
      );
      if (u.rowCount === 0) return;
      await recordActionAudit(tx, {
        organizationId: i.scope.organizationId,
        brandId: i.scope.brandId,
        actionId: action.id,
        commentId: action.commentId,
        kind: action.kind,
        actorType: action.actorType,
        actorUserId: action.actorUserId,
        status: 'failed',
        outcomeCode: 'enqueue_failed',
      });
    });
  }

  async #replay(
    { view: existing, reverses }: StoredAction,
    i: Request,
    c: CommentRow,
  ): Promise<RequestActionResult> {
    if (
      existing.commentId !== c.id ||
      existing.kind !== i.kind ||
      reverses !== (i.reverses ?? null)
    )
      return refused('request_key_conflict');
    if (existing.status === 'pending') {
      await this.#enqueue(i.scope, c, existing.id);
      return { status: 'accepted', action: existing };
    }
    return {
      status:
        existing.status === 'noop' || existing.status === 'not_eligible' ? 'recorded' : 'accepted',
      action: existing,
    };
  }

  async #enqueue(scope: BrandScope, c: CommentRow, actionId: string): Promise<void> {
    await this.d.producer.enqueue({
      scope: {
        organizationId: scope.organizationId,
        brandId: scope.brandId,
        connectionId: c.connectionId,
      },
      platform: c.platform,
      type: EXECUTE_JOB.type,
      payload: { actionId },
    });
  }

  async #inBrand(scope: BrandScope, actionId: string): Promise<boolean> {
    const r = await this.d.pool.query(
      `SELECT 1 FROM moderation_action WHERE organization_id = $1 AND brand_id = $2 AND id = $3`,
      [scope.organizationId, scope.brandId, actionId],
    );
    return r.rowCount === 1;
  }

  async #byKey(scope: BrandScope, requestKey: string): Promise<StoredAction | null> {
    const r = await this.d.pool.query(
      `SELECT ${VIEW_COLUMNS}, reverses_action_id FROM moderation_action
        WHERE organization_id = $1 AND brand_id = $2 AND request_key = $3`,
      [scope.organizationId, scope.brandId, requestKey],
    );
    const row = r.rows[0];
    return row ? { view: toView(row), reverses: row.reverses_action_id ?? null } : null;
  }
}
