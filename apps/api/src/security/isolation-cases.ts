import type { OrgFixture } from '../testing/harness.js';

export interface IsolationFixture {
  A: OrgFixture;
  B: OrgFixture;
  bInvitationId: string;
  /** The emailed token of B's pending invitation, which is for another address. */
  bInvitationToken: string;
  /** B's Facebook connection, a comment on it, and a pending OAuth grant of B's owner. */
  bConnectionId: string;
  bCommentId: string;
  bGrantId: string;
  /** B's rule and own domain. */
  bRuleId: string;
  bDomainId: string;
  /** B's classifier re-run. */
  bClassifierRunId: string;
  /** B's custom policy and a dry-run preview of it. */
  bPolicyId: string;
  bPreviewId: string;
  /** B's live connection and B owner's pending grant, per account-selection platform. */
  bConnectionIds: Record<'facebook' | 'instagram', string>;
  bGrantIds: Record<'facebook' | 'instagram', string>;
}

export interface IsolationCase {
  /** The route as registered, "METHOD /api/v1/orgs/:orgId/...". */
  route: string;
  name: string;
  url: (f: IsolationFixture) => string;
  body?: (f: IsolationFixture) => unknown;
}

// Organization A's owner against organization B, always expecting a plain 404.
export const CASES: IsolationCase[] = [
  { route: 'GET /api/v1/orgs/:orgId', name: 'read B org', url: (f) => `/api/v1/orgs/${f.B.orgId}` },
  {
    route: 'PATCH /api/v1/orgs/:orgId',
    name: 'rename B org',
    url: (f) => `/api/v1/orgs/${f.B.orgId}`,
    body: () => ({ name: 'pwned' }),
  },
  {
    route: 'DELETE /api/v1/orgs/:orgId',
    name: 'delete B org',
    url: (f) => `/api/v1/orgs/${f.B.orgId}`,
    body: () => ({ confirmName: 'isoB Org' }),
  },
  {
    route: 'POST /api/v1/orgs/:orgId/transfer-ownership',
    name: 'transfer B',
    url: (f) => `/api/v1/orgs/${f.B.orgId}/transfer-ownership`,
    body: (f) => ({ userId: f.A.owner.userId, newRoleForSelf: 'owner' }),
  },
  {
    route: 'GET /api/v1/orgs/:orgId/brands',
    name: 'list B brands',
    url: (f) => `/api/v1/orgs/${f.B.orgId}/brands`,
  },
  {
    route: 'POST /api/v1/orgs/:orgId/brands',
    name: 'create B brand',
    url: (f) => `/api/v1/orgs/${f.B.orgId}/brands`,
    body: () => ({ name: 'x' }),
  },
  {
    route: 'GET /api/v1/orgs/:orgId/brands/:brandId',
    name: 'B brand under A path (IDOR)',
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}`,
  },
  {
    route: 'PATCH /api/v1/orgs/:orgId/brands/:brandId',
    name: 'rename B brand under A path',
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}`,
    body: () => ({ name: 'pwned' }),
  },
  {
    route: 'POST /api/v1/orgs/:orgId/brands/:brandId/archive',
    name: 'archive B brand under A path',
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/archive`,
    body: () => ({}),
  },
  {
    route: 'GET /api/v1/orgs/:orgId/brands/:brandId/connections/health',
    name: "connection health of another tenant's brand",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/connections/health`,
  },
  // The connect flow, once per account-selection platform.
  ...(['facebook', 'instagram'] as const).flatMap((p): IsolationCase[] => [
    {
      route: 'POST /api/v1/orgs/:orgId/brands/:brandId/connections/:platform/authorize',
      name: `${p}: authorize B brand under A path`,
      url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/connections/${p}/authorize`,
      body: () => ({}),
    },
    {
      route: 'POST /api/v1/orgs/:orgId/brands/:brandId/connections/:platform/authorize',
      name: `${p}: reconnect B's connection from A's brand`,
      url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/connections/${p}/authorize`,
      body: (f) => ({ reconnectConnectionId: f.bConnectionIds[p] }),
    },
    {
      route: 'GET /api/v1/orgs/:orgId/brands/:brandId/connections/:platform/grants/:grantId',
      name: `${p}: B's grant under A's brand`,
      url: (f) =>
        `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/connections/${p}/grants/${f.bGrantIds[p]}`,
    },
    {
      route: 'GET /api/v1/orgs/:orgId/brands/:brandId/connections/:platform/grants/:grantId',
      name: `${p}: B's grant under B's brand from A`,
      url: (f) =>
        `/api/v1/orgs/${f.B.orgId}/brands/${f.B.brandId}/connections/${p}/grants/${f.bGrantIds[p]}`,
    },
    {
      route:
        'POST /api/v1/orgs/:orgId/brands/:brandId/connections/:platform/grants/:grantId/connect',
      name: `${p}: connect with B's grant`,
      url: (f) =>
        `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/connections/${p}/grants/${f.bGrantIds[p]}/connect`,
      body: () => ({ accountIds: ['1'] }),
    },
  ]),
  {
    route: 'GET /api/v1/orgs/:orgId/brands/:brandId/connections',
    name: 'list B connections',
    url: (f) => `/api/v1/orgs/${f.B.orgId}/brands/${f.B.brandId}/connections`,
  },
  {
    route: 'DELETE /api/v1/orgs/:orgId/brands/:brandId/connections/:connectionId',
    name: 'disconnect B connection under A brand',
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/connections/${f.bConnectionId}`,
  },
  {
    route: 'GET /api/v1/orgs/:orgId/brands/:brandId/ads',
    name: 'list B ads',
    url: (f) => `/api/v1/orgs/${f.B.orgId}/brands/${f.B.brandId}/ads`,
  },
  {
    route: 'GET /api/v1/orgs/:orgId/brands/:brandId/comments',
    name: 'list B comments',
    url: (f) => `/api/v1/orgs/${f.B.orgId}/brands/${f.B.brandId}/comments`,
  },
  {
    route: 'GET /api/v1/orgs/:orgId/brands/:brandId/comments/:commentId/actions',
    name: "B comment's actions under A brand",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/comments/${f.bCommentId}/actions`,
  },
  {
    route: 'POST /api/v1/orgs/:orgId/brands/:brandId/comments/:commentId/actions',
    name: 'hide B comment under A brand',
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/comments/${f.bCommentId}/actions`,
    body: () => ({ kind: 'hide', requestKey: 'iso-1' }),
  },
  {
    route: 'GET /api/v1/orgs/:orgId/brands/:brandId/rules',
    name: 'list B rules',
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/rules`,
  },
  {
    route: 'POST /api/v1/orgs/:orgId/brands/:brandId/rules',
    name: 'create a rule in B brand under A path',
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/rules`,
    body: () => ({ name: 'x', conditions: { type: 'keyword', terms: ['x'] }, action: 'flag' }),
  },
  {
    route: 'PUT /api/v1/orgs/:orgId/brands/:brandId/rules/order',
    name: 'reorder B rules under A path',
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/rules/order`,
    body: (f) => ({ ruleIds: [f.bRuleId] }),
  },
  {
    route: 'GET /api/v1/orgs/:orgId/brands/:brandId/rules/:ruleId',
    name: "B's rule under A brand",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/rules/${f.bRuleId}`,
  },
  {
    route: 'PATCH /api/v1/orgs/:orgId/brands/:brandId/rules/:ruleId',
    name: "disable B's rule under A brand",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/rules/${f.bRuleId}`,
    body: () => ({ enabled: false }),
  },
  {
    route: 'DELETE /api/v1/orgs/:orgId/brands/:brandId/rules/:ruleId',
    name: "archive B's rule under A brand",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/rules/${f.bRuleId}`,
  },
  {
    route: 'DELETE /api/v1/orgs/:orgId/brands/:brandId/rules/:ruleId',
    name: "archive B's rule under B brand from A",
    url: (f) => `/api/v1/orgs/${f.B.orgId}/brands/${f.B.brandId}/rules/${f.bRuleId}`,
  },
  {
    route: 'GET /api/v1/orgs/:orgId/brands/:brandId/domains',
    name: 'list B domains',
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/domains`,
  },
  {
    route: 'POST /api/v1/orgs/:orgId/brands/:brandId/domains',
    name: 'add a domain to B brand under A path',
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/domains`,
    body: () => ({ domain: 'example.org' }),
  },
  {
    route: 'DELETE /api/v1/orgs/:orgId/brands/:brandId/domains/:domainId',
    name: "remove B's domain under A brand",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/domains/${f.bDomainId}`,
  },
  {
    route: 'GET /api/v1/orgs/:orgId/brands/:brandId/rule-activity',
    name: 'B rule activity under A path',
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/rule-activity`,
  },
  {
    route: 'GET /api/v1/orgs/:orgId/brands/:brandId/comments/:commentId/decisions',
    name: "B comment's decisions under A brand",
    url: (f) =>
      `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/comments/${f.bCommentId}/decisions`,
  },
  {
    route: 'GET /api/v1/orgs/:orgId/brands/:brandId/classifier/settings',
    name: "read B's classifier settings via B ids under A org",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/classifier/settings`,
  },
  {
    route: 'PUT /api/v1/orgs/:orgId/brands/:brandId/classifier/settings',
    name: "change B's thresholds via A org",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/classifier/settings`,
    body: () => ({ categories: [{ category: 'spam', threshold: 0, action: 'remove' }] }),
  },
  {
    route: 'POST /api/v1/orgs/:orgId/brands/:brandId/classifier/preview',
    name: "preview on B's comments via A org",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/classifier/preview`,
    body: () => ({ categories: [{ category: 'spam', useDefault: true }] }),
  },
  {
    route: 'POST /api/v1/orgs/:orgId/brands/:brandId/classifier/reruns',
    name: "re-run B's classification via A org",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/classifier/reruns`,
    body: () => ({ days: 1 }),
  },
  {
    route: 'GET /api/v1/orgs/:orgId/brands/:brandId/classifier/reruns/:runId',
    name: "read B's run under A brand",
    url: (f) =>
      `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/classifier/reruns/${f.bClassifierRunId}`,
  },
  {
    route: 'GET /api/v1/orgs/:orgId/brands/:brandId/comments/:commentId/classification',
    name: "read B's comment classification under A brand",
    url: (f) =>
      `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/comments/${f.bCommentId}/classification`,
  },
  {
    route: 'GET /api/v1/orgs/:orgId/brands/:brandId/policies',
    name: "list B's policies via A org",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/policies`,
  },
  {
    route: 'POST /api/v1/orgs/:orgId/brands/:brandId/policies',
    name: 'create a policy in B brand under A path',
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/policies`,
    body: () => ({ name: 'x', text: 'Hide comments asking for DMs', action: 'flag' }),
  },
  {
    route: 'GET /api/v1/orgs/:orgId/brands/:brandId/policies/:policyId',
    name: "get B's policy via A org",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/policies/${f.bPolicyId}`,
  },
  {
    route: 'GET /api/v1/orgs/:orgId/brands/:brandId/policies/:policyId',
    name: "get B's policy id under A's own brand",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/policies/${f.bPolicyId}`,
  },
  {
    route: 'PATCH /api/v1/orgs/:orgId/brands/:brandId/policies/:policyId',
    name: "patch B's policy via A org",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/policies/${f.bPolicyId}`,
    body: () => ({ enabled: true }),
  },
  {
    route: 'PATCH /api/v1/orgs/:orgId/brands/:brandId/policies/:policyId',
    name: "patch B's policy id under A's own brand",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/policies/${f.bPolicyId}`,
    body: () => ({ enabled: true }),
  },
  {
    route: 'DELETE /api/v1/orgs/:orgId/brands/:brandId/policies/:policyId',
    name: "delete B's policy via A org",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/policies/${f.bPolicyId}`,
  },
  {
    route: 'DELETE /api/v1/orgs/:orgId/brands/:brandId/policies/:policyId',
    name: "delete B's policy id under A's own brand",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/policies/${f.bPolicyId}`,
  },
  {
    route: 'POST /api/v1/orgs/:orgId/brands/:brandId/policies/:policyId/runs',
    name: "apply B's policy via A org",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/policies/${f.bPolicyId}/runs`,
    body: () => ({ days: 1 }),
  },
  {
    route: 'POST /api/v1/orgs/:orgId/brands/:brandId/policies/:policyId/runs',
    name: "apply B's policy id under A's own brand",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/policies/${f.bPolicyId}/runs`,
    body: () => ({ days: 1 }),
  },
  {
    route: 'POST /api/v1/orgs/:orgId/brands/:brandId/policy-previews',
    name: 'preview in B brand under A path',
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/policy-previews`,
    body: () => ({ text: 'Hide comments asking for DMs', action: 'flag' }),
  },
  {
    route: 'POST /api/v1/orgs/:orgId/brands/:brandId/policy-previews',
    name: "preview B's policy text under A's own brand",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/policy-previews`,
    body: (f) => ({ text: 'Hide comments asking for DMs', action: 'flag', policyId: f.bPolicyId }),
  },
  {
    route: 'GET /api/v1/orgs/:orgId/brands/:brandId/policy-previews/:previewId',
    name: "read B's preview via A org",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/policy-previews/${f.bPreviewId}`,
  },
  {
    route: 'GET /api/v1/orgs/:orgId/brands/:brandId/policy-previews/:previewId',
    name: "read B's preview id under A's own brand",
    url: (f) => `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/policy-previews/${f.bPreviewId}`,
  },
  {
    route: 'GET /api/v1/orgs/:orgId/brands/:brandId/comments/:commentId/policy-evaluation',
    name: "B comment's policy evaluation via A org",
    url: (f) =>
      `/api/v1/orgs/${f.A.orgId}/brands/${f.B.brandId}/comments/${f.bCommentId}/policy-evaluation`,
  },
  {
    route: 'GET /api/v1/orgs/:orgId/brands/:brandId/comments/:commentId/policy-evaluation',
    name: "B comment's policy evaluation under A's own brand",
    url: (f) =>
      `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/comments/${f.bCommentId}/policy-evaluation`,
  },
  {
    route: 'GET /api/v1/orgs/:orgId/members',
    name: 'list B members',
    url: (f) => `/api/v1/orgs/${f.B.orgId}/members`,
  },
  {
    route: 'PATCH /api/v1/orgs/:orgId/members/:userId',
    name: 'change B member role under A path',
    url: (f) => `/api/v1/orgs/${f.A.orgId}/members/${f.B.member.userId}`,
    body: () => ({ role: 'admin' }),
  },
  {
    route: 'DELETE /api/v1/orgs/:orgId/members/:userId',
    name: 'remove B member under A path',
    url: (f) => `/api/v1/orgs/${f.A.orgId}/members/${f.B.member.userId}`,
  },
  {
    route: 'GET /api/v1/orgs/:orgId/invitations',
    name: 'list B invitations',
    url: (f) => `/api/v1/orgs/${f.B.orgId}/invitations`,
  },
  {
    route: 'POST /api/v1/orgs/:orgId/invitations',
    name: 'invite into B',
    url: (f) => `/api/v1/orgs/${f.B.orgId}/invitations`,
    body: () => ({ email: 'z@x.test', role: 'owner' }),
  },
  {
    route: 'POST /api/v1/orgs/:orgId/invitations/:invitationId/revoke',
    name: 'revoke B invite under A path',
    url: (f) => `/api/v1/orgs/${f.A.orgId}/invitations/${f.bInvitationId}/revoke`,
    body: () => ({}),
  },
];

