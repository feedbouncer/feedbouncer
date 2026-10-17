import { UUID_RE } from '@feedbouncer/alerts';

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function checked(re: RegExp, v: string, what: string): string {
  if (!re.test(v)) throw new TypeError(`invalid ${what}`);
  return v;
}

export const dashboardLink = (web: URL, orgId: string, weekStart: string): string =>
  `${web.origin}/orgs/${checked(UUID_RE, orgId, 'id').toLowerCase()}/reports?week=${checked(WEEK_RE, weekStart, 'week')}`;

export const unsubscribePageLink = (web: URL, token: string): string =>
  `${web.origin}/reports/unsubscribe?token=${checked(TOKEN_RE, token, 'token')}`;

export const unsubscribeApiLink = (web: URL, token: string): string =>
  `${web.origin}/api/v1/report-subscriptions/unsubscribe?token=${checked(TOKEN_RE, token, 'token')}`;

export const settingsLink = (web: URL): string => `${web.origin}/account#email-reports`;
