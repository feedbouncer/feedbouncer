// Instagram (Facebook Login) account listing: Pages the user manages, each with
// its linked Instagram professional account. The Page token is what is kept.
import { ConnectorError, type GrantableAccount, type OAuthContext } from '@feedbouncer/connectors';
import { GRAPH_ID, graphRequest, type GraphCall } from '@feedbouncer/connector-facebook';
import { Secret } from '@feedbouncer/service-runtime';
import * as z from 'zod';
import type { InstagramConfig } from './config.js';

const MAX_PAGES_OF_ACCOUNTS = 10;

const accountsPage = z.object({
  data: z.array(z.unknown()).max(200),
  paging: z
    .object({
      cursors: z.object({ after: z.string().max(2048).optional() }).optional(),
      next: z.string().optional(),
    })
    .optional(),
});
const permissionsResponse = z.object({
  data: z
    .array(z.object({ permission: z.string().regex(/^[a-z_]{1,64}$/), status: z.string() }))
    .max(200),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new ConnectorError('permanent', 'invalid_graph_response');
  return r.data;
}

const safeId = (v: unknown): string | null =>
  typeof v === 'string' && GRAPH_ID.test(v) ? v : null;

export async function listInstagramAccounts(
  cfg: InstagramConfig,
  nowMs: () => number,
  userToken: Secret,
  ctx: OAuthContext,
): Promise<readonly GrantableAccount[]> {
  const c: GraphCall = {
    http: ctx.http,
    signal: ctx.signal,
    version: cfg.meta.graphVersion,
    appSecret: cfg.meta.appSecret,
    token: userToken,
    nowMs,
  };
  const pages: unknown[] = [];
  let after: string | undefined;
  for (let i = 0; i < MAX_PAGES_OF_ACCOUNTS; i++) {
    const page: z.infer<typeof accountsPage> = parse(
      accountsPage,
      (
        await graphRequest(c, {
          method: 'GET',
          path: ['me', 'accounts'],
          query: {
            fields: 'id,name,tasks,access_token,instagram_business_account{id,username}',
            limit: '100',
            ...(after ? { after } : {}),
          },
        })
      ).body,
    );
    pages.push(...page.data);
    // Follow the cursor, never the `next` URL: we rebuild the URL ourselves on the allowed host.
    after = page.paging?.next ? page.paging.cursors?.after : undefined;
    if (!after) break;
  }

  const perms = parse(
    permissionsResponse,
    (await graphRequest(c, { method: 'GET', path: ['me', 'permissions'] })).body,
  );
  const granted = new Set(
    perms.data.filter((p) => p.status === 'granted').map((p) => p.permission),
  );
  const messaging = granted.has('instagram_manage_messages');

  const out: GrantableAccount[] = [];
  for (const raw of pages) {
    if (typeof raw !== 'object' || raw === null) continue; // one malformed entry must not hide the others
    const p = raw as {
      id?: unknown;
      name?: unknown;
      tasks?: unknown;
      access_token?: unknown;
      instagram_business_account?: { id?: unknown; username?: unknown } | null;
    };
    const pageId = safeId(p.id);
    if (!pageId || typeof p.access_token !== 'string' || p.access_token.length === 0) continue;
    const ig = p.instagram_business_account;
    const igId = ig ? safeId(ig.id) : null;
    if (ig && !igId) continue; // hostile id: drop entirely
    const moderate = Array.isArray(p.tasks) && p.tasks.includes('MODERATE');
    const name = typeof p.name === 'string' ? p.name.slice(0, 200) : null;
    const user =
      ig && typeof ig.username === 'string' && /^[A-Za-z0-9._]{1,30}$/.test(ig.username)
        ? ig.username
        : null;
    out.push(
      igId
        ? {
            externalAccountId: igId,
            displayName: (
              (user ? `@${user}` : 'Instagram account') + (name ? ` (via ${name})` : '')
            ).slice(0, 500),
            eligible: moderate,
            ineligibleReason: moderate ? null : 'insufficient_page_role',
            limitations: messaging ? [] : ['messaging_permission_missing'],
            accessToken: new Secret(p.access_token),
          }
        : {
            externalAccountId: pageId, // placeholder; never connectable (Decision 2)
            displayName: name,
            eligible: false,
            ineligibleReason: 'no_linked_instagram_account',
            limitations: [],
            accessToken: new Secret(p.access_token),
          },
    );
  }
  return out;
}
