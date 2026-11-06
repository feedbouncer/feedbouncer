export const ORG_STATUSES = ['active', 'suspended'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

export const isOrgStatus = (v: unknown): v is OrgStatus =>
  (ORG_STATUSES as readonly unknown[]).includes(v);

export function orgStatusOf(raw: unknown): { status: OrgStatus; recognized: boolean } {
  return isOrgStatus(raw)
    ? { status: raw, recognized: true }
    : { status: 'suspended', recognized: false };
}

export const isOrgActive = (raw: unknown): boolean => orgStatusOf(raw).status === 'active';
