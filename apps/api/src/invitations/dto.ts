import { isRole, type Role } from '@feedbouncer/authz';

export interface InvitationRow {
  id: string;
  email: string;
  role: string;
  expires_at: Date;
  created_at: Date;
}

export interface InvitationDto {
  id: string;
  email: string;
  role: Role;
  status: 'pending';
  expiresAt: string;
  expired: boolean;
  createdAt: string;
}

export const INVITATION_COLUMNS = 'id, email, role, expires_at, created_at';

export function toInvitationDto(r: InvitationRow): InvitationDto {
  if (!isRole(r.role)) throw new Error('invitation has an unknown role');
  return {
    id: r.id,
    email: r.email,
    role: r.role,
    status: 'pending',
    expiresAt: r.expires_at.toISOString(),
    expired: r.expires_at.getTime() <= Date.now(),
    createdAt: r.created_at.toISOString(),
  };
}
