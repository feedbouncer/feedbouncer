import { isRole, type Role } from '@feedbouncer/authz';

export interface MemberRow {
  user_id: string;
  email: string;
  display_name: string | null;
  role: string;
  created_at: Date;
}

export interface MemberDto {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  joinedAt: string;
}

export const MEMBER_SELECT = `SELECT m.user_id, u.email, u.display_name, m.role, m.created_at
  FROM membership m JOIN app_user u ON u.id = m.user_id`;

export function toMemberDto(r: MemberRow): MemberDto {
  if (!isRole(r.role)) throw new Error('membership has an unknown role');
  return {
    userId: r.user_id,
    email: r.email,
    name: r.display_name,
    role: r.role,
    joinedAt: r.created_at.toISOString(),
  };
}
