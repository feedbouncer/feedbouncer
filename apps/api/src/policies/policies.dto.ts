import type {
  PolicyAction,
  PolicyWarning,
  StoredPolicy,
  StoredRevision,
} from '@feedbouncer/policies';
import { policyWarnings } from '@feedbouncer/policies';

export interface PolicyDto {
  id: string;
  name: string;
  enabled: boolean;
  text: string;
  action: PolicyAction;
  revision: number;
  revisionId: string;
  warnings: PolicyWarning[];
  createdAt: string;
  updatedAt: string;
}

export interface PolicyDetailDto extends PolicyDto {
  revisions: {
    id: string;
    revision: number;
    text: string;
    action: PolicyAction;
    createdAt: string;
    createdBy: { id: string; name: string | null } | null;
  }[];
}

export interface PolicyListDto {
  policies: PolicyDto[];
  limits: { maxPolicies: number; maxEnabled: number };
  usage: { used: number; limit: number; resetsAt: string };
  evaluatorConfigured: boolean;
}

export const toPolicyDto = (p: StoredPolicy): PolicyDto => ({
  id: p.id,
  name: p.name,
  enabled: p.enabled,
  text: p.text,
  action: p.action,
  revision: p.revision,
  revisionId: p.revisionId,
  warnings: policyWarnings(p.text),
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

export const toRevisionDto = (
  r: StoredRevision,
  names: ReadonlyMap<string, string | null>,
): PolicyDetailDto['revisions'][number] => ({
  id: r.id,
  revision: r.revision,
  text: r.text,
  action: r.action,
  createdAt: r.createdAt.toISOString(),
  createdBy:
    r.createdByUserId === null
      ? null
      : { id: r.createdByUserId, name: names.get(r.createdByUserId) ?? null },
});
