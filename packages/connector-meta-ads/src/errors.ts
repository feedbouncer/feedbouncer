// Refines Graph errors for ad-account reads. Numeric codes only; the Graph
// message is never read (see connector-facebook graph.ts).
import { ConnectorError } from '@feedbouncer/connectors';
import { graphErrorCodes } from '@feedbouncer/connector-facebook';

/** Graph codes meaning this user may not read this ad account: 10, 270 and 200..299 (A8 in the README). */
export const AD_ACCOUNT_PERMISSION_CODES: ReadonlySet<number> = new Set([
  10,
  270,
  ...Array.from({ length: 100 }, (_, i) => 200 + i),
]);

const lost = () => new ConnectorError('auth_expired', 'ads_permission_missing');

/** Lost ad-account access (or an account that is gone) is one reconnectable condition; throttles and the rest pass through. */
export function mapAdsError(e: unknown): ConnectorError {
  if (!(e instanceof ConnectorError)) return new ConnectorError('permanent', 'unexpected_error');
  const c = graphErrorCodes(e);
  if (c?.code != null && AD_ACCOUNT_PERMISSION_CODES.has(c.code)) return lost();
  if (c?.code === 100 && c.subcode === 33) return lost();
  if (e.kind === 'auth_expired') return lost();
  return e;
}
