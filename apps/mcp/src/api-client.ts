import { createRequire } from 'node:module';
import * as z from 'zod';
import { UUID } from '@feedbouncer/service-runtime';
import type { McpConfig } from './config.js';

export const { version } = createRequire(import.meta.url)('../package.json') as {
  version: string;
};

export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string = code,
    readonly details?: Record<string, unknown>,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiCallError';
  }
}

const timestamp = z.iso.datetime({ offset: true });
// Responses take any string for values the tools only display, so a platform, status or
// operation the API adds later does not break parsing. Inputs stay strict.
const platform = z.string();

const CommentSchema = z.object({
  id: z.uuid(),
  brandId: z.uuid(),
  connectionId: z.uuid(),
  platform,
  externalId: z.string(),
  parentId: z.uuid().nullable(),
  authorName: z.string().nullable(),
  text: z.string(),
  textTruncated: z.boolean(),
  postedAt: timestamp,
  ingestedAt: timestamp,
  status: z.string(),
  flagged: z.boolean(),
  permalink: z.string().nullable(),
  isOwnAccount: z.boolean(),
});

const ActionSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['hide', 'unhide', 'public_reply']),
  commentId: z.uuid(),
  status: z.enum(['pending', 'applied', 'noop', 'not_eligible', 'failed']),
  code: z.string().nullable(),
  platformRef: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

const KeySchema = z.object({
  organizationId: z.uuid(),
  name: z.string(),
  scope: z.enum(['read', 'write']),
});

const CommentPageSchema = z.object({
  data: z.array(CommentSchema),
  nextCursor: z.string().nullable(),
});

const ReplyResultSchema = z.object({ action: ActionSchema, comment: CommentSchema });

const ModerationResultSchema = z.object({
  action: z.object({
    id: z.uuid(),
    kind: z.enum(['hide', 'unhide']),
    status: ActionSchema.shape.status,
    code: z.string().nullable(),
  }),
  comment: CommentSchema,
});

const SummarySchema = z.object({
  period: z.object({ from: timestamp, to: timestamp }),
  bounded: z.object({ requestedFrom: timestamp, reason: z.string() }).nullable(),
  totals: z.object({
    comments: z.int(),
    hidden: z.int(),
    replied: z.int(),
    unanswered: z.int(),
  }),
  categories: z.array(z.object({ category: z.string(), count: z.int() })),
  topRules: z.array(z.object({ ruleId: z.uuid(), name: z.string(), matches: z.int() })),
  notableThreads: z.array(
    z.object({
      commentId: z.uuid(),
      platform,
      authorName: z.string().nullable(),
      textPreview: z.string(),
      replies: z.int(),
      postedAt: timestamp,
    }),
  ),
});

const proposalOperation = z.string();
const proposalStatus = z.string();

const RulesSchema = z.object({
  brands: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      ruleRevision: z.int(),
      rules: z.array(
        z.object({
          id: z.uuid(),
          name: z.string(),
          conditions: z.record(z.string(), z.unknown()),
          actions: z.array(z.record(z.string(), z.unknown())),
          mode: z.string(),
          priority: z.int(),
          enabled: z.boolean(),
        }),
      ),
      changes: z.array(
        z.object({
          id: z.uuid(),
          operation: proposalOperation,
          ruleId: z.uuid().nullable(),
          status: proposalStatus,
          expiresAt: timestamp,
          decidedAt: timestamp.nullable(),
        }),
      ),
    }),
  ),
});

const ProposalSchema = z.object({
  id: z.uuid(),
  brandId: z.uuid(),
  operation: proposalOperation,
  ruleId: z.uuid().nullable(),
  status: proposalStatus,
  diff: z.array(
    z.object({
      field: z.enum(['name', 'conditions', 'actions', 'mode', 'enabled']),
      before: z.unknown(),
      after: z.unknown(),
    }),
  ),
  warnings: z.array(z.string()),
  expiresAt: timestamp,
  baseRuleRevision: z.int(),
  reviewUrl: z.string(),
});

export type Comment = z.output<typeof CommentSchema>;
export type Action = z.output<typeof ActionSchema>;
export type Key = z.output<typeof KeySchema>;
export type CommentPage = z.output<typeof CommentPageSchema>;
export type ReplyResult = z.output<typeof ReplyResultSchema>;
export type ModerationResult = z.output<typeof ModerationResultSchema>;
export type Summary = z.output<typeof SummarySchema>;
export type RulesResponse = z.output<typeof RulesSchema>;
export type Proposal = z.output<typeof ProposalSchema>;

