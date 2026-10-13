import { codePointLength } from './moderation';

/** Bodies longer than this many code points start collapsed. */
export const COLLAPSE_AT = 600;

export const needsCollapse = (body: string): boolean => codePointLength(body) > COLLAPSE_AT;
