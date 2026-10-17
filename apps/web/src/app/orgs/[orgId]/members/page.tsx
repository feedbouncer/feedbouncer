import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiForm } from '../../../../components/api-form';
import { InviteForm } from '../../../../components/invite-form';
import { ReplyGrantToggle } from '../../../../components/reply-grant-toggle';
import { isUuid } from '../../../../lib/ids';
import { dataOrThrow, requireMe, serverGet, type Role } from '../../../../lib/server-api';

interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
}
interface Invitation {
  id: string;
  email: string;
  role: Role;
  expired: boolean;
}

const ROLES: readonly Role[] = ['owner', 'admin', 'member'];

export default async function MembersPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  if (!isUuid(orgId)) notFound();
  const me = await requireMe(`/orgs/${orgId}/members`);
  const org = await serverGet<{ role: Role }>(`/api/v1/orgs/${orgId}`);
  const members = await serverGet<{ members: Member[] }>(`/api/v1/orgs/${orgId}/members`);
  const orgData = dataOrThrow(org, 'organization');
  const memberData = dataOrThrow(members, 'members');
  const viewer = orgData.role;
  const manager = viewer !== 'member';
  const grantable = viewer === 'owner' ? ROLES : ROLES.filter((r) => r !== 'owner');
  const invitationList = manager
    ? dataOrThrow(
        await serverGet<{ invitations: Invitation[] }>(`/api/v1/orgs/${orgId}/invitations`),
        'invitations',
      ).invitations
    : [];
  const grants = dataOrThrow(
    await serverGet<{ grants: { role: Role; capability: string }[] }>(
      `/api/v1/orgs/${orgId}/role-grants`,
    ),
    'role grants',
  ).grants;
  const membersReply = grants.some((g) => g.role === 'member' && g.capability === 'comment.reply');
  const candidates = memberData.members
    .filter((m) => m.userId !== me.user.id)
    .map((m) => ({ value: m.userId, label: m.email }));
  const base = `/api/v1/orgs/${orgId}` as const;
  return (
    <main>
      <h1>Members</h1>
      <ul>
        {memberData.members.map((m) => {
          const editable = manager && (viewer === 'owner' || m.role !== 'owner');
          return (
            <li key={m.userId}>
              <span>
                {m.email}
                {m.name ? ` (${m.name})` : ''} - {m.role}
              </span>
              {editable ? (
                <>
                  <ApiForm
                    action={`${base}/members/${m.userId}`}
                    method="PATCH"
                    fields={[
                      {
                        name: 'role',
                        label: 'Role',
                        type: 'select',
                        options: grantable,
                        defaultValue: m.role,
                      },
                    ]}
                    submitLabel="Change role"
                    refresh
                  />
                  <ApiForm
                    action={`${base}/members/${m.userId}`}
                    method="DELETE"
                    fields={[]}
                    submitLabel="Remove"
                    refresh
                  />
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
      <h2>Permissions</h2>
      <ReplyGrantToggle orgId={orgId} granted={membersReply} canChange={manager} />
      <h2>Leave organization</h2>
      <ApiForm
        action={`${base}/members/${me.user.id}`}
        method="DELETE"
        fields={[]}
        submitLabel="Leave organization"
        redirectTo="/orgs"
      />
      {viewer === 'owner' && candidates.length > 0 ? (
        <>
          <h2>Transfer ownership</h2>
          <ApiForm
            action={`${base}/transfer-ownership`}
            fields={[
              {
                name: 'userId',
                label: 'New owner',
                type: 'select',
                options: candidates,
              },
              {
                name: 'newRoleForSelf',
                label: 'Your role afterwards',
                type: 'select',
                options: ['admin', 'member'],
              },
            ]}
            submitLabel="Transfer ownership"
            refresh
          />
        </>
      ) : null}
      {manager ? (
        <>
          <h2>Invitations</h2>
          <ul>
            {invitationList.map((i) => (
              <li key={i.id}>
                <span>
                  {i.email} - {i.role}
                  {i.expired ? ' (expired)' : ''}
                </span>
                <ApiForm
                  action={`${base}/invitations/${i.id}/revoke`}
                  fields={[]}
                  submitLabel="Revoke"
                  refresh
                />
              </li>
            ))}
          </ul>
          <InviteForm action={`${base}/invitations`} roles={grantable} />
        </>
      ) : null}
      <p>
        <Link href={`/orgs/${orgId}`}>Back to organization</Link>
      </p>
    </main>
  );
}
