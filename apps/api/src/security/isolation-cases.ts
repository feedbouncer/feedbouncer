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
