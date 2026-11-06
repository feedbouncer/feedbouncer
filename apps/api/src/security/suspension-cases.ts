/**
 * What a suspended organization does to each /api/v1 route outside OrgAccessGuard.
 * suspension.integration.test.ts pins the keys to ACCOUNT_ROUTES and checks the behavior.
 *
 * - unaffected: no existing organization is involved.
 * - lists_status: suspended organizations stay listed with their status.
 * - filtered: a suspended organization's data is left out.
 * - denied: members get 403 organization_suspended.
 * - denied_opaque: the membership read treats the organization as absent, so the
 *   request fails like any other rejection.
 */
export type SuspensionDisposition =
  | 'unaffected'
  | 'lists_status'
  | 'filtered'
  | 'denied'
  | 'denied_opaque';

export const ACCOUNT_ROUTE_SUSPENSION: Readonly<Record<string, SuspensionDisposition>> = {
  'POST /api/v1/auth/sign-up': 'unaffected',
  'POST /api/v1/orgs': 'unaffected',
  'GET /api/v1/me': 'lists_status',
  'GET /api/v1/orgs': 'lists_status',
  'GET /api/v1/me/hidden-today': 'filtered',
  'GET /api/v1/me/report-subscriptions': 'unaffected',
  'PUT /api/v1/me/report-subscriptions/:organizationId': 'denied',
  'POST /api/v1/invitations/lookup': 'unaffected',
  'POST /api/v1/invitations/accept': 'denied',
  'GET /api/v1/oauth/:platform/callback': 'denied_opaque',
};
