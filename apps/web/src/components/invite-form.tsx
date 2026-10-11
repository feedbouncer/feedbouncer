'use client';
import { ApiForm } from './api-form';
import type { Role } from '../lib/server-api';

function inviteMessage(body: unknown): string {
  const b = (body ?? {}) as { status?: string; emailSent?: boolean };
  if (b.status === 'already_member') return 'This person is already a member.';
  if (b.emailSent === false)
    return 'Invitation saved, but the email was rate limited; try again later.';
  return 'Invitation sent.';
}

export function InviteForm(props: { action: `/api/${string}`; roles: readonly Role[] }) {
  return (
    <ApiForm
      action={props.action}
      fields={[
        { name: 'email', label: 'Email', type: 'email', autoComplete: 'off' },
        { name: 'role', label: 'Role', type: 'select', options: props.roles },
      ]}
      submitLabel="Invite"
      successMessage={inviteMessage}
      refresh
    />
  );
}
