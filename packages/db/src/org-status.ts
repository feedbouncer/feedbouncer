import { statusRule } from './status.js';

export const ORG_STATUSES = ['active', 'suspended'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

const rule = statusRule(ORG_STATUSES);
export const isOrgStatus = rule.is;
export const orgStatusOf = rule.of;
export const isOrgActive = rule.isActive;
