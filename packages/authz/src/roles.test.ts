import { describe, expect, it } from 'vitest';
import {
  ROLES,
  can,
  canChangeRole,
  canInviteWithRole,
  canManageInvitation,
  canRemoveMember,
  type Capability,
  type Role,
} from './roles.js';

const MATRIX: Record<Capability, Record<Role, boolean>> = {
  'org.read': { owner: true, admin: true, member: true },
  'brand.read': { owner: true, admin: true, member: true },
  'member.read': { owner: true, admin: true, member: true },
  'brand.write': { owner: true, admin: true, member: false },
  'member.invite': { owner: true, admin: true, member: false },
  'member.remove': { owner: true, admin: true, member: false },
  'member.change_role': { owner: true, admin: true, member: false },
  'invitation.read': { owner: true, admin: true, member: false },
  'connection.manage': { owner: true, admin: true, member: false },
  'connection.read': { owner: true, admin: true, member: false },
  'comment.moderate': { owner: true, admin: true, member: true },
  'comment.read': { owner: true, admin: true, member: true },
  'rule.read': { owner: true, admin: true, member: true },
  'rule.write': { owner: true, admin: true, member: false },
  'comment.reply': { owner: true, admin: true, member: false },
  'comment.triage': { owner: true, admin: true, member: true },
  'tag.manage': { owner: true, admin: true, member: false },
  'org.update': { owner: true, admin: true, member: false },
  'org.transfer_ownership': { owner: true, admin: false, member: false },
  'org.delete': { owner: true, admin: false, member: false },
};

describe('capability matrix (brief "Roles" table)', () => {
  for (const [cap, row] of Object.entries(MATRIX))
    for (const role of ROLES)
      it(`${role} ${row[role] ? 'can' : 'cannot'} ${cap}`, () =>
        expect(can(role, cap as Capability)).toBe(row[role]));
});

describe('canChangeRole', () => {
  const ok = { ok: true };
  it.each([
    ['owner', 'member', 'admin', ok],
    ['owner', 'admin', 'owner', ok],
    ['owner', 'owner', 'member', ok], // last-owner is checked by the service, not here
    ['admin', 'member', 'admin', ok],
    ['admin', 'admin', 'member', ok],
    ['admin', 'member', 'owner', { ok: false, reason: 'cannot_grant_owner' }],
    ['admin', 'owner', 'admin', { ok: false, reason: 'cannot_act_on_owner' }],
    ['member', 'member', 'admin', { ok: false, reason: 'forbidden' }],
    ['member', 'admin', 'member', { ok: false, reason: 'forbidden' }],
  ] as const)('%s changing %s -> %s', (actor, target, next, expected) =>
    expect(canChangeRole(actor, target, next)).toEqual(expected),
  );
});

describe('canRemoveMember', () => {
  it('anyone may remove themselves (leave)', () => {
    for (const r of ROLES) expect(canRemoveMember(r, r, true)).toEqual({ ok: true });
  });
  it('owner removes anyone', () => {
    for (const r of ROLES) expect(canRemoveMember('owner', r, false)).toEqual({ ok: true });
  });
  it('admin removes members and admins but never owners', () => {
    expect(canRemoveMember('admin', 'member', false)).toEqual({ ok: true });
    expect(canRemoveMember('admin', 'admin', false)).toEqual({ ok: true });
    expect(canRemoveMember('admin', 'owner', false)).toEqual({
      ok: false,
      reason: 'cannot_act_on_owner',
    });
  });
  it('member removes nobody else', () => {
    expect(canRemoveMember('member', 'member', false)).toEqual({ ok: false, reason: 'forbidden' });
  });
});

describe('invitations', () => {
  it('owner may invite any role; admin never invites owners; member invites nobody', () => {
    for (const r of ROLES) expect(canInviteWithRole('owner', r)).toEqual({ ok: true });
    expect(canInviteWithRole('admin', 'admin')).toEqual({ ok: true });
    expect(canInviteWithRole('admin', 'owner')).toEqual({
      ok: false,
      reason: 'cannot_grant_owner',
    });
    expect(canInviteWithRole('member', 'member')).toEqual({ ok: false, reason: 'forbidden' });
  });
  it('admin cannot revoke or renew an owner-role invitation', () => {
    expect(canManageInvitation('admin', 'owner')).toEqual({
      ok: false,
      reason: 'cannot_act_on_owner',
    });
    expect(canManageInvitation('admin', 'member')).toEqual({ ok: true });
  });
});

describe('connection.manage', () => {
  it('connection.manage is for owners and admins', () => {
    expect(can('owner', 'connection.manage')).toBe(true);
    expect(can('admin', 'connection.manage')).toBe(true);
    expect(can('member', 'connection.manage')).toBe(false);
  });
});

describe('grantable capabilities', () => {
  it('a member with a grant can reply; the grant is ignored for admins', () => {
    expect(can('member', 'comment.reply', ['comment.reply'])).toBe(true);
    expect(can('admin', 'comment.reply', [])).toBe(true);
    expect(can('member', 'comment.reply', [])).toBe(false);
  });
  it('a granted list cannot elevate a non-grantable capability', () => {
    expect(can('member', 'rule.write', ['rule.write'])).toBe(false);
    expect(can('member', 'tag.manage', ['tag.manage'])).toBe(false);
    expect(can('member', 'comment.reply', ['rule.write'])).toBe(false);
  });
});