// Undefined fields are omitted from the query string.
export interface ListQuery {
  status?: 'visible' | 'hidden' | 'flagged' | 'replied' | 'unanswered' | undefined;
  brandId?: string | undefined;
  platform?: 'facebook' | 'instagram' | undefined;
  q?: string | undefined;
  postedFrom?: string | undefined;
  postedTo?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface SummaryQuery {
  from?: string | undefined;
  to?: string | undefined;
  brandId?: string | undefined;
}

export type RuleChangeBody =
  | { operation: 'create'; brandId: string; rationale?: string; rule: Record<string, unknown> }
  | {
      operation: 'update';
      brandId: string;
      rationale?: string;
      ruleId: string;
      patch: Record<string, unknown>;
    }
  | { operation: 'archive'; brandId: string; rationale?: string; ruleId: string };

const ErrorBodySchema = z.object({
  error: z.looseObject({ code: z.string(), message: z.string().optional() }),
});

const badResponse = () => new ApiCallError(502, 'bad_response', 'Unexpected API response');

function assertUuid(id: string): string {
  if (!UUID.test(id)) throw new ApiCallError(400, 'invalid_request', 'Invalid ID');
  return encodeURIComponent(id);
}

function queryString(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

function toApiError(res: Response, body: unknown): ApiCallError {
  const parsed = ErrorBodySchema.safeParse(body);
  if (!parsed.success) return badResponse();
  const { code, message, ...details } = parsed.data.error;
  const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
  return new ApiCallError(
    res.status,
    code,
    message,
    Object.keys(details).length > 0 ? details : undefined,
    Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined,
  );
}

export class FeedBouncerApi {
  constructor(
    private readonly cfg: McpConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    schema: S,
    opts: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<{ status: number; body: z.output<S> }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.cfg.apiKey.reveal()}`,
      'user-agent': `feedbouncer-mcp/${version}`,
      accept: 'application/json',
    };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;

    const base = this.cfg.apiBaseUrl;
    const url = new URL(`${base.pathname.replace(/\/$/, '')}${path}`, base);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.cfg.requestTimeoutMs),
      });
    } catch {
      // The cause is dropped on purpose: it can echo request details.
      throw new ApiCallError(503, 'unreachable', 'FeedBouncer API is unreachable');
    }

    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok) throw toApiError(res, json);
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw badResponse();
    return { status: res.status, body: parsed.data };
  }

  async whoami(): Promise<Key> {
    return (await this.request('GET', '/v1/key', KeySchema)).body;
  }

  async listComments(q: ListQuery): Promise<CommentPage> {
    return (await this.request('GET', `/v1/comments${queryString(q)}`, CommentPageSchema)).body;
  }

  async reply(
    commentId: string,
    text: string,
    idempotencyKey: string,
  ): Promise<{ status: number; body: ReplyResult }> {
    return this.request(
      'POST',
      `/v1/comments/${assertUuid(commentId)}/replies`,
      ReplyResultSchema,
      {
        body: { text },
        idempotencyKey,
      },
    );
  }

  async setVisibility(
    commentId: string,
    visibility: 'hidden' | 'visible',
    idempotencyKey: string,
  ): Promise<ModerationResult> {
    const route = visibility === 'hidden' ? 'hide' : 'unhide';
    return (
      await this.request(
        'POST',
        `/v1/comments/${assertUuid(commentId)}/${route}`,
        ModerationResultSchema,
        { body: {}, idempotencyKey },
      )
    ).body;
  }

  async getAction(id: string): Promise<Action> {
    return (await this.request('GET', `/v1/actions/${assertUuid(id)}`, ActionSchema)).body;
  }

  async summary(q: SummaryQuery): Promise<Summary> {
    return (await this.request('GET', `/v1/summary${queryString(q)}`, SummarySchema)).body;
  }

  async rules(brandId?: string): Promise<RulesResponse> {
    return (await this.request('GET', `/v1/rules${queryString({ brandId })}`, RulesSchema)).body;
  }

  async proposeRuleChange(body: RuleChangeBody, idempotencyKey: string): Promise<Proposal> {
    return (
      await this.request('POST', '/v1/rule-change-proposals', ProposalSchema, {
        body,
        idempotencyKey,
      })
    ).body;
  }
}

/** The API surface the tools depend on; tests substitute an in-memory double. */
export type ApiPort = Pick<
  FeedBouncerApi,
  | 'whoami'
  | 'listComments'
  | 'reply'
  | 'setVisibility'
  | 'getAction'
  | 'summary'
  | 'rules'
  | 'proposeRuleChange'
>;
