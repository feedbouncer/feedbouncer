import type { OrgFixture } from '../testing/harness.js';

export interface IsolationFixture {
  A: OrgFixture;
  B: OrgFixture;
  bInvitationId: string;
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

/** /api/v1 routes that act on the signed-in account or on a token, not on a path organization. */
export const ACCOUNT_ROUTES = [
  'POST /api/v1/auth/sign-up',
  'GET /api/v1/me',
  'GET /api/v1/orgs',
  'POST /api/v1/orgs',
  'POST /api/v1/invitations/lookup',
  'POST /api/v1/invitations/accept',
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
