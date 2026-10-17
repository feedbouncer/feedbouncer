export const ROLES = ['owner', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];
export const isRole = (v: unknown): v is Role =>
  typeof v === 'string' && (ROLES as readonly string[]).includes(v);

export type Capability =
  | 'org.read'
  | 'org.update'
  | 'org.delete'
  | 'org.transfer_ownership'
  | 'brand.read'
  | 'brand.write'
  | 'member.read'
  | 'member.invite'
  | 'member.remove'
  | 'member.change_role'
  | 'invitation.read'
  | 'connection.read'
  | 'connection.manage'
  | 'comment.read'
  | 'comment.moderate'
  | 'rule.read'
  | 'rule.write'
  | 'comment.reply'
  | 'comment.triage'
  | 'tag.manage';

const ALL: readonly Role[] = ROLES;
const MANAGERS: readonly Role[] = ['owner', 'admin'];
const OWNERS: readonly Role[] = ['owner'];

const GRANTS: Readonly<Record<Capability, readonly Role[]>> = {
  'org.read': ALL,
  'brand.read': ALL,
  'member.read': ALL,
  'org.update': MANAGERS,
  'brand.write': MANAGERS,
  'member.invite': MANAGERS,
  'member.remove': MANAGERS,
  'member.change_role': MANAGERS,
  'invitation.read': MANAGERS,
  'connection.read': MANAGERS,
  'connection.manage': MANAGERS,
  'comment.read': ALL,
  'comment.moderate': ALL,
  'rule.read': ALL,
  'rule.write': MANAGERS,
  'comment.reply': MANAGERS,
  'comment.triage': ALL,
  'tag.manage': MANAGERS,
  'org.transfer_ownership': OWNERS,
  'org.delete': OWNERS,
};

/** Capabilities an organization may additionally grant to a role. */
export const GRANTABLE: Readonly<Partial<Record<Capability, readonly Role[]>>> = {
  'comment.reply': ['member'],
};

export function isGrantable(role: Role, cap: Capability): boolean {
  return GRANTABLE[cap]?.includes(role) ?? false;
}

/** `granted`: capabilities this organization granted to `role` (role_grant). Ignored unless GRANTABLE allows it. */
export function can(role: Role, cap: Capability, granted: readonly Capability[] = []): boolean {
  return GRANTS[cap].includes(role) || (granted.includes(cap) && isGrantable(role, cap));
}

export const isCapability = (v: unknown): v is Capability =>
  typeof v === 'string' && Object.hasOwn(GRANTS, v);

export type Denial = 'forbidden' | 'cannot_act_on_owner' | 'cannot_grant_owner';
export type Decision = { ok: true } | { ok: false; reason: Denial };
const OK: Decision = { ok: true };
const deny = (reason: Denial): Decision => ({ ok: false, reason });

export function canChangeRole(actor: Role, target: Role, next: Role): Decision {
  if (!can(actor, 'member.change_role')) return deny('forbidden');
  if (actor === 'owner') return OK;
  if (target === 'owner') return deny('cannot_act_on_owner');
  if (next === 'owner') return deny('cannot_grant_owner');
  return OK;
}

export function canRemoveMember(actor: Role, target: Role, isSelf: boolean): Decision {
  if (isSelf) return OK;
  if (!can(actor, 'member.remove')) return deny('forbidden');
  if (actor !== 'owner' && target === 'owner') return deny('cannot_act_on_owner');
  return OK;
}

export function canInviteWithRole(actor: Role, role: Role): Decision {
  if (!can(actor, 'member.invite')) return deny('forbidden');
  if (actor !== 'owner' && role === 'owner') return deny('cannot_grant_owner');
  return OK;
}

export function canManageInvitation(actor: Role, invitationRole: Role): Decision {
  if (!can(actor, 'member.invite')) return deny('forbidden');
  if (actor !== 'owner' && invitationRole === 'owner') return deny('cannot_act_on_owner');
  return OK;
}
