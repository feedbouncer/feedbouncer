import { statusRule } from './status.js';

export const USER_STATUSES = ['active', 'suspended'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

const rule = statusRule(USER_STATUSES);
export const isUserStatus = rule.is;
export const userStatusOf = rule.of;
export const isUserActive = rule.isActive;
