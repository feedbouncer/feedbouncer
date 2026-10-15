import type { LinkDomainConditions } from '../conditions.js';
import { isUnder, SHORTENER_DOMAINS } from '../domains.js';
import type { BrandContext, Evidence } from '../types.js';
import type { Matcher } from './types.js';

export function compileLinkRule(c: LinkDomainConditions, ctx: BrandContext): Matcher {
  const exempt = c.exemptOwnDomains ? ctx.ownDomains : [];
  const known = [...ctx.ownDomains, ...c.domains];
  const under = (host: string, list: readonly string[]) => list.some((d) => isUnder(host, d));
  const allowlist = c.mode === 'allowlist';

  return (v) => {
    const links = v.links;
    if (links.length === 0) return null;
    const isOwn = (host: string) => under(host, exempt);
    // The extractor over-emits hosts, so "some host is own" proves nothing. Own domains
    // exempt the whole comment only when EVERY extracted host is own or allowlisted, and
    // never when extraction was cut short (unexamined hosts could be anything).
    if (
      !v.linksTruncated &&
      links.every((l) => isOwn(l.host) || (allowlist && under(l.host, c.domains)))
    )
      return null;

    for (const l of links) {
      // In allowlist mode an own host is simply an allowed host. In blocklist mode it is
      // evaluated like any other (the whole-comment exemption was refused above).
      if (allowlist && isOwn(l.host)) continue;
      const lookalike = l.mixedScript || (l.skeleton !== l.host && under(l.skeleton, known));
      if (c.lookalikes === 'match' && lookalike)
        return { kind: 'link', host: l.host, reason: 'lookalike' };
      const shortener = under(l.host, SHORTENER_DOMAINS);
      if (!allowlist) {
        if (under(l.host, c.domains)) return { kind: 'link', host: l.host, reason: 'blocklisted' };
        if (shortener && c.shorteners === 'match')
          return { kind: 'link', host: l.host, reason: 'shortener' };
      } else if (!under(l.host, c.domains)) {
        if (shortener && c.shorteners === 'ignore') continue;
        return { kind: 'link', host: l.host, reason: shortener ? 'shortener' : 'not_allowlisted' };
      }
    }

    if (v.linksTruncated) {
      // Fail closed: later links were never examined. Report the first host that would not
      // have been waved through, else the first host seen.
      const first =
        links.find((l) => !(isOwn(l.host) || (allowlist && under(l.host, c.domains)))) ?? links[0]!;
      const evidence: Evidence = {
        kind: 'link',
        host: first.host,
        reason: allowlist ? 'not_allowlisted' : 'blocklisted',
      };
      return evidence;
    }
    return null;
  };
}