export interface TokenCase {
  route: string;
  name: string;
  body: (f: IsolationFixture) => unknown;
  status: number;
  /** The whole response body: nothing else about B may be revealed. */
  response: unknown;
}

// Organization A's owner presenting B's invitation token (an invitation for
// another address). Lookup may show only what the invitation page needs;
// accepting is refused with the mismatch error and changes nothing.
export const TOKEN_CASES: TokenCase[] = [
  {
    route: 'POST /api/v1/invitations/lookup',
    name: "look up B's invitation",
    body: (f) => ({ token: f.bInvitationToken }),
    status: 200,
    response: { organizationName: 'isoB Org', role: 'member', emailMatches: false },
  },
  {
    route: 'POST /api/v1/invitations/accept',
    name: "accept B's invitation for another address",
    body: (f) => ({ token: f.bInvitationToken }),
    status: 403,
    response: {
      error: {
        code: 'invitation_email_mismatch',
        message: 'This invitation was sent to a different email address.',
      },
    },
  },
];

/** /api/v1 routes that act on the signed-in account or on a token, not on a path organization. */
export const ACCOUNT_ROUTES = [
  'POST /api/v1/auth/sign-up',
  'GET /api/v1/me',
  'GET /api/v1/orgs',
  'POST /api/v1/orgs',
  'POST /api/v1/invitations/lookup',
  'POST /api/v1/invitations/accept',
  /** The OAuth redirect lands here; the organization comes from the user's own pending state. */
  'GET /api/v1/oauth/:platform/callback',
];

/**
 * /api/v1 routes with no session that authenticate by platform signature or
 * verify token instead. Each declares `config.publicWebhook`, which also exempts
 * it from the Origin check; the route inventory test pins both lists.
 */
export const PUBLIC_ROUTES = [
  'GET /api/v1/webhooks/facebook',
  'POST /api/v1/webhooks/facebook',
  'GET /api/v1/webhooks/instagram',
  'POST /api/v1/webhooks/instagram',
];

/** The Better Auth endpoints the /api/auth proxy forwards; everything else is a 404. */
export const PROXY_ROUTES = [
  'GET /verify-email',
  'POST /change-password',
  'POST /delete-user',
  'POST /request-password-reset',
  'POST /reset-password',
  'POST /send-verification-email',
  'POST /sign-in/email',
  'POST /sign-out',
];
