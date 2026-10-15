import { domainToUnicode } from 'node:url';
import type { RuleAction, RuleKind, RuleMode } from '@feedbouncer/rules';

export interface RuleDto {
  id: string;
  name: string;
  kind: RuleKind | null;
  conditions: unknown;
  action: RuleAction;
  mode: RuleMode;
  enabled: boolean;
  /** 1-based place in evaluation order. */
  position: number;
  createdAt: string;
  updatedAt: string;
  warnings: {
    shadowedBy: { id: string; name: string } | null;
    neverMatches: boolean;
    invalid: boolean;
  };
}

export interface DomainDto {
  id: string;
  /** ASCII (punycode) form, as matched. */
  domain: string;
  displayDomain: string;
  createdAt: string;
}

export const toDomainDto = (d: { id: string; domain: string; createdAt: Date }): DomainDto => ({
  id: d.id,
  domain: d.domain,
  displayDomain: domainToUnicode(d.domain) || d.domain,
  createdAt: d.createdAt.toISOString(),
});
