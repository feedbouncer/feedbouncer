// Instagram-specific refinement of Graph errors. Numeric codes only; the Graph
// message is never read (see connector-facebook graph.ts). The codes in the
// tables are unverified placeholders (V3 in the README).
import { ConnectorError } from '@feedbouncer/connectors';
import { graphErrorCodes } from '@feedbouncer/connector-facebook';

export type IgOp = 'read' | 'moderate' | 'public_reply' | 'private_reply' | 'lifecycle';

export const IG_PRIVATE_REPLY_INELIGIBLE: ReadonlyArray<{
  code: number;
  subcode: number | null;
  outcome: string;
}> = [
  { code: 10900, subcode: null, outcome: 'private_reply_already_sent' },
  { code: 10, subcode: 2018278, outcome: 'private_reply_window_closed' },
  { code: 100, subcode: 2534024, outcome: 'private_reply_nested_comment' }, // V3
  { code: 551, subcode: null, outcome: 'author_unavailable' },
  { code: 100, subcode: 2018001, outcome: 'author_unavailable' },
];
const PUBLIC_REPLY_INELIGIBLE: ReadonlyArray<{
  code: number;
  subcode: number | null;
  outcome: string;
}> = [{ code: 100, subcode: 2534023, outcome: 'reply_to_hidden_comment' }]; // V3

type Row = { readonly code: number; readonly subcode: number | null; readonly outcome: string };
const match = (t: readonly Row[], c: { code: number | null; subcode: number | null }) =>
  t.find((r) => r.code === c.code && (r.subcode === null || r.subcode === c.subcode))?.outcome;

/** Returns either a ConnectorError to throw, or a not_eligible outcome code (private/public reply only). */
export function mapInstagramError(
  e: ConnectorError,
  op: IgOp,
): { throw: ConnectorError } | { notEligible: string } {
  const codes = graphErrorCodes(e) ?? { code: null, subcode: null };
  // The specific private-reply rows must beat the generic permission mapping:
  // graph.ts maps code 10 (including 10/2018278) to permission_denied.
  if (op === 'private_reply') {
    const o = match(IG_PRIVATE_REPLY_INELIGIBLE, codes);
    if (o) return { notEligible: o };
    if (e.code === 'permission_denied') return { notEligible: 'private_reply_not_permitted' };
  }
  if (op === 'public_reply') {
    const o = match(PUBLIC_REPLY_INELIGIBLE, codes);
    if (o) return { notEligible: o };
  }
  if (e.code === 'permission_denied') {
    return { throw: new ConnectorError('auth_expired', 'permission_revoked') };
  }
  if (codes.code === 25) {
    return { throw: new ConnectorError('permanent', 'instagram_account_restricted') };
  }
  if (e.kind === 'permanent' && e.code === 'graph_error' && codes.code !== null) {
    return {
      throw: new ConnectorError('permanent', `instagram_error_${codes.code}_${codes.subcode ?? 0}`),
    };
  }
  return { throw: e };
}
